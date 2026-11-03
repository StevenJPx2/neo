import { describe, expect, it } from "vitest";
import {
  orderWater,
  sendMoney,
  sendWhatsappText,
} from "../../src/phone/actions.js";
import type { ApprovalDecision } from "../../src/phone/approval.js";
import { parseConfig } from "../../src/phone/config.js";
import type { ActionDeps } from "../../src/phone/final.js";
import { WrongScreenError } from "../../src/phone/flow.js";
import { typeDraft } from "../../src/phone/steps/whatsapp.js";
import type { Judge } from "../../src/phone/verify.js";
import {
  FakePhone,
  screensWith,
  systemTransition,
  type FakeLine,
  type Transition,
} from "./fake-phone.js";

const config = parseConfig(
  JSON.stringify({
    contacts: { Amma: "+919876543210", WaterGuy: "+919000000001" },
    water: { vendor: "WaterGuy", address: "Flat 4B, KR Garden" },
    payments: { maxAmountInr: 1000 },
  }),
);

function deps(
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
function phone(
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

const MESSAGE = "Running late, home by 8";
/** WhatsApp, left inside another chat, with `chat` found by searching `query`. */
function whatsapp(query: string, chat: string, text = MESSAGE) {
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

describe("send_whatsapp_text", () => {
  it("goes from inside another chat to the named chat, types the draft and stops", async () => {
    const fake = whatsapp("Family", "Family");
    const context = deps(fake);
    const outcome = await sendWhatsappText(context, {
      to: "Family",
      text: MESSAGE,
      complete: false,
    });

    expect(outcome).toMatchObject({
      status: "staged",
      summary: 'Send WhatsApp to the chat "Family": "Running late, home by 8"',
    });
    expect(fake.inputs).toEqual([
      "key:home",
      "tap:Q Search",
      "key:cmd+a",
      "type:WhatsApp",
      "tap:88,196", // the top hit's icon, above its label
      "tap:5", // the back button, read without its arrow
      "tap:Chats",
      "scroll:up",
      "tap:Q Ask Meta Al or Search",
      "type:Family",
      "tap:Family",
      "tap:201,824", // the message box
      "key:cmd+a",
      "key:backspace",
      `type:${MESSAGE}`,
    ]);
    expect(context.asked).toEqual([]);
  });

  it("finds a saved contact's chat by the last ten digits of the number", async () => {
    const fake = whatsapp("9876543210", "Amma Home");
    const outcome = await sendWhatsappText(deps(fake), {
      to: "Amma",
      text: MESSAGE,
      complete: false,
    });

    expect(outcome).toMatchObject({
      status: "staged",
      summary: expect.stringMatching(
        /^Send WhatsApp to Amma \(\+919876543210\)/,
      ),
    });
    expect(fake.inputs).toContain("type:9876543210");
    expect(fake.inputs).toContain("tap:Amma Home");
  });

  it("presses Enter only after approval", async () => {
    const fake = whatsapp("Family", "Family");
    const context = deps(fake);
    const outcome = await sendWhatsappText(context, {
      to: "Family",
      text: MESSAGE,
      complete: true,
    });

    expect(context.asked).toEqual([
      'Send WhatsApp to the chat "Family": "Running late, home by 8"',
    ]);
    expect(fake.inputs.at(-1)).toBe("key:enter");
    expect(outcome.status).toBe("completed");
  });

  it("does not press Enter when the approval is rejected", async () => {
    const fake = whatsapp("Family", "Family");
    const outcome = await sendWhatsappText(
      deps(fake, { decision: "rejected" }),
      { to: "Family", text: MESSAGE, complete: true },
    );

    expect(outcome).toMatchObject({ status: "declined", decision: "rejected" });
    expect(fake.inputs).not.toContain("key:enter");
  });

  it("stops when the chat name is not in WhatsApp search", async () => {
    const fake = whatsapp("Family", "Family");
    await expect(
      sendWhatsappText(deps(fake), {
        to: "Appa",
        text: MESSAGE,
        complete: true,
      }),
    ).rejects.toThrow(/No chat named "Appa"/);
    expect(fake.inputs).not.toContain("key:enter");
  });

  it("refuses text the keyboard cannot type", () => {
    expect(() => typeDraft("Home by 8 🙂")).toThrow(/plain ASCII/);
  });
});

describe("order_water", () => {
  it("messages the vendor's chat in WhatsApp with the order", async () => {
    const text = "Hi, please deliver 2 x 20 L water can to Flat 4B, KR Garden.";
    const fake = whatsapp("9000000001", "Water Guy", text);
    const outcome = await orderWater(deps(fake), {
      quantity: 2,
      complete: false,
    });

    expect(outcome).toMatchObject({
      status: "staged",
      summary: expect.stringMatching(/WaterGuy \(\+919000000001\).*2 x 20 L/),
    });
    expect(fake.inputs).toContain(`type:${text}`);
  });

  it("blocks when no vendor is configured, without touching the phone", async () => {
    const fake = phone("home", {}, {});
    const outcome = await orderWater(
      { ...deps(fake), config: parseConfig("{}") },
      { quantity: 1, complete: false },
    );

    expect(outcome).toMatchObject({
      status: "blocked",
      reason: expect.stringMatching(/water vendor/),
    });
    expect(fake.inputs).toEqual([]);
  });
});

// ---------------------------------------------------------------- CRED (screens read in November 2026)

const PAYEE = "shop@okhdfcbank";
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
function cred(shown: string) {
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
    amount: { "type:250": "entered" },
    entered: { "tap:SEND MONEY ^": "pin" },
  };
  return phone("CRED", screens, moves);
}
const payment = { vpa: PAYEE, payeeName: "Ravi Stores", amountInr: 250 };

describe("send_money in CRED", () => {
  it("goes from an old payee's page to the amount sheet and stops before SEND MONEY", async () => {
    const fake = cred("F250");
    const context = deps(fake);
    const outcome = await sendMoney(context, { ...payment, complete: false });

    expect(outcome).toMatchObject({
      status: "staged",
      summary: "Pay ₹250.00 to Ravi Stores (shop@okhdfcbank) with CRED",
    });
    expect(fake.inputs.slice(fake.inputs.indexOf("type:CRED") + 2)).toEqual([
      "tap:40,98",
      "tap:UPI",
      "tap:pay to phone number",
      "tap:pay to",
      "key:cmd+a",
      `type:${PAYEE}`,
      "tap:Pay", // the result row's Pay: opens the amount sheet only
      "type:250",
    ]);
    expect(context.asked).toEqual([]);
  });

  it("taps SEND MONEY only after approval, then leaves the PIN to the user", async () => {
    const fake = cred("F250");
    const context = deps(fake);
    const outcome = await sendMoney(context, { ...payment, complete: true });

    expect(context.asked).toEqual([
      "Pay ₹250.00 to Ravi Stores (shop@okhdfcbank) with CRED",
    ]);
    expect(fake.inputs.at(-1)).toBe("tap:SEND MONEY ^");
    expect(outcome).toMatchObject({
      status: "completed",
      next: expect.stringMatching(/UPI PIN/),
    });
  });

  it("does not tap SEND MONEY when the approval is rejected", async () => {
    const fake = cred("F250");
    const outcome = await sendMoney(deps(fake, { decision: "rejected" }), {
      ...payment,
      complete: true,
    });

    expect(outcome).toMatchObject({ status: "declined", decision: "rejected" });
    expect(fake.inputs).not.toContain("tap:SEND MONEY ^");
  });

  it("blocks above the configured limit without touching the phone", async () => {
    const fake = cred("F5000");
    const outcome = await sendMoney(deps(fake), {
      ...payment,
      amountInr: 5000,
      complete: true,
    });

    expect(outcome).toMatchObject({
      status: "blocked",
      reason: expect.stringMatching(/limit/),
    });
    expect(fake.inputs).toEqual([]);
  });

  it("stops when the sheet shows a different amount", async () => {
    const fake = cred("F2500");
    const error = await sendMoney(deps(fake), {
      ...payment,
      complete: true,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WrongScreenError);
    expect(String(error)).toContain("₹250.00");
    expect(fake.inputs).not.toContain("tap:SEND MONEY ^");
  });

  it("blocks when Jev does not confirm the screen", async () => {
    const fake = cred("F250");
    const context = deps(fake, { yes: 0.4 });
    const outcome = await sendMoney(context, { ...payment, complete: true });

    expect(outcome).toMatchObject({
      status: "blocked",
      reason: expect.stringMatching(/Jev did not confirm/),
    });
    expect(context.asked).toEqual([]);
  });
});
