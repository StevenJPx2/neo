import {
  bookRapido,
  BookRapidoInput,
  OpenAppInput,
  orderWater,
  OrderWaterInput,
  sendMoney,
  SendMoneyInput,
  sendWhatsappText,
  SendWhatsappTextInput,
} from "./actions.js";
import { createMacApprover, type Approver } from "./approval.js";
import { chainTools, loadChains, type ChainBook } from "./chains.js";
import { loadConfig, type PhoneConfig } from "./config.js";
import type { ActionOutcome } from "./final.js";
import { GhosthandClient } from "./ghosthand.js";
import { NavigationError } from "./navigation.js";
import { withPhone } from "./phone.js";
import { STEP_TOOLS } from "./step-tools.js";
import { openApp } from "./steps/system.js";
import { defineStep, defineTool, type PhoneTool } from "./tool.js";
import { keychainPasscode, type PasscodeSource } from "./unlock.js";
import { createJevJudge, type Judge } from "./verify.js";

export type { PhoneTool } from "./tool.js";

const SAFETY =
  "Starts from any screen: it goes to the Home Screen first. " +
  "With complete=false (default) it stops before the final tap and returns status 'staged'. " +
  "With complete=true the user must click Approve in a dialog on the Mac before the final tap.";

const ACTION_TOOLS: readonly PhoneTool[] = [
  defineTool({
    name: "send_whatsapp_text",
    title: "Send a WhatsApp message",
    description: `Opens a WhatsApp chat on the iPhone with the message filled in. ${SAFETY}`,
    input: SendWhatsappTextInput,
    run: sendWhatsappText,
  }),
  defineTool({
    name: "order_water",
    title: "Order drinking water",
    description: `Messages the configured water vendor on WhatsApp with the order. ${SAFETY}`,
    input: OrderWaterInput,
    run: orderWater,
  }),
  defineTool({
    name: "send_money",
    title: "Send money over UPI",
    description: `Opens a UPI payment (CRED by default) with payee and amount filled in. ${SAFETY} The user always enters the UPI PIN.`,
    input: SendMoneyInput,
    run: sendMoney,
  }),
  defineTool({
    name: "book_rapido",
    title: "Book a Rapido ride (experimental)",
    description: `Searches the destination in Rapido and selects the vehicle. Experimental: relies on Rapido's on-screen labels. ${SAFETY}`,
    input: BookRapidoInput,
    run: bookRapido,
  }),
  defineStep({
    name: "open_app",
    title: "Open an app, past its Face ID lock",
    description:
      "From any screen: Home Screen, Spotlight, the app's top hit, then its Face ID lock " +
      "(Face ID, then the iPhone passcode from the macOS Keychain, typed at most once).",
    input: OpenAppInput,
    from: "anywhere",
    to: "<app>.open",
    step: ({ app }) => openApp(app),
  }),
];

/** Whole actions first, then every step they are made of, then saved chains of steps. */
export const PHONE_TOOLS: readonly PhoneTool[] = [
  ...ACTION_TOOLS,
  ...STEP_TOOLS,
  ...chainTools([...ACTION_TOOLS, ...STEP_TOOLS]),
];

export type Runtime = {
  ghosthand: GhosthandClient;
  judge: Judge;
  approve: Approver;
  passcode: PasscodeSource;
  loadConfig: () => Promise<PhoneConfig>;
  loadChains: () => Promise<ChainBook>;
};

export function defaultRuntime(): Runtime {
  return {
    ghosthand: new GhosthandClient(),
    judge: createJevJudge(),
    approve: createMacApprover(),
    passcode: keychainPasscode(),
    loadConfig,
    loadChains: () => loadChains(),
  };
}

/**
 * Runs one tool. Input, limits and chains are checked before the phone is leased; a tool
 * that needs no phone answers then. A navigation failure happens before any final tap: `blocked`.
 */
export async function runPhoneTool(
  tool: PhoneTool,
  input: unknown,
  runtime: Runtime,
): Promise<ActionOutcome> {
  const config = await runtime.loadConfig();
  const work = await tool.prepare(input, {
    config,
    loadChains: runtime.loadChains,
  });
  if (typeof work !== "function") return work;
  try {
    return await withPhone(runtime.ghosthand, `neo ${tool.name}`, (phone) =>
      work({
        phone,
        judge: runtime.judge,
        approve: runtime.approve,
        passcode: runtime.passcode,
        config,
      }),
    );
  } catch (error) {
    if (!(error instanceof NavigationError)) throw error;
    return {
      status: "blocked",
      summary: tool.title,
      reason: `${error.message} No final tap was made.`,
    };
  }
}
