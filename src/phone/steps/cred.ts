import type { PhoneConfig } from "../config.js";
import { configPath } from "../config.js";
import type { FinalStep } from "../final.js";
import type { Screen, Step } from "../flow.js";
import { formatAmount, typedAmount } from "../formats.js";
import type { ScreenLine, ScreenText } from "../ghosthand.js";
import { center, NavigationError, normalize } from "../navigation.js";
import { textExpectation } from "../verify.js";
import { appOpen } from "./system.js";

// Layout read on iOS 27.2 (iPhone 17, 402x874 pt), CRED as of November 2026.
const BOTTOM_BAR_PT = 110;
const HEADER_PT = 200;
// The pay screens' back arrow (top left) and the QR scanner's close button (top right).
const BACK_BUTTON = { x: 40, y: 98 };
const SCANNER_CLOSE = { x: 361, y: 96 };

const find = (screen: ScreenText, test: (text: string) => boolean) =>
  screen.lines.find((line) => test(normalize(line.text)));
const bottom = (screen: ScreenText, test: (text: string) => boolean) =>
  screen.lines.find(
    (line) =>
      line.y > screen.height - BOTTOM_BAR_PT && test(normalize(line.text)),
  );

export type CredPayment = {
  vpa: string;
  payeeName: string;
  amountInr: number;
};

export const CRED_HOME: Screen<"cred.home"> = {
  name: "cred.home",
  description: "CRED's home, with HOME · CARDS · UPI · REWARDS · MORE",
  shows: (screen) =>
    bottom(screen, (text) => text === "home") !== undefined &&
    bottom(screen, (text) => text === "rewards") !== undefined,
};

/** The UPI button opens a QR scanner with a "pay to …" field below it (its words rotate). */
export const SCANNER: Screen<"cred.scanner"> = {
  name: "cred.scanner",
  description: "CRED's UPI QR scanner",
  shows: (screen) =>
    find(screen, (text) => text === "scan any qr") !== undefined &&
    payToField(screen) !== undefined,
};
const payToField = (screen: ScreenText) =>
  find(screen, (text) => text.startsWith("pay to"));

// "send money to any UPI app" (OCR has read it as "... any UP app").
const SEND_ANYWHERE = (text: string) => text.startsWith("send money to any");
export const PAY_SEARCH: Screen<"cred.pay_search"> = {
  name: "cred.pay_search",
  description: 'CRED\'s "send money to any UPI app" search',
  shows: (screen) => find(screen, SEND_ANYWHERE) !== undefined,
};

/** The search result for `vpa`: the UPI ID line (OCR prefixes "@ ") and the Pay button on its row. */
function payeeRow(
  screen: ScreenText,
  vpa: string,
): { id: ScreenLine; pay: ScreenLine } | undefined {
  const id = screen.lines.find(
    (line) =>
      line.y > HEADER_PT && normalize(line.text).endsWith(normalize(vpa)),
  );
  if (id === undefined) return undefined;
  const pay = screen.lines.find(
    (line) => normalize(line.text) === "pay" && Math.abs(line.y - id.y) < 40,
  );
  return pay === undefined ? undefined : { id, pay };
}

function payeeFound(vpa: string): Screen<"cred.payee_found"> {
  return {
    name: "cred.payee_found",
    description: `CRED's search showing ${vpa} with its Pay button`,
    shows: (screen) =>
      PAY_SEARCH.shows(screen) && payeeRow(screen, vpa) !== undefined,
  };
}

const AMOUNT_HEADING = (text: string) => text === "enter amount to pay";
const SEND_MONEY = (text: string) => text.startsWith("send money");

/** The payee's page: name and UPI ID at the top, the "ENTER AMOUNT TO PAY" sheet below. */
function amountScreen(vpa: string): Screen<"cred.amount"> {
  return {
    name: "cred.amount",
    description: `CRED's amount sheet for ${vpa}`,
    shows: (screen) =>
      find(screen, AMOUNT_HEADING) !== undefined &&
      screen.lines.some(
        (line) => line.y < HEADER_PT && normalize(line.text) === normalize(vpa),
      ),
  };
}

/** The amount typed into the sheet. OCR reads "₹1" as "F1" or "{1", so the symbol is dropped. */
function enteredAmount(screen: ScreenText): number | undefined {
  const heading = find(screen, AMOUNT_HEADING);
  const button = bottom(screen, SEND_MONEY);
  if (heading === undefined || button === undefined) return undefined;
  const line = screen.lines.find(
    (candidate) => candidate.y > heading.y && candidate.y < button.y,
  );
  const digits = line?.text.replace(/^[^\d]+/, "").replaceAll(",", "");
  return digits !== undefined && /^\d+(\.\d{1,2})?$/.test(digits)
    ? Number(digits)
    : undefined;
}

function amountEntered(payment: CredPayment): Screen<"cred.amount_entered"> {
  const sheet = amountScreen(payment.vpa);
  return {
    name: "cred.amount_entered",
    description: `CRED's amount sheet for ${payment.vpa} showing ₹${formatAmount(payment.amountInr)}`,
    shows: (screen) => {
      const amount = enteredAmount(screen);
      return (
        sheet.shows(screen) &&
        amount !== undefined &&
        Math.abs(amount - payment.amountInr) < 0.005
      );
    },
  };
}

export const PIN_PROMPT: Screen<"cred.pin"> = {
  name: "cred.pin",
  description: "the UPI PIN prompt",
  shows: (screen) =>
    screen.lines.some((line) => normalize(line.text).includes("upi pin")),
};

const MOVES = 4;
const SETTLE_MS = 1_000;

/** CRED reopens where it was left: closes the scanner, backs out of pay screens. */
export const showCredHome: Step<"cred.open", "cred.home"> = {
  name: "cred.home",
  from: appOpen("cred"),
  to: CRED_HOME,
  act: async ({ phone }) => {
    for (let move = 1; move <= MOVES; move += 1) {
      const screen = await phone.readText();
      if (CRED_HOME.shows(screen)) return;
      await phone.tap(SCANNER.shows(screen) ? SCANNER_CLOSE : BACK_BUTTON);
      await phone.pause(SETTLE_MS);
    }
  },
};

export const openScanner: Step<"cred.home", "cred.scanner"> = {
  name: "cred.open_upi",
  from: CRED_HOME,
  to: SCANNER,
  act: async ({ phone }) => {
    const upi = bottom(await phone.readText(), (text) => text === "upi");
    if (upi === undefined) throw new NavigationError("No UPI button.");
    await phone.tap(center(upi));
  },
};

export const openPaySearch: Step<"cred.scanner", "cred.pay_search"> = {
  name: "cred.open_pay_search",
  from: SCANNER,
  to: PAY_SEARCH,
  act: async ({ phone }) => {
    const field = payToField(await phone.readText());
    if (field === undefined) throw new NavigationError('No "pay to" field.');
    await phone.tap(center(field));
  },
};

const KEYBOARD_SETTLE_MS = 800;

/** Types the UPI ID into the "pay to" field; CRED looks it up and shows the bank's name for it. */
export function findPayee(
  vpa: string,
): Step<"cred.pay_search", "cred.payee_found"> {
  return {
    name: `cred.find_payee(${vpa})`,
    from: PAY_SEARCH,
    to: payeeFound(vpa),
    arrival: { attempts: 16, intervalMs: 500 },
    act: async ({ phone }) => {
      const field = payToField(await phone.readText());
      if (field === undefined) throw new NavigationError('No "pay to" field.');
      await phone.tap(center(field));
      await phone.pause(KEYBOARD_SETTLE_MS);
      await phone.key("cmd+a");
      await phone.type(vpa);
    },
  };
}

/** Taps Pay on the result row: this opens the amount sheet, it does not pay. */
export function openPayee(
  vpa: string,
): Step<"cred.payee_found", "cred.amount"> {
  return {
    name: "cred.open_payee",
    from: payeeFound(vpa),
    to: amountScreen(vpa),
    act: async ({ phone }) => {
      const row = payeeRow(await phone.readText(), vpa);
      if (row === undefined) throw new NavigationError(`No result for ${vpa}.`);
      await phone.tap(center(row.pay));
    },
  };
}

/** The amount field has focus when the sheet opens. */
export function enterAmount(
  payment: CredPayment,
): Step<"cred.amount", "cred.amount_entered"> {
  return {
    name: "cred.enter_amount",
    from: amountScreen(payment.vpa),
    to: amountEntered(payment),
    act: async ({ phone }) => {
      await phone.type(typedAmount(payment.amountInr));
    },
  };
}

/** Refuses amounts above the configured limit, before the phone is touched. */
export function overLimit(
  config: PhoneConfig,
  amountInr: number,
): string | undefined {
  const limit = config.payments.maxAmountInr;
  return amountInr > limit
    ? `₹${formatAmount(amountInr)} is above the ₹${limit} limit in ${configPath()}.`
    : undefined;
}

/** Irreversible: taps SEND MONEY, which leads to the UPI PIN. neo never types the PIN. */
export function sendMoney(
  payment: CredPayment,
): FinalStep<"cred.amount_entered", "cred.pin"> {
  const amount = formatAmount(payment.amountInr);
  const payee = `${payment.payeeName} (${payment.vpa})`;
  return {
    name: "cred.send_money",
    from: amountEntered(payment),
    to: PIN_PROMPT,
    summary: `Pay ₹${amount} to ${payee} with CRED`,
    ready: {
      expect: [textExpectation(payment.vpa)],
      question:
        `Is this CRED's payment sheet for ₹${amount} to ${payee}, not paid yet? ` +
        "The name at the top is the bank's name for the UPI ID; it should be the same person or business.",
    },
    press: async (phone) => {
      const button = bottom(await phone.readText(), SEND_MONEY);
      if (button === undefined)
        throw new NavigationError("No SEND MONEY button.");
      await phone.tap(center(button));
    },
    done: { expect: [], question: "Is the iPhone now asking for the UPI PIN?" },
    next: "Enter your UPI PIN on the iPhone to finish. neo never types UPI PINs.",
  };
}
