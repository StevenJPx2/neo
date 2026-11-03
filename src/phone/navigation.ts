import type { ScreenLine, ScreenText } from "./ghosthand.js";
import type { Phone } from "./phone.js";

export class NavigationError extends Error {
  override readonly name: string = "NavigationError";
}

export type WaitLimits = { attempts: number; intervalMs: number };
export type LinePicker = (screen: ScreenText) => ScreenLine | undefined;

export const DEFAULT_WAIT: WaitLimits = { attempts: 12, intervalMs: 500 };

export function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function center(line: ScreenLine): { x: number; y: number } {
  return {
    x: Math.round(line.x + line.width / 2),
    y: Math.round(line.y + line.height / 2),
  };
}

export function firstLine(matches: (text: string) => boolean): LinePicker {
  return (screen) => screen.lines.find((line) => matches(normalize(line.text)));
}

/** The lowest matching line, e.g. a bottom tab or a bottom address bar. */
export function lastLine(matches: (text: string) => boolean): LinePicker {
  return (screen) =>
    screen.lines
      .filter((line) => matches(normalize(line.text)))
      .sort((a, b) => b.y - a.y)[0];
}

/** Polls the screen until `pick` returns a value, at most `limits.attempts` times. */
export async function waitFor<T>(
  phone: Phone,
  pick: (screen: ScreenText) => T | undefined,
  description: string,
  limits: WaitLimits = DEFAULT_WAIT,
): Promise<T> {
  for (let attempt = 1; attempt <= limits.attempts; attempt += 1) {
    const found = pick(await phone.readText());
    if (found !== undefined) return found;
    if (attempt < limits.attempts) await phone.pause(limits.intervalMs);
  }
  throw new NavigationError(`Timed out waiting for ${description}.`);
}

export function waitForLine(
  phone: Phone,
  pick: LinePicker,
  description: string,
  limits: WaitLimits = DEFAULT_WAIT,
): Promise<ScreenLine> {
  return waitFor(phone, pick, description, limits);
}
