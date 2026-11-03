const VPA = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;
const PHONE_DIGITS = /^[1-9][0-9]{9,14}$/;

/** Digits of an international phone number, without `+`, spaces or punctuation. */
export function normalizePhoneNumber(input: string): string {
  const digits = input.replace(/[\s()-]/g, "").replace(/^\+/, "");
  if (!PHONE_DIGITS.test(digits)) {
    throw new Error(
      `"${input}" is not a saved contact or a phone number with country code, e.g. +919876543210.`,
    );
  }
  return digits;
}

export function isVpa(text: string): boolean {
  return VPA.test(text);
}

/** Rupees with exactly two decimals; rejects zero, negatives and fractions of a paisa. */
export function formatAmount(amountInr: number): string {
  const paise = amountInr * 100;
  if (
    !Number.isFinite(amountInr) ||
    amountInr <= 0 ||
    Math.abs(paise - Math.round(paise)) > 1e-6
  ) {
    throw new Error(`${amountInr} is not a valid rupee amount.`);
  }
  return amountInr.toFixed(2);
}

/** The amount as typed into an app's amount field: "250", "250.5", "250.05". */
export function typedAmount(amountInr: number): string {
  return formatAmount(amountInr)
    .replace(/\.00$/, "")
    .replace(/(\.\d)0$/, "$1");
}
