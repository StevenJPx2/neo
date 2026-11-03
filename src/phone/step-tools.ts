import { z } from "zod";
import { asciiText, complete, UpiPaymentInput } from "./actions.js";
import { normalizePhoneNumber } from "./formats.js";
import {
  CRED_HOME,
  enterAmount,
  findPayee,
  openPayee,
  openPaySearch,
  openScanner,
  overLimit,
  PAY_SEARCH,
  PIN_PROMPT,
  SCANNER,
  sendMoney,
  showCredHome,
} from "./steps/cred.js";
import {
  book,
  pickVehicle,
  RAPIDO_HOME,
  READY,
  REQUESTED,
  searchDrop,
  showRapidoHome,
  VEHICLE_LIST,
  VEHICLES,
} from "./steps/rapido.js";
import {
  APP_NAMES,
  APPS,
  appOpen,
  HOME,
  launchFromSpotlight,
  openSpotlight,
  reset,
  SPOTLIGHT,
  unlock,
} from "./steps/system.js";
import {
  CHAT,
  CHAT_LIST,
  draftOf,
  openChat,
  openChatByNumber,
  openSearch,
  SEARCH,
  send,
  showChatList,
  typeDraft,
} from "./steps/whatsapp.js";
import { defineFinal, defineStep, defineTool, type PhoneTool } from "./tool.js";
import { classifyLock } from "./unlock.js";

const NoInput = z.object({});
const AppInput = z.object({ app: z.enum(APPS) });

// Screens phone_screen can name; `<app>.open` alone says too little to report.
const KNOWN_SCREENS = [
  HOME,
  SPOTLIGHT,
  CHAT_LIST,
  SEARCH,
  CHAT,
  draftOf(""),
  CRED_HOME,
  SCANNER,
  PAY_SEARCH,
  PIN_PROMPT,
  RAPIDO_HOME,
  VEHICLE_LIST,
  READY,
  REQUESTED,
];

const phoneScreen = defineTool({
  name: "phone_screen",
  title: "Name the screen the iPhone shows",
  description:
    "Reads the screen (OCR only, no input) and names the known screens it matches, " +
    "so you know which step can run next. Locked apps show as <app>.locked.",
  input: NoInput,
  run: async ({ phone }) => {
    const text = await phone.readText();
    const locked = APPS.filter(
      (app) => classifyLock(text, APP_NAMES[app]).kind !== "open",
    ).map((app) => `${app}.locked`);
    const showing = [
      ...new Set([
        ...KNOWN_SCREENS.filter((screen) => screen.shows(text)).map(
          (screen) => screen.name,
        ),
        ...locked,
      ]),
    ];
    return {
      status: "completed",
      summary:
        showing.length === 0
          ? "No screen neo knows is showing."
          : `Showing: ${showing.join(", ")}`,
    };
  },
});

const system: PhoneTool[] = [
  defineStep({
    name: "phone_reset",
    title: "Go to the Home Screen",
    description:
      "Base setup that every action runs first: Home presses until the Home Screen shows.",
    input: NoInput,
    from: "anywhere",
    to: "home",
    step: () => reset,
  }),
  defineStep({
    name: "spotlight_open",
    title: "Open Spotlight",
    description: "Taps the Home Screen's Search button.",
    input: NoInput,
    from: "home",
    to: "spotlight",
    step: () => openSpotlight,
  }),
  defineStep({
    name: "spotlight_launch",
    title: "Launch an app from Spotlight",
    description: "Types the app's name and taps its top hit's icon.",
    input: AppInput,
    from: "spotlight",
    to: "<app>.open?locked",
    step: ({ app }) => launchFromSpotlight(app),
  }),
  defineStep({
    name: "unlock_app",
    title: "Get the app past its Face ID lock",
    description:
      "Face ID first, then the iPhone passcode saved in the macOS Keychain, typed at most once " +
      "and only into the confirmed iOS passcode prompt. Does nothing if the app is not locked.",
    input: AppInput,
    from: "<app>.open?locked",
    to: "<app>.open",
    step: ({ app }) => unlock(app, appOpen(app)),
  }),
];

const whatsapp: PhoneTool[] = [
  defineStep({
    name: "whatsapp_chat_list",
    title: "Show WhatsApp's chat list",
    description:
      "Backs out of chats and other tabs, and reveals the search bar.",
    input: NoInput,
    from: "whatsapp.open",
    to: "whatsapp.chat_list",
    step: () => showChatList,
  }),
  defineStep({
    name: "whatsapp_open_search",
    title: "Focus WhatsApp's search",
    description: "Taps the search bar.",
    input: NoInput,
    from: "whatsapp.chat_list",
    to: "whatsapp.search",
    step: () => openSearch,
  }),
  defineStep({
    name: "whatsapp_open_chat",
    title: "Open a WhatsApp chat by name",
    description:
      "Types the name and opens the chat whose name matches exactly.",
    input: z.object({ name: asciiText("The chat name").max(60) }),
    from: "whatsapp.search",
    to: "whatsapp.chat",
    step: ({ name }) => openChat(name),
  }),
  defineStep({
    name: "whatsapp_open_chat_by_number",
    title: "Open a WhatsApp chat by phone number",
    description:
      "Types the number's last ten digits and opens the first chat WhatsApp search lists.",
    input: z.object({
      number: z.string().describe("Phone number with country code"),
    }),
    from: "whatsapp.search",
    to: "whatsapp.chat",
    step: ({ number }) => openChatByNumber(normalizePhoneNumber(number)),
  }),
  defineStep({
    name: "whatsapp_type_draft",
    title: "Type a WhatsApp draft",
    description: "Clears the message box and types the text. Never sends.",
    input: z.object({ text: asciiText("The text").max(1_000) }),
    from: "whatsapp.chat",
    to: "whatsapp.draft",
    step: ({ text }) => typeDraft(text),
  }),
  defineFinal({
    name: "whatsapp_send",
    title: "Send the typed WhatsApp draft",
    description:
      "Irreversible. Checks the draft is exactly 'text' (and the chat is 'chatName', if given), " +
      "then with complete=true asks for approval on the Mac and presses Enter.",
    input: z.object({
      text: asciiText("The text").max(1_000),
      chatName: asciiText("The chat name").max(60).optional(),
      complete,
    }),
    from: "whatsapp.draft",
    to: "whatsapp.chat",
    complete: (input) => input.complete,
    final: ({ text, chatName }) =>
      chatName === undefined
        ? send({ text, recipient: "the open WhatsApp chat" })
        : send({ text, recipient: `the chat "${chatName}"`, chatName }),
  }),
];

const VpaInput = UpiPaymentInput.pick({ vpa: true });

const cred: PhoneTool[] = [
  defineStep({
    name: "cred_home",
    title: "Show CRED's home",
    description: "Closes the QR scanner and backs out of pay screens.",
    input: NoInput,
    from: "cred.open",
    to: "cred.home",
    step: () => showCredHome,
  }),
  defineStep({
    name: "cred_open_upi",
    title: "Open CRED's UPI scanner",
    description: "Taps the UPI button in the bottom bar.",
    input: NoInput,
    from: "cred.home",
    to: "cred.scanner",
    step: () => openScanner,
  }),
  defineStep({
    name: "cred_open_pay_search",
    title: "Open CRED's send-money search",
    description: 'Taps the "pay to …" field under the scanner.',
    input: NoInput,
    from: "cred.scanner",
    to: "cred.pay_search",
    step: () => openPaySearch,
  }),
  defineStep({
    name: "cred_find_payee",
    title: "Look up a UPI ID in CRED",
    description:
      "Types the UPI ID; CRED shows the bank's name for it with a Pay button.",
    input: VpaInput,
    from: "cred.pay_search",
    to: "cred.payee_found",
    step: ({ vpa }) => findPayee(vpa),
  }),
  defineStep({
    name: "cred_open_payee",
    title: "Open the payee's amount sheet",
    description:
      "Taps Pay on the result row. This opens the amount sheet; it does not pay.",
    input: VpaInput,
    from: "cred.payee_found",
    to: "cred.amount",
    step: ({ vpa }) => openPayee(vpa),
  }),
  defineStep({
    name: "cred_enter_amount",
    title: "Type the amount in CRED",
    description:
      "Types the amount into the sheet. Refuses amounts over the configured limit.",
    input: UpiPaymentInput,
    from: "cred.amount",
    to: "cred.amount_entered",
    refuse: (input, config) => overLimit(config, input.amountInr),
    step: (input) => enterAmount(input),
  }),
  defineFinal({
    name: "cred_send_money",
    title: "Tap SEND MONEY in CRED",
    description:
      "Irreversible. Checks the UPI ID and amount on screen, then with complete=true asks for approval " +
      "on the Mac and taps SEND MONEY. You enter the UPI PIN; neo never types it.",
    input: UpiPaymentInput.extend({ complete }),
    from: "cred.amount_entered",
    to: "cred.pin",
    complete: (input) => input.complete,
    refuse: (input, config) => overLimit(config, input.amountInr),
    final: (input) => sendMoney(input),
  }),
];

const Drop = z.object({ drop: asciiText("The destination").min(2).max(100) });
const VehicleInput = z.object({ vehicle: z.enum(VEHICLES).default("bike") });

const rapido: PhoneTool[] = [
  defineStep({
    name: "rapido_home",
    title: "Show Rapido's destination field (experimental)",
    description: "Backs out until the destination field shows.",
    input: NoInput,
    from: "rapido.open",
    to: "rapido.home",
    step: () => showRapidoHome,
  }),
  defineStep({
    name: "rapido_search_drop",
    title: "Search a Rapido destination (experimental)",
    description: "Types the destination and picks the first suggestion.",
    input: Drop,
    from: "rapido.home",
    to: "rapido.vehicles",
    step: ({ drop }) => searchDrop(drop),
  }),
  defineStep({
    name: "rapido_pick_vehicle",
    title: "Pick the Rapido vehicle (experimental)",
    description: "Taps the bike, auto or cab option.",
    input: VehicleInput,
    from: "rapido.vehicles",
    to: "rapido.ready",
    step: ({ vehicle }) => pickVehicle(vehicle),
  }),
  defineFinal({
    name: "rapido_book",
    title: "Book the Rapido ride (experimental)",
    description:
      "Irreversible. With complete=true asks for approval on the Mac and taps Book.",
    input: Drop.extend(VehicleInput.shape).extend({ complete }),
    from: "rapido.ready",
    to: "rapido.requested",
    complete: (input) => input.complete,
    final: ({ drop, vehicle }) => book(drop, vehicle),
  }),
];

/** Every step on its own, for agents that chain them. Actions run the same steps. */
export const STEP_TOOLS: readonly PhoneTool[] = [
  phoneScreen,
  ...system,
  ...whatsapp,
  ...cred,
  ...rapido,
];
