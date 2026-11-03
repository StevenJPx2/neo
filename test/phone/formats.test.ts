import { describe, expect, it } from "vitest";
import { parseConfig, resolveRecipient } from "../../src/phone/config.js";
import {
  formatAmount,
  isVpa,
  normalizePhoneNumber,
  typedAmount,
} from "../../src/phone/formats.js";
import { amountExpectation } from "../../src/phone/verify.js";

describe("formats", () => {
  it("checks UPI IDs, amounts and phone numbers", () => {
    expect(isVpa("shop@okhdfcbank")).toBe(true);
    expect(isVpa("not-a-vpa")).toBe(false);
    expect(() => formatAmount(0)).toThrow();
    expect(() => formatAmount(10.005)).toThrow();
    expect(formatAmount(12.3)).toBe("12.30");
    expect(() => normalizePhoneNumber("12345")).toThrow(/country code/);
  });

  it("types amounts the way an amount field takes them", () => {
    expect(typedAmount(250)).toBe("250");
    expect(typedAmount(250.5)).toBe("250.5");
    expect(typedAmount(250.05)).toBe("250.05");
  });
});

describe("config", () => {
  it("fills defaults, and resolves contacts, numbers and chat names", () => {
    const config = parseConfig(
      JSON.stringify({ contacts: { Amma: "+91 98765 43210" } }),
    );

    expect(config.payments).toEqual({ maxAmountInr: 5000 });
    expect(resolveRecipient(config, "Amma")).toEqual({
      kind: "number",
      label: "Amma",
      digits: "919876543210",
    });
    expect(resolveRecipient(config, "+14155550123")).toMatchObject({
      kind: "number",
      digits: "14155550123",
    });
    expect(resolveRecipient(config, "Saved Messages")).toEqual({
      kind: "chat",
      name: "Saved Messages",
    });
  });

  it("rejects unknown keys, bad numbers and text the keyboard cannot type", () => {
    expect(() => parseConfig(JSON.stringify({ contact: {} }))).toThrow(
      /Invalid/,
    );
    expect(() =>
      parseConfig(JSON.stringify({ contacts: { Bad: "123" } })),
    ).toThrow(/country code/);
    expect(() =>
      parseConfig(
        JSON.stringify({
          water: { vendor: "W", address: "Flat 4B, KR Garden ₹" },
        }),
      ),
    ).toThrow(/ASCII/);
  });
});

describe("amountExpectation", () => {
  it("matches the amount however the app formats it, and nothing else", () => {
    const whole = amountExpectation(1250);
    expect(whole.test("pay ₹1,250 to ravi")).toBe(true);
    expect(whole.test("₹1250.00")).toBe(true);
    expect(whole.test("₹11250")).toBe(false);
    expect(whole.test("₹1250.50")).toBe(false);

    const fraction = amountExpectation(250.5);
    expect(fraction.test("₹250.50")).toBe(true);
    expect(fraction.test("₹250.5")).toBe(true);
    expect(fraction.test("₹250")).toBe(false);
  });
});
