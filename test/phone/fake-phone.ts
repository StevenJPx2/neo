import type {
  Point,
  ScreenText,
  ScrollDirection,
  TapTarget,
} from "../../src/phone/ghosthand.js";
import type { Phone } from "../../src/phone/phone.js";

/** A line as OCR reports it on a 402x874 pt iPhone 17: text, top-left corner, height if not text-sized. */
export type FakeLine = readonly [
  text: string,
  x: number,
  y: number,
  height?: number,
];
export type Transition = (state: string, input: string) => string | undefined;

const CHAR_WIDTH_PT = 8;
const LINE_HEIGHT_PT = 16;

/**
 * An iPhone that moves between named screens on input. Every input is recorded as
 * `tap:<line text>` (or `tap:x,y` off any line), `key:…`, `type:…`, `scroll:…`.
 * Waits return at once.
 */
export class FakePhone implements Phone {
  readonly inputs: string[] = [];

  constructor(
    public state: string,
    private readonly screens: Record<string, readonly FakeLine[]>,
    private readonly transition: Transition,
  ) {}

  private lines() {
    const lines = this.screens[this.state];
    if (lines === undefined) throw new Error(`No fake screen "${this.state}"`);
    return lines.map(([text, x, y, height = LINE_HEIGHT_PT]) => ({
      text,
      x,
      y,
      width: Math.max(text.length * CHAR_WIDTH_PT, height),
      height,
      confidence: 1,
    }));
  }

  async readText(): Promise<ScreenText> {
    return { width: 402, height: 874, lines: this.lines() };
  }

  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  }

  async tap(target: TapTarget): Promise<void> {
    if (!("x" in target)) return this.input(`tap:${target.text}`);
    const line = this.lines().find(
      (candidate) =>
        target.x >= candidate.x &&
        target.x <= candidate.x + candidate.width &&
        target.y >= candidate.y &&
        target.y <= candidate.y + candidate.height,
    );
    this.input(`tap:${line?.text ?? `${target.x},${target.y}`}`);
  }

  async key(combo: string): Promise<void> {
    this.input(`key:${combo}`);
  }

  async type(text: string): Promise<void> {
    this.input(`type:${text}`);
  }

  async scroll(
    direction: ScrollDirection,
    _ticks: number,
    _at: Point,
  ): Promise<void> {
    this.input(`scroll:${direction}`);
  }

  async pause(): Promise<void> {}

  private input(input: string): void {
    this.inputs.push(input);
    this.state = this.transition(this.state, input) ?? this.state;
  }
}

// ---------------------------------------------------------------- iOS 27.2, as read on the device

export const SYSTEM_SCREENS: Record<string, readonly FakeLine[]> = {
  home: [
    ["09:41", 37, 25],
    ["TUESDAY", 43, 109],
    ["Rapido", 226, 260],
    ["CRED", 322, 262],
    ["Q Search", 172, 712],
  ],
  spotlight: [
    ["Search or Ask", 49, 51],
    ["WhatsApp", 128, 227],
    ["Safari", 56, 332],
    ["Q Search", 172, 712],
  ],
  locked: [
    ["09:41", 37, 25],
    ["Tuesday 3 November", 120, 90],
    ["Swipe up to open", 140, 830],
  ],
};

/** Spotlight after typing `app`: "<App> — Open" in the field, the top hit's label under its icon. */
export function spotlightResults(app: string): readonly FakeLine[] {
  return [
    [`${app} - Open`, 50, 55],
    [app, 56, 226],
    ["Settings", 37, 264],
    ["Q Search", 172, 712],
  ];
}

/**
 * Home from anywhere, Search → Spotlight, typing → results, a tap off any line (the top
 * hit's icon) → the screen named after the app.
 */
export const systemTransition: Transition = (state, input) => {
  if (input === "key:home") return "home";
  if (state === "home" && input === "tap:Q Search") return "spotlight";
  if (state === "spotlight" && input.startsWith("type:"))
    return `spotlight:${input.slice("type:".length)}`;
  if (state.startsWith("spotlight:") && /^tap:\d+,\d+$/.test(input))
    return state.slice("spotlight:".length);
  return undefined;
};

export function screensWith(
  extra: Record<string, readonly FakeLine[]>,
): Record<string, readonly FakeLine[]> {
  const screens: Record<string, readonly FakeLine[]> = {
    ...SYSTEM_SCREENS,
    ...extra,
  };
  for (const app of ["WhatsApp", "Safari", "Rapido", "CRED", "Google Pay"])
    screens[`spotlight:${app}`] = spotlightResults(app);
  return screens;
}
