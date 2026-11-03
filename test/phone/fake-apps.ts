import type { ApprovalDecision } from "../../src/phone/approval.js";
import { parseConfig } from "../../src/phone/config.js";
import type { ActionDeps } from "../../src/phone/final.js";
import type { Judge } from "../../src/phone/verify.js";
import {
  FakePhone,
  screensWith,
  systemTransition,
  type FakeLine,
  type Transition,
} from "./fake-phone.js";

// Fake WhatsApp and CRED, laid out as read on the device, for the action and chain tests.

export const config = parseConfig(
  JSON.stringify({
    contacts: { Amma: "+919876543210", WaterGuy: "+919000000001" },
    water: { vendor: "WaterGuy", address: "Flat 4B, KR Garden" },
    payments: { maxAmountInr: 1000 },
  }),
);

export function deps(
  phone: FakePhone,
  options: { yes?: number; decision?: ApprovalDecision } = {},
): ActionDeps & { asked: string[] } {
  const asked: string[] = [];
  const judge: Judge = async () => options.yes ?? 0.95;
  const approve = async (summary: string) => {
    asked.push(summary);
    return options.decision ?? "approved";
  };
  // No passcode saved: none of these screens shows an app lock.
  return {
    phone,
    judge,
    approve,
    config,
    passcode: async () => undefined,
    asked,
  };
}

/** A phone that follows `moves` (state → input → next state), then the system's own moves. */
export function phone(
  start: string,
  screens: Record<string, readonly FakeLine[]>,
  moves: Record<string, Record<string, string>>,
): FakePhone {
  const transition: Transition = (state, input) =>
    moves[state]?.[input] ?? systemTransition(state, input);
  return new FakePhone(start, screensWith(screens), transition);
}

// ---------------------------------------------------------------- WhatsApp (iOS 27.2 layout)

const TAB_BAR: FakeLine[] = [
  ["Updates", 44, 832],
  ["Calls", 115, 832],
  ["Communities", 168, 832],
  ["Chats", 260, 832],
  ["You", 326, 831],
];
const chatScreen = (name: string, draft?: string, back = "<4"): FakeLine[] => [
  ["09:41", 37, 25],
  [back, 20, 68],
  [name, 117, 71],
  ["Good", 28, 148],
  // The last message's footer, just above the message box.
  ["Edited 14:19 /", 280, 767],
  ["+", 5, 798, 38],
  ...(draft === undefined ? [] : [[draft, 57, 809, 20] as const]),
];
const results = (query: string, chat: string): FakeLine[] => [
  ["<", 11, 67],
  [`Q ${query}`, 66, 72],
  ["Chats", 16, 144],
  [chat, 82, 186],
  ["I Hello from Nitro!", 82, 208],
  ["Messages", 16, 389],
];
const SEARCH: FakeLine[] = [
  ["Q Ask Meta Al or Search", 66, 73],
  ["Recent searches", 15, 132],
  ["Media", 16, 319],
];

export const MESSAGE = "Running late, home by 8";
/** WhatsApp, left inside another chat, with `chat` found by searching `query`. */
export function whatsapp(query: string, chat: string, text = MESSAGE) {
  const screens: Record<string, readonly FakeLine[]> = {
    // OCR sometimes drops the "<" of the back button and reads only its unread count.
    WhatsApp: chatScreen("Asha Menon", undefined, "5"),
    list: [
      ["Chats", 15, 127],
      ["All", 28, 185],
      ["Ravi Kumar", 84, 771],
      ...TAB_BAR,
    ],
    listWithSearch: [
      ["Chats", 15, 126],
      ["Q Ask Meta Al or Search", 29, 180],
      ["All", 28, 239],
      ...TAB_BAR,
    ],
    search: SEARCH,
    results: results(query, chat),
    chat: chatScreen(chat),
    draft: chatScreen(chat, text),
  };
  const moves = {
    WhatsApp: { "tap:5": "list" },
    list: { "scroll:up": "listWithSearch" },
    listWithSearch: { "tap:Q Ask Meta Al or Search": "search" },
    search: { [`type:${query}`]: "results" },
    results: { [`tap:${chat}`]: "chat" },
    chat: { [`type:${text}`]: "draft" },
    draft: { "key:enter": "chat" },
  };
  return phone("WhatsApp", screens, moves);
}

// ---------------------------------------------------------------- CRED (screens read in November 2026)

export const PAYEE = "shop@okhdfcbank";
const amountSheet = (amount?: string): FakeLine[] => [
  ["Ravi Stores", 122, 131],
  [PAYEE, 152, 155],
  ["you paid Top", 77, 256],
  ["₹40", 354, 255],
  ["ENTER AMOUNT TO PAY", 128, 695],
  ...(amount === undefined ? [] : [[amount, 176, 733] as const]),
  ["SEND MONEY ^", 163, 814],
];
/** CRED, left on an earlier payee's page; the amount sheet will read `shown` (OCR: ₹ → F). */
export function cred(shown: string, typed = "250") {
  const screens: Record<string, readonly FakeLine[]> = {
    CRED: [
      ["Meera Nair", 122, 131],
      ["meera@okaxis", 152, 155],
      ["ENTER AMOUNT TO PAY", 128, 695],
      ["SEND MONEY ^", 163, 814],
    ],
    credHome: [
      ["unclaimed reward", 158, 101],
      ["FOR YOU", 24, 471],
      ["UPI", 182, 805],
      ["HOME", 39, 824],
      ["CARDS", 111, 824],
      ["REWARDS", 252, 824],
      ["MORE", 336, 824],
    ],
    scanner: [
      ["ASHA", 92, 82],
      ["SCAN ANY QR", 158, 570],
      ["pay to phone number", 73, 751],
    ],
    paySearch: [
      ["send money to any UPI app", 109, 248],
      ["pay to", 168, 315],
      ["SUGGESTIONS", 30, 458],
    ],
    found: [
      ["send money to any UP app", 110, 119],
      [`a ${PAYEE}`, 52, 174],
      ["Ravi Stores", 95, 255],
      ["Pay", 347, 268],
      [`@ ${PAYEE}`, 97, 279],
    ],
    amount: amountSheet(),
    entered: amountSheet(shown),
    pin: [
      ["ENTER UPI PIN", 120, 200],
      ["Ravi Stores", 120, 240],
    ],
  };
  const moves = {
    CRED: { "tap:40,98": "credHome" }, // the back arrow
    credHome: { "tap:UPI": "scanner" },
    scanner: { "tap:pay to phone number": "paySearch" },
    paySearch: { [`type:${PAYEE}`]: "found" },
    found: { "tap:Pay": "amount" },
    amount: { [`type:${typed}`]: "entered" },
    entered: { "tap:SEND MONEY ^": "pin" },
  };
  return phone("CRED", screens, moves);
}
export const payment = { vpa: PAYEE, payeeName: "Ravi Stores", amountInr: 250 };
