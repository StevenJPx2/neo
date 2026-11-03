import type { ScreenLine, ScreenText } from "../ghosthand.js";
import type { FinalStep } from "../final.js";
import type { Reading, Screen, Step } from "../flow.js";
import { center, NavigationError, normalize } from "../navigation.js";
import { isTypeable, type Phone } from "../phone.js";
import { textExpectation, type Expectation } from "../verify.js";
import { appOpen } from "./system.js";

// Layout read on iOS 27.2 (iPhone 17, 402x874 pt) with WhatsApp's 2026 design.
const TOP_BAR_PT = 110;
const BOTTOM_BAR_PT = 110;
const LEFT_EDGE_PT = 60;
// The message box has no label; it sits this far above the bottom edge.
const MESSAGE_BOX_FROM_BOTTOM_PT = 50;

const atBottom = (screen: ScreenText, line: ScreenLine) =>
  line.y > screen.height - BOTTOM_BAR_PT;
const has = (screen: ScreenText, test: (line: ScreenLine) => boolean) =>
  screen.lines.some(test);

/** Updates · Calls · Communities · Chats · You */
const tabBar = (screen: ScreenText) =>
  ["chats", "calls"].every((tab) =>
    has(
      screen,
      (line) => atBottom(screen, line) && normalize(line.text) === tab,
    ),
  );
// "Q Ask Meta AI or Search" (OCR often reads "Al"); "Search" in older versions.
const SEARCH_FIELD = (text: string) =>
  text.endsWith("or search") || text === "search" || text === "q search";
const searchField = (screen: ScreenText) =>
  screen.lines.find((line) => SEARCH_FIELD(normalize(line.text)));
// The back button: "<", "<4", or only the unread count "5" when OCR drops the arrow.
const BACK_LABEL = /^(<\s*\d*|\d+)$/;
// Below the status bar, whose clock also sits at the top left.
const STATUS_BAR_PT = 45;
const backArrow = (screen: ScreenText) =>
  screen.lines.find(
    (line) =>
      line.x < LEFT_EDGE_PT &&
      line.y > STATUS_BAR_PT &&
      line.y < TOP_BAR_PT &&
      BACK_LABEL.test(line.text.trim()),
  );
/** The "+" attachment button, left of the message box. */
const plusButton = (screen: ScreenText) =>
  screen.lines.find(
    (line) =>
      line.x < LEFT_EDGE_PT &&
      atBottom(screen, line) &&
      line.text.trim() === "+",
  );
/** A chat: the back button at the top, the "+" button at the bottom. */
const inChat = (screen: ScreenText) =>
  !tabBar(screen) &&
  backArrow(screen) !== undefined &&
  plusButton(screen) !== undefined;
/**
 * Text in the message box: on the "+" button's row, right of it. The last message's
 * "Edited 14:19" sits just above that row, so the row matters, not only the bottom band.
 */
const draftLine = (screen: ScreenText) => {
  const plus = plusButton(screen);
  if (plus === undefined) return undefined;
  return screen.lines.find((line) => {
    const middle = line.y + line.height / 2;
    return (
      line.x > plus.x + plus.width &&
      middle >= plus.y &&
      middle <= plus.y + plus.height
    );
  });
};

const OPEN = appOpen("whatsapp");

export const CHAT_LIST: Screen<"whatsapp.chat_list"> = {
  name: "whatsapp.chat_list",
  description: "WhatsApp's chat list with its search bar",
  shows: (screen) => tabBar(screen) && searchField(screen) !== undefined,
};

export const SEARCH: Screen<"whatsapp.search"> = {
  name: "whatsapp.search",
  description: "WhatsApp's search, field focused",
  shows: (screen) =>
    !tabBar(screen) &&
    !inChat(screen) &&
    has(
      screen,
      (line) =>
        line.y < TOP_BAR_PT &&
        (SEARCH_FIELD(normalize(line.text)) ||
          normalize(line.text).startsWith("q ")),
    ),
};

export const CHAT: Screen<"whatsapp.chat"> = {
  name: "whatsapp.chat",
  description: "a WhatsApp chat",
  shows: inChat,
};

// WhatsApp cuts a long name in the header: "Green Valley Water...". A cut name must keep this
// many characters to count as a match.
const MIN_SHOWN_CHARS = 12;
const ELLIPSIS = /\s*(\.\.\.|…)$/;

/** Whether header text shows `name`, whole or cut short with an ellipsis. */
export function showsName(text: string, name: string): boolean {
  const shown = normalize(text);
  const full = normalize(name);
  if (shown === full) return true;
  if (!ELLIPSIS.test(shown)) return false;
  const start = shown.replace(ELLIPSIS, "");
  return start.length >= MIN_SHOWN_CHARS && full.startsWith(start);
}

/** The chat whose header shows `name` (the header is the only top line right of the arrow). */
export function chatWith(name: string): Screen<"whatsapp.chat"> {
  return {
    name: "whatsapp.chat",
    description: `the WhatsApp chat "${name}"`,
    shows: (screen) =>
      inChat(screen) &&
      has(
        screen,
        (line) =>
          line.y < TOP_BAR_PT &&
          line.x > LEFT_EDGE_PT &&
          showsName(line.text, name),
      ),
  };
}

/** The OCR check for the chat's name before a send; the header may cut it short. */
function chatNameExpectation(name: string): Expectation {
  const full = normalize(name);
  return {
    label: `the chat "${name}"`,
    test: (screen) => {
      if (screen.includes(full)) return true;
      for (let shown = full.length - 1; shown >= MIN_SHOWN_CHARS; shown -= 1) {
        const start = full.slice(0, shown).trimEnd();
        if (screen.includes(`${start}...`) || screen.includes(`${start}…`))
          return true;
      }
      return false;
    },
  };
}

/** A chat with `text` in its message box. iOS capitalizes the first letter, so case is ignored. */
export function draftOf(text: string): Screen<"whatsapp.draft"> {
  const opening = openingWords(text);
  return {
    name: "whatsapp.draft",
    description: `a WhatsApp chat with "${text}" in the message box`,
    shows: (screen) => {
      const draft = inChat(screen) ? draftLine(screen) : undefined;
      if (draft === undefined) return false;
      return opening === "" || normalize(draft.text).startsWith(opening);
    },
  };
}

/** The first two words, when the keyboard can type them; OCR checks only this much. */
function openingWords(text: string): string {
  const opening = normalize(text).split(" ").slice(0, 2).join(" ");
  return isTypeable(opening) ? opening : "";
}

const CHAT_LIST_MOVES = 5;
const MOVE_SETTLE_MS = 900;

/** WhatsApp reopens wherever it was left. Goes back to the chat list and reveals its search bar. */
export const showChatList: Step<"whatsapp.open", "whatsapp.chat_list"> = {
  name: "whatsapp.chat_list",
  from: OPEN,
  to: CHAT_LIST,
  act: async ({ phone }) => {
    for (let move = 1; move <= CHAT_LIST_MOVES; move += 1) {
      const screen = await phone.readText();
      if (CHAT_LIST.shows(screen)) return;
      await stepTowardChatList(phone, screen);
      await phone.pause(MOVE_SETTLE_MS);
    }
  },
};

async function stepTowardChatList(
  phone: Phone,
  screen: ScreenText,
): Promise<void> {
  if (tabBar(screen)) {
    const chats = screen.lines.find(
      (line) => atBottom(screen, line) && normalize(line.text) === "chats",
    );
    if (chats !== undefined) await phone.tap(center(chats));
    // The search bar hides once the list scrolls; pulling the list down shows it again.
    await phone.scroll("up", 3, {
      x: Math.round(screen.width / 2),
      y: Math.round(screen.height / 2),
    });
    return;
  }
  const back = backArrow(screen);
  if (back !== undefined) return phone.tap(center(back));
  // Esc goes back one screen in WhatsApp (seen in a chat and in search).
  await phone.key("esc");
}

const KEYBOARD_SETTLE_MS = 600;

export const openSearch: Step<"whatsapp.chat_list", "whatsapp.search"> = {
  name: "whatsapp.open_search",
  from: CHAT_LIST,
  to: SEARCH,
  act: async ({ phone }) => {
    const field = searchField(await phone.readText());
    if (field === undefined) throw new NavigationError("No search bar.");
    await phone.tap(center(field));
    await phone.pause(KEYBOARD_SETTLE_MS);
  },
};

const RESULTS_WAIT = { attempts: 10, intervalMs: 500 };

/**
 * Searches `name` and opens the chat whose name matches exactly, the first under the
 * "Chats" heading. It trusts the name is unique; the header is checked on arrival.
 */
export function openChat(
  name: string,
): Step<"whatsapp.search", "whatsapp.chat"> {
  if (!isTypeable(name))
    throw new Error("The chat name must be plain ASCII to type it.");
  return {
    name: `whatsapp.open_chat(${name})`,
    from: SEARCH,
    to: chatWith(name),
    act: async ({ phone }) => {
      await phone.type(name);
      for (let attempt = 1; attempt <= RESULTS_WAIT.attempts; attempt += 1) {
        await phone.pause(RESULTS_WAIT.intervalMs);
        const result = chatResult(await phone.readText(), name);
        if (result !== undefined) return phone.tap(center(result));
      }
      throw new NavigationError(`No chat named "${name}" in WhatsApp search.`);
    },
  };
}

/** Result lines under the "Chats" heading, top first: each chat's name, then its last message. */
function chatResults(screen: ScreenText): ScreenLine[] {
  const heading = screen.lines.find((line) => normalize(line.text) === "chats");
  if (heading === undefined) return [];
  return screen.lines
    .filter((line) => line.y > heading.y && line.x > LEFT_EDGE_PT)
    .sort((a, b) => a.y - b.y);
}

function chatResult(screen: ScreenText, name: string): ScreenLine | undefined {
  return chatResults(screen).find(
    (line) => normalize(line.text) === normalize(name),
  );
}

// WhatsApp shows numbers as "+91 94969 72507"; the last ten digits match however it was saved.
const NUMBER_SEARCH_DIGITS = 10;

/**
 * Searches a phone number and opens the first chat under the "Chats" heading: the chat
 * with that number, shown by its contact name (for your own number: "<your name> (You)").
 */
export function openChatByNumber(
  digits: string,
): Step<"whatsapp.search", "whatsapp.chat"> {
  return {
    name: `whatsapp.open_chat_by_number(+${digits})`,
    from: SEARCH,
    to: CHAT,
    act: async ({ phone }) => {
      await phone.type(digits.slice(-NUMBER_SEARCH_DIGITS));
      for (let attempt = 1; attempt <= RESULTS_WAIT.attempts; attempt += 1) {
        await phone.pause(RESULTS_WAIT.intervalMs);
        const first = chatResults(await phone.readText())[0];
        if (first !== undefined) return phone.tap(center(first));
      }
      throw new NavigationError(`No WhatsApp chat for +${digits}.`);
    },
  };
}

// The reply is just the amount: "120", sometimes "₹120" or "120/-" (OCR reads ₹ as "F" or "{").
const REPLY_AMOUNT =
  /^(?:₹|rs\.?|inr|f|\{)?\s*(\d{1,3}(?:,\d{3})+|\d{1,6})(?:\.\d{1,2})?\s*(?:\/-)?$/i;
// Their bubbles start at the left edge (seen: x=26); yours start right of this (x≥97). Times in
// their bubbles ("21:44" at x=67) fall in between and count as neither.
const INCOMING_MAX_X = 60;
const OUTGOING_MIN_X = 90;

/** The amount in the latest message from the other person below your own last message, if any. */
export function latestReplyAmount(screen: ScreenText): number | undefined {
  const plus = plusButton(screen);
  const bottom = plus === undefined ? screen.height - BOTTOM_BAR_PT : plus.y;
  const messages = screen.lines.filter(
    (line) => line.y > TOP_BAR_PT && line.y < bottom,
  );
  const lastOutgoing = Math.max(
    0,
    ...messages
      .filter((line) => line.x >= OUTGOING_MIN_X)
      .map((line) => line.y),
  );
  const amounts = messages
    .filter((line) => line.x < INCOMING_MAX_X && line.y > lastOutgoing)
    .sort((a, b) => b.y - a.y)
    .map((line) => REPLY_AMOUNT.exec(line.text.trim())?.[1]);
  const latest = amounts.find((amount) => amount !== undefined);
  return latest === undefined ? undefined : Number(latest.replaceAll(",", ""));
}

/**
 * In the open chat `chat`, reads the amount the other person replied with after your last
 * message. Refuses an amount above `maxInr`: their message must not decide a large payment.
 */
export function readReplyAmount(
  chat: string,
  maxInr: number,
): Reading<"whatsapp.chat", "whatsapp.chat"> {
  const screen = chatWith(chat);
  return {
    step: {
      name: `whatsapp.read_reply_amount(${chat})`,
      from: screen,
      to: screen,
      act: async () => {},
    },
    read: async ({ phone }) => {
      const amount = latestReplyAmount(await phone.readText());
      if (amount === undefined)
        throw new NavigationError(
          `No reply with an amount after your last message in "${chat}".`,
        );
      if (amount > maxInr)
        throw new NavigationError(
          `The reply in "${chat}" asks for ₹${amount}, above the ₹${maxInr} cap.`,
        );
      return amount;
    },
  };
}

/** Clears the message box, then types `text`. Typing only; nothing is sent. */
export function typeDraft(
  text: string,
): Step<"whatsapp.chat", "whatsapp.draft"> {
  if (!isTypeable(text))
    throw new Error(
      "The phone keyboard types plain ASCII only: no emoji or ₹.",
    );
  return {
    name: "whatsapp.type_draft",
    from: CHAT,
    to: draftOf(text),
    act: async ({ phone }) => {
      const screen = await phone.readText();
      await phone.tap({
        x: Math.round(screen.width / 2),
        y: screen.height - MESSAGE_BOX_FROM_BOTTOM_PT,
      });
      await phone.pause(KEYBOARD_SETTLE_MS);
      // A draft left from earlier would be sent along with the message.
      await phone.key("cmd+a");
      await phone.key("backspace");
      await phone.type(text);
    },
  };
}

export type SendTarget = {
  text: string;
  /** Who it goes to, for the approval dialog: a chat name, or a contact and number. */
  recipient: string;
  /** Checked in the chat's header when the chat was opened by name. */
  chatName?: string;
};

/** Irreversible: presses Enter in a chat with the draft typed. Runs through finish() only. */
export function send(
  target: SendTarget,
): FinalStep<"whatsapp.draft", "whatsapp.chat"> {
  const { text, chatName } = target;
  const opening = openingWords(text);
  const expect = opening === "" ? [] : [textExpectation(opening)];
  if (chatName !== undefined) expect.push(chatNameExpectation(chatName));
  const chat =
    chatName === undefined
      ? "a WhatsApp chat"
      : `the WhatsApp chat with "${chatName}"`;

  return {
    name: "whatsapp.send",
    from: draftOf(text),
    to: CHAT,
    summary: `Send WhatsApp to ${target.recipient}: "${text}"`,
    ready: {
      expect,
      question: `Is this ${chat}, with the message "${text}" typed in the message box and not sent yet?`,
    },
    press: (phone) => phone.key("enter"),
    done: {
      expect: [],
      question: `Was the message "${text}" just sent in this WhatsApp chat, with the message box now empty?`,
    },
  };
}
