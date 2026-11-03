import { describe, expect, it } from "vitest";
import {
  orderWater,
  sendMoney,
  sendWhatsappText,
} from "../../src/phone/actions.js";
import { parseConfig } from "../../src/phone/config.js";
import { WrongScreenError } from "../../src/phone/flow.js";
import { typeDraft } from "../../src/phone/steps/whatsapp.js";
import {
  cred,
  deps,
  MESSAGE,
  payment,
  PAYEE,
  phone,
  whatsapp,
} from "./fake-apps.js";

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
