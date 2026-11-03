import type { ScreenText } from "../ghosthand.js";
import {
  ANYWHERE,
  chain,
  maybeLocked,
  type Anywhere,
  type Chain,
  type MaybeLocked,
  type Screen,
  type Step,
} from "../flow.js";
import {
  center,
  lastLine,
  NavigationError,
  normalize,
  waitForLine,
} from "../navigation.js";
import { classifyLock, ensureUnlocked } from "../unlock.js";

/** The apps neo opens. Spotlight is searched for the display name. */
export const APP_NAMES = {
  whatsapp: "WhatsApp",
  cred: "CRED",
  rapido: "Rapido",
} as const;
export type AppId = keyof typeof APP_NAMES;
export const APPS = Object.keys(APP_NAMES) as [AppId, ...AppId[]];

// The "Q Search" pill above the Dock; Spotlight keeps showing it below short results.
const SEARCH_PILL = (text: string) => text === "search" || text === "q search";
// Spotlight's field sits at the top left: "Search or Ask", the typed text, "Safari — Open".
const spotlightField = (screen: ScreenText) =>
  screen.lines.find(
    (line) => line.y >= 35 && line.y <= 85 && line.x >= 30 && line.x <= 90,
  );
const inSpotlightField = (screen: ScreenText) =>
  spotlightField(screen) !== undefined;
// iOS reopens Spotlight with the last query for a while; its results then cover the pill.
const spotlightMark = (screen: ScreenText) => {
  const field = normalize(spotlightField(screen)?.text ?? "");
  return (
    field.startsWith("search or ask") ||
    / [-—–] open$/.test(field) ||
    screen.lines.some((line) =>
      normalize(line.text).startsWith("search in app"),
    )
  );
};
const searchPill = lastLine(SEARCH_PILL);
const pillShows = (screen: ScreenText) => {
  const pill = searchPill(screen);
  return pill !== undefined && pill.y > screen.height * 0.6;
};

export const HOME: Screen<"home"> = {
  name: "home",
  description: "the Home Screen",
  shows: (screen) => pillShows(screen) && !inSpotlightField(screen),
};

export const SPOTLIGHT: Screen<"spotlight"> = {
  name: "spotlight",
  description: "Spotlight, opened from the Home Screen's Search button",
  shows: (screen) =>
    inSpotlightField(screen) && (pillShows(screen) || spotlightMark(screen)),
};

/** `app` in front and unlocked. OCR cannot tell apps apart in general; app steps narrow this. */
export function appOpen<A extends AppId>(app: A): Screen<`${A}.open`> {
  const name = APP_NAMES[app];
  return {
    name: `${app}.open`,
    description: `${name}, unlocked`,
    shows: (screen) =>
      screen.lines.length >= MIN_APP_LINES &&
      !HOME.shows(screen) &&
      !SPOTLIGHT.shows(screen) &&
      classifyLock(screen, name).kind === "open",
  };
}
// A launching app shows a blank or nearly blank screen for a moment.
const MIN_APP_LINES = 3;

// Longer than iOS's double-press window: two quick Home presses open the App Switcher.
const HOME_SETTLE_MS = 1_200;
const HOME_PRESSES = 3;

/**
 * Base setup for every action: from whatever is showing (an app, Spotlight, the App
 * Switcher, another Home Screen page) back to the Home Screen.
 */
export const reset: Step<Anywhere, "home"> = {
  name: "phone.reset",
  from: ANYWHERE,
  to: HOME,
  act: async ({ phone }) => {
    for (let press = 1; press <= HOME_PRESSES; press += 1) {
      await phone.key("home");
      await phone.pause(HOME_SETTLE_MS);
      if (HOME.shows(await phone.readText())) return;
    }
    throw new NavigationError(
      `The Home Screen did not show after ${HOME_PRESSES} Home presses. Is the iPhone locked, or showing a system alert?`,
    );
  },
};

// Spotlight animates in; keys sent earlier are lost.
const UI_SETTLE_MS = 600;

/** iOS 27: the Spotlight that cmd+Space opens ignores Enter and taps; this one accepts taps. */
export const openSpotlight: Step<"home", "spotlight"> = {
  name: "spotlight.open",
  from: HOME,
  to: SPOTLIGHT,
  act: async ({ phone }) => {
    const pill = searchPill(await phone.readText());
    if (pill === undefined) throw new NavigationError("No Search button.");
    await phone.tap(center(pill));
    await phone.pause(UI_SETTLE_MS);
  },
};

// Only the top hit's icon opens the app; its label below does not respond to taps.
const ICON_ABOVE_LABEL_PT = 38;
const APP_LAUNCH_MS = 1_500;
// Tapping the top hit again is harmless: it can only open the same app.
const LAUNCH_TAPS = 2;
const RESULTS_WAIT = { attempts: 10, intervalMs: 500 };

/** Types the app's name into Spotlight and taps its top hit. */
export function launchFromSpotlight<A extends AppId>(
  app: A,
): Step<"spotlight", MaybeLocked<`${A}.open`>> {
  const name = APP_NAMES[app];
  const target = normalize(name);
  return {
    name: `spotlight.launch(${app})`,
    from: SPOTLIGHT,
    to: maybeLocked(appOpen(app), name),
    act: async ({ phone }) => {
      // Replaces a query left from earlier rather than appending to it.
      await phone.key("cmd+a");
      await phone.type(name);
      // The suggestions grid shows first; "<App> — Open" in the field means the results are in.
      const completion = (text: string) =>
        text.startsWith(target) && text.includes("open");
      await waitForLine(
        phone,
        (screen) =>
          screen.lines.find(
            (line) => line.y < 100 && completion(normalize(line.text)),
          ),
        `Spotlight's results for ${name}`,
        RESULTS_WAIT,
      );
      for (let tap = 1; tap <= LAUNCH_TAPS; tap += 1) {
        const screen = await phone.readText();
        const label = screen.lines.find(
          (line) => line.y > 100 && normalize(line.text) === target,
        );
        if (label === undefined)
          throw new NavigationError(`${name} is not Spotlight's top hit.`);
        const icon = center(label);
        await phone.tap({ x: icon.x, y: icon.y - ICON_ABOVE_LABEL_PT });
        await phone.pause(APP_LAUNCH_MS);
        if (!SPOTLIGHT.shows(await phone.readText())) return;
      }
    },
  };
}

/** Gets past the app's Face ID lock if it shows: Face ID, then the Keychain passcode once. */
export function unlock<A extends AppId, S extends string>(
  app: A,
  screen: Screen<S>,
): Step<MaybeLocked<S>, S> {
  const name = APP_NAMES[app];
  return {
    name: `${app}.unlock`,
    from: maybeLocked(screen, name),
    to: screen,
    act: async ({ phone, judge, passcode }) => {
      await ensureUnlocked(phone, judge, name, passcode);
    },
  };
}

/** Base setup, Spotlight, launch, unlock: `app` in front and unlocked, from any screen. */
export function openApp<A extends AppId>(app: A): Chain<Anywhere, `${A}.open`> {
  return chain(reset)
    .then(openSpotlight)
    .then(launchFromSpotlight(app))
    .then(unlock(app, appOpen(app)));
}
