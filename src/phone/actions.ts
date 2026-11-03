import { z } from "zod";
import { resolveRecipient, type PhoneConfig } from "./config.js";
import {
  blocked,
  perform,
  type ActionDeps,
  type ActionOutcome,
} from "./final.js";
import { runStep, type Chain, type Anywhere } from "./flow.js";
import { isVpa } from "./formats.js";
import {
  enterAmount,
  findPayee,
  openPayee,
  openPaySearch,
  openScanner,
  overLimit,
  sendMoney as credSendMoney,
  showCredHome,
} from "./steps/cred.js";
import {
  book,
  pickVehicle,
  searchDrop,
  showRapidoHome,
  VEHICLES,
} from "./steps/rapido.js";
import { APP_NAMES, APPS, openApp } from "./steps/system.js";
import {
  openChat,
  openChatByNumber,
  openSearch,
  send,
  showChatList,
  typeDraft,
} from "./steps/whatsapp.js";

export const complete = z
  .boolean()
  .default(false)
  .describe(
    "false: fill everything in and stop before the final tap. true: ask for approval on the Mac, then make it.",
  );

// The phone's keyboard types US-ASCII only: no emoji, no ₹.
export const asciiText = (what: string) =>
  z
    .string()
    .min(1)
    .regex(
      /^[\x20-\x7e]+$/,
      `${what} must be plain ASCII: the phone keyboard types US-ASCII only (no emoji or ₹).`,
    );

// ---------------------------------------------------------------- WhatsApp

export const SendWhatsappTextInput = z.object({
  to: asciiText("The recipient")
    .max(60)
    .describe(
      "The chat's name as WhatsApp shows it, a contact name from the neo phone config, or a phone number with country code",
    ),
  text: asciiText("The message").max(1_000),
  complete,
});
export type SendWhatsappTextInput = z.infer<typeof SendWhatsappTextInput>;

/** WhatsApp → chat list → search the name or number → chat → draft. */
export function whatsappDraft(
  config: PhoneConfig,
  to: string,
  text: string,
): {
  route: Chain<Anywhere, "whatsapp.draft">;
  final: ReturnType<typeof send>;
} {
  const recipient = resolveRecipient(config, to);
  const search = openApp("whatsapp").then(showChatList).then(openSearch);
  if (recipient.kind === "chat") {
    return {
      route: search.then(openChat(recipient.name)).then(typeDraft(text)),
      final: send({
        text,
        recipient: `the chat "${recipient.name}"`,
        chatName: recipient.name,
      }),
    };
  }
  return {
    route: search
      .then(openChatByNumber(recipient.digits))
      .then(typeDraft(text)),
    final: send({
      text,
      recipient: `${numberLabel(recipient.label, recipient.digits)}, the chat WhatsApp search found for the number`,
    }),
  };
}

/** "Amma (+919876543210)", or just "+919876543210" when the number was given directly. */
function numberLabel(label: string, digits: string): string {
  return label.replace(/\D/g, "") === digits
    ? `+${digits}`
    : `${label} (+${digits})`;
}

export function sendWhatsappText(
  deps: ActionDeps,
  input: SendWhatsappTextInput,
): Promise<ActionOutcome> {
  const { route, final } = whatsappDraft(deps.config, input.to, input.text);
  return perform(deps, route, final, input.complete);
}

// ---------------------------------------------------------------- Water

export const OrderWaterInput = z.object({
  quantity: z.int().min(1).max(10).default(1),
  note: asciiText("The note")
    .max(200)
    .optional()
    .describe("Extra line for the vendor, e.g. a delivery time"),
  complete,
});
export type OrderWaterInput = z.infer<typeof OrderWaterInput>;

export async function orderWater(
  deps: ActionDeps,
  input: OrderWaterInput,
): Promise<ActionOutcome> {
  const water = deps.config.water;
  if (water === undefined) {
    return blocked(
      "Order water",
      'No water vendor configured. Add a "water" section to the neo phone config.',
    );
  }
  const text = [
    `Hi, please deliver ${input.quantity} x ${water.item} to ${water.address}.`,
    input.note,
  ]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  const { route, final } = whatsappDraft(deps.config, water.vendor, text);
  return perform(deps, route, final, input.complete);
}

// ---------------------------------------------------------------- UPI, in CRED

export const UpiPaymentInput = z.object({
  vpa: z
    .string()
    .refine(isVpa, "Not a UPI ID, e.g. name@okhdfcbank")
    .describe("Payee UPI ID, e.g. name@okhdfcbank"),
  payeeName: z
    .string()
    .min(1)
    .max(60)
    .describe(
      "Who you expect to pay; checked against the bank's name CRED shows",
    ),
  amountInr: z.number().positive(),
});
export type UpiPaymentInput = z.infer<typeof UpiPaymentInput>;
export const SendMoneyInput = UpiPaymentInput.extend({ complete });
export type SendMoneyInput = z.infer<typeof SendMoneyInput>;

export async function sendMoney(
  deps: ActionDeps,
  input: SendMoneyInput,
): Promise<ActionOutcome> {
  const final = credSendMoney(input);
  const refusal = overLimit(deps.config, input.amountInr);
  if (refusal !== undefined) return blocked(final.summary, refusal);

  const route = openApp("cred")
    .then(showCredHome)
    .then(openScanner)
    .then(openPaySearch)
    .then(findPayee(input.vpa))
    .then(openPayee(input.vpa))
    .then(enterAmount(input));
  return perform(deps, route, final, input.complete);
}

// ---------------------------------------------------------------- Rapido

export const BookRapidoInput = z.object({
  drop: asciiText("The destination")
    .min(2)
    .max(100)
    .describe(
      "Destination to search for; pickup is the phone's current location",
    ),
  vehicle: z.enum(VEHICLES).default("bike"),
  complete,
});
export type BookRapidoInput = z.infer<typeof BookRapidoInput>;

export function bookRapido(
  deps: ActionDeps,
  input: BookRapidoInput,
): Promise<ActionOutcome> {
  const route = openApp("rapido")
    .then(showRapidoHome)
    .then(searchDrop(input.drop))
    .then(pickVehicle(input.vehicle));
  return perform(deps, route, book(input.drop, input.vehicle), input.complete);
}

// ---------------------------------------------------------------- Open an app

export const OpenAppInput = z.object({
  app: z.enum(APPS).describe("App to open, past its Face ID lock"),
});
export type OpenAppInput = z.infer<typeof OpenAppInput>;

/** Base setup, then Spotlight, then the app's Face ID lock (Face ID, then the Keychain passcode once). */
export async function openAppAction(
  deps: ActionDeps,
  input: OpenAppInput,
): Promise<ActionOutcome> {
  await runStep(deps, openApp(input.app));
  return {
    status: "completed",
    summary: `${APP_NAMES[input.app]} is open and unlocked`,
  };
}
