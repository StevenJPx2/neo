import { describe, expect, it } from "vitest";
import type { ScreenText, TapTarget } from "../../src/phone/ghosthand.js";
import type { Phone } from "../../src/phone/phone.js";
import {
  AppLockedError,
  classifyLock,
  ensureUnlocked,
} from "../../src/phone/unlock.js";
import type { Judge } from "../../src/phone/verify.js";

// iOS 27 app-lock screens for WhatsApp, as read over USB on an iPhone 17.
const SCREENS = {
  locked: ["09:41", "WhatsApp Locked", "Unlock WhatsApp"],
  faceIdFailed: [
    "Face Not Recognized",
    "Try Again",
    "Try Face ID Again",
    "Cancel",
  ],
  passcodeOffered: [
    "Face Not Recognized",
    "Enter iPhone Passcode",
    "Enter Passcode",
    "Cancel",
  ],
  prompt: ["Enter iPhone Passcode for", '"WhatsApp"', "Unlock WhatsApp"],
  open: ["Chats", "Ask Meta AI or Search"],
} as const;
type State = keyof typeof SCREENS;

// Which label leads where, as observed: Face ID fails twice before iOS offers the passcode.
const TAPS: Partial<Record<string, State>> = {
  "Unlock WhatsApp": "faceIdFailed",
  "Try Face ID Again": "passcodeOffered",
  "Enter Passcode": "prompt",
};

class LockedPhone implements Phone {
  readonly taps: string[] = [];
  readonly typed: string[] = [];

  constructor(
    private state: State,
    private readonly correctPasscode = "123456",
  ) {}

  async readText(): Promise<ScreenText> {
    const lines = SCREENS[this.state].map((text, row) => ({
      text,
      x: 20,
      y: 100 + row * 40,
      width: 200,
      height: 20,
      confidence: 1,
    }));
    return { width: 402, height: 874, lines };
  }

  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array([0x89]);
  }

  async tap(target: TapTarget): Promise<void> {
    const label =
      "y" in target
        ? SCREENS[this.state][Math.round((target.y - 110) / 40)]
        : undefined;
    this.taps.push(label ?? "?");
    const next = label === undefined ? undefined : TAPS[label];
    if (next !== undefined) this.state = next;
  }

  lockNow(): void {
    this.state = "locked";
  }

  async key(): Promise<void> {}

  async scroll(): Promise<void> {}

  async pause(): Promise<void> {}

  async type(text: string): Promise<void> {
    this.typed.push(text);
    if (this.state === "prompt" && text === this.correctPasscode)
      this.state = "open";
  }
}

const yes: Judge = async () => 0.97;
const saved = (passcode: string | undefined) => async () => passcode;

describe("ensureUnlocked", { timeout: 30_000 }, () => {
  it("tries Face ID, then types the Keychain passcode once into the confirmed prompt", async () => {
    const phone = new LockedPhone("locked");

    await expect(
      ensureUnlocked(phone, yes, "WhatsApp", saved("123456")),
    ).resolves.toBe("unlocked");
    expect(phone.taps).toEqual([
      "Unlock WhatsApp",
      "Try Face ID Again",
      "Enter Passcode",
    ]);
    expect(phone.typed).toEqual(["123456"]);
  });

  it("waits for a lock that shows only after the app's launch screen", async () => {
    const phone = new LockedPhone("open");
    const reads = phone.readText.bind(phone);
    let read = 0;
    phone.readText = async () => {
      read += 1;
      // CRED: its launch screen first, then iOS's Face ID sheet.
      if (read === 2) phone.lockNow();
      return reads();
    };

    await expect(
      ensureUnlocked(phone, yes, "WhatsApp", saved("123456")),
    ).resolves.toBe("unlocked");
    expect(phone.typed).toEqual(["123456"]);
  });

  it("does nothing when the app is not locked", async () => {
    const phone = new LockedPhone("open");

    await expect(
      ensureUnlocked(phone, yes, "WhatsApp", saved("123456")),
    ).resolves.toBe("not_locked");
    expect([...phone.taps, ...phone.typed]).toEqual([]);
  });

  it("stops without touching the phone when no passcode is saved", async () => {
    const phone = new LockedPhone("locked");

    await expect(
      ensureUnlocked(phone, yes, "WhatsApp", saved(undefined)),
    ).rejects.toThrow(/add-generic-password/);
    expect(phone.taps).toEqual([]);
  });

  it("types a wrong passcode once, never again, and does not echo it", async () => {
    const phone = new LockedPhone("prompt");
    const error = await ensureUnlocked(
      phone,
      yes,
      "WhatsApp",
      saved("999999"),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppLockedError);
    expect(String(error)).toMatch(/typed once/);
    expect(String(error)).not.toContain("999999");
    expect(phone.typed).toEqual(["999999"]);
  });

  it("does not type the passcode when Jev does not confirm the prompt", async () => {
    const phone = new LockedPhone("prompt");
    const unsure: Judge = async () => 0.3;

    await expect(
      ensureUnlocked(phone, unsure, "WhatsApp", saved("123456")),
    ).rejects.toThrow(/not typed/);
    expect(phone.typed).toEqual([]);
  });
});

describe("classifyLock", () => {
  it("reads CRED's own lock screen as locked, with 'unlock now' to tap", () => {
    const line = (text: string, y: number) => ({
      text,
      x: 60,
      y,
      width: 250,
      height: 20,
      confidence: 1,
    });
    const screen = {
      width: 402,
      height: 874,
      lines: [
        line("AUTHENTICATION REQUIRED", 433),
        line("because the only person", 468),
        line("seeing your data should be", 498),
        line("you", 530),
        line("unlock now —", 800),
      ],
    };

    expect(classifyLock(screen, "CRED")).toMatchObject({
      kind: "locked",
      unlock: { text: "unlock now —" },
    });
  });

  it("tells the passcode prompt from the locked screen, though both say Unlock WhatsApp", async () => {
    expect(
      classifyLock(await new LockedPhone("prompt").readText(), "WhatsApp").kind,
    ).toBe("passcode_prompt");
    expect(
      classifyLock(await new LockedPhone("locked").readText(), "WhatsApp").kind,
    ).toBe("locked");
    expect(
      classifyLock(await new LockedPhone("prompt").readText(), "CRED").kind,
    ).toBe("open");
  });
});
