import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ScreenLine, ScreenText } from "./ghosthand.js";
import { center, NavigationError, normalize } from "./navigation.js";
import { isTypeable, type Phone } from "./phone.js";
import { JEV_MIN_YES, type Judge } from "./verify.js";

/** The app shows its Face ID lock and neo cannot (or may not) unlock it. */
export class AppLockedError extends NavigationError {
  override readonly name = "AppLockedError";
}

/** Returns the iPhone passcode, or `undefined` when none is saved. */
export type PasscodeSource = () => Promise<string | undefined>;

export const KEYCHAIN_SERVICE = "neo-phone";
export const KEYCHAIN_ACCOUNT = "iphone-passcode";
const SAVE_HINT = `security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w`;
// `security` exits with 44 when the item does not exist.
const KEYCHAIN_ITEM_NOT_FOUND = 44;

const run = promisify(execFile);

/** Reads the passcode from the login Keychain. It is never logged or returned to a caller of a tool. */
export function keychainPasscode(): PasscodeSource {
  return async () => {
    try {
      const args = [
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        KEYCHAIN_ACCOUNT,
        "-w",
      ];
      const { stdout } = await run("security", args, { timeout: 15_000 });
      const passcode = stdout.replace(/\n$/, "");
      return passcode === "" ? undefined : passcode;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === KEYCHAIN_ITEM_NOT_FOUND
      )
        return undefined;
      throw new Error(
        "Could not read the iPhone passcode from the macOS Keychain.",
      );
    }
  };
}

export type LockScreen =
  | { kind: "open" }
  | { kind: "locked"; unlock: ScreenLine }
  | { kind: "face_id_failed"; retry?: ScreenLine; passcode?: ScreenLine }
  | { kind: "passcode_prompt" };

/** Reads which step of iOS's app lock is on screen, from the labels seen on iOS 27. */
export function classifyLock(screen: ScreenText, appName: string): LockScreen {
  const app = normalize(appName);
  const all = normalize(
    screen.lines.map((line) => line.text).join(" "),
  ).replace(/[“”]/g, '"');
  const find = (label: string) =>
    screen.lines.find((line) => normalize(line.text) === label);

  // "Enter iPhone Passcode for "WhatsApp"": checked first, as it also shows "Unlock WhatsApp".
  if (all.includes(`enter iphone passcode for "${app}"`))
    return { kind: "passcode_prompt" };

  const retry = find("try face id again");
  const passcode = find("enter passcode");
  if (
    all.includes("face not recognized") &&
    (retry !== undefined || passcode !== undefined)
  ) {
    return {
      kind: "face_id_failed",
      ...(retry ? { retry } : {}),
      ...(passcode ? { passcode } : {}),
    };
  }

  const unlock = find(`unlock ${app}`);
  if (unlock !== undefined && all.includes(`${app} locked`))
    return { kind: "locked", unlock };

  // CRED's own lock screen: "AUTHENTICATION REQUIRED … unlock now →", before iOS's Face ID.
  const unlockNow = screen.lines.find((line) =>
    normalize(line.text).startsWith("unlock now"),
  );
  if (unlockNow !== undefined && all.includes("authentication required"))
    return { kind: "locked", unlock: unlockNow };
  return { kind: "open" };
}

// A Face ID scan shows no text for a few seconds, and some apps (CRED) ask only after their
// launch screen. "Open" counts once the app's own content has shown on two reads in a row.
const LAUNCH_READS = 6;
const LAUNCH_READ_MS = 1_500;
const CONTENT_LINES = 3;
const SETTLED_READS = 2;

async function settledLockState(
  phone: Phone,
  appName: string,
): Promise<LockScreen> {
  let settled = 0;
  for (let read = 1; ; read += 1) {
    const screen = await phone.readText();
    const state = classifyLock(screen, appName);
    if (state.kind !== "open") return state;
    settled = screen.lines.length >= CONTENT_LINES ? settled + 1 : 0;
    if (settled >= SETTLED_READS || read >= LAUNCH_READS) return state;
    await phone.pause(LAUNCH_READ_MS);
  }
}

const MAX_STEPS = 6;
// Face ID locks itself after 5 failures; two retries keep well clear of that.
const MAX_FACE_ID_RETRIES = 2;
// A Face ID attempt takes about a second; reading sooner sees the previous step.
const STEP_WAIT_MS = 2_000;

/**
 * Gets `appName` past its Face ID app lock: Face ID first, then the iPhone passcode from
 * the Keychain, typed once into the confirmed passcode prompt. Returns at once if not locked.
 */
export async function ensureUnlocked(
  phone: Phone,
  judge: Judge,
  appName: string,
  passcodeSource: PasscodeSource,
): Promise<"not_locked" | "unlocked"> {
  let state = await settledLockState(phone, appName);
  if (state.kind === "open") return "not_locked";

  const passcode = await passcodeSource();
  if (passcode === undefined) {
    throw new AppLockedError(
      `${appName} is locked with Face ID. Unlock it on the iPhone, or save the iPhone passcode for neo: ${SAVE_HINT}`,
    );
  }
  if (passcode.length < 4 || !isTypeable(passcode)) {
    throw new AppLockedError(
      "The passcode saved in the macOS Keychain is not a valid iPhone passcode.",
    );
  }

  let faceIdRetries = 0;
  for (let step = 1; step <= MAX_STEPS; step += 1) {
    if (state.kind === "open") return "unlocked";
    if (state.kind === "passcode_prompt")
      return enterPasscodeOnce(phone, judge, appName, passcode);

    if (state.kind === "locked") {
      await phone.tap(center(state.unlock));
    } else if (state.passcode !== undefined) {
      await phone.tap(center(state.passcode));
    } else if (
      state.retry !== undefined &&
      faceIdRetries < MAX_FACE_ID_RETRIES
    ) {
      faceIdRetries += 1;
      await phone.tap(center(state.retry));
    } else {
      throw new AppLockedError(
        `Face ID failed and iOS offered no passcode option for ${appName}.`,
      );
    }

    await phone.pause(STEP_WAIT_MS);
    state = await settledLockState(phone, appName);
  }
  throw new AppLockedError(
    `Could not get past ${appName}'s lock in ${MAX_STEPS} steps.`,
  );
}

async function enterPasscodeOnce(
  phone: Phone,
  judge: Judge,
  appName: string,
  passcode: string,
): Promise<"unlocked"> {
  // Typing into the wrong field would leak the passcode: Jev must also confirm the prompt.
  const screen = await phone.readText();
  const yes = await judge({
    screenshot: await phone.screenshot(),
    screenText: screen.lines.map((line) => line.text).join("\n"),
    // The keypad is hidden while a hardware keyboard is connected; the title is what shows.
    question:
      `Is this iOS's own system prompt titled 'Enter iPhone Passcode for "${appName}"' ` +
      "(its number keypad may be hidden because a hardware keyboard is connected), " +
      "rather than a text field inside an app?",
  });
  if (yes < JEV_MIN_YES) {
    throw new AppLockedError(
      `Jev did not confirm the passcode prompt (p=${yes.toFixed(2)}); the passcode was not typed.`,
    );
  }

  // A wrong passcode counts toward the iPhone's lockout: type it exactly once, never retry.
  await phone.type(passcode);
  if (!/^(\d{4}|\d{6})$/.test(passcode)) await phone.key("enter");

  for (let check = 1; check <= 3; check += 1) {
    await phone.pause(STEP_WAIT_MS);
    if (classifyLock(await phone.readText(), appName).kind === "open")
      return "unlocked";
  }
  throw new AppLockedError(
    `The passcode was typed once, but ${appName} is still locked. Not retrying: wrong passcodes count toward the iPhone's lockout.`,
  );
}
