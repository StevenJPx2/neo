import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  chainWork,
  loadChains,
  parseChains,
  planChain,
  type VarValue,
} from "../../src/phone/chains.js";
import { PHONE_TOOLS } from "../../src/phone/tools.js";
import { config, cred, deps, MESSAGE, PAYEE, whatsapp } from "./fake-apps.js";

const book = parseChains(
  JSON.stringify({
    chains: {
      "note-to": {
        description: "Draft a message in a chat, ready to send",
        vars: { chat: "Family", text: null },
        steps: [
          { tool: "open_app", input: { app: "whatsapp" } },
          "whatsapp_chat_list",
          "whatsapp_open_search",
          { tool: "whatsapp_open_chat", input: { name: "${chat}" } },
          { tool: "whatsapp_type_draft", input: { text: "${text}" } },
          {
            tool: "whatsapp_send",
            input: { text: "${text}", chatName: "${chat}" },
          },
        ],
      },
      "pay-shop": {
        vars: { amount: 250 },
        steps: [
          { tool: "open_app", input: { app: "cred" } },
          "cred_home",
          "cred_open_upi",
          "cred_open_pay_search",
          { tool: "cred_find_payee", input: { vpa: PAYEE } },
          { tool: "cred_open_payee", input: { vpa: PAYEE } },
          {
            tool: "cred_enter_amount",
            input: {
              vpa: PAYEE,
              payeeName: "Ravi Stores",
              amountInr: "${amount}",
            },
          },
        ],
      },
    },
  }),
);

const plan = (name: string, vars: Record<string, VarValue> = {}) =>
  planChain(book, name, vars, config, PHONE_TOOLS);

/** Plans a one-off chain, for checks on how steps pair. */
const planSteps = (steps: unknown[], vars: Record<string, unknown> = {}) =>
  planChain(
    parseChains(JSON.stringify({ chains: { adhoc: { vars, steps } } })),
    "adhoc",
    {},
    config,
    PHONE_TOOLS,
  );

describe("running a saved chain", () => {
  it("runs every step with its variables, and stops before the final tap", async () => {
    const fake = whatsapp("Family", "Family");
    const context = deps(fake);
    const work = chainWork(
      "note-to",
      plan("note-to", { text: MESSAGE }),
      false,
    );
    if (typeof work !== "function") throw new Error("expected work");

    expect(await work(context)).toMatchObject({
      status: "staged",
      summary: 'Send WhatsApp to the chat "Family": "Running late, home by 8"',
    });
    expect(fake.inputs).toContain("type:Family");
    expect(fake.inputs.at(-1)).toBe(`type:${MESSAGE}`);
    expect(context.asked).toEqual([]);
  });

  it("asks for approval before the final tap when run with complete", async () => {
    const fake = whatsapp("Family", "Family");
    const context = deps(fake);
    const work = chainWork("note-to", plan("note-to", { text: MESSAGE }), true);
    if (typeof work !== "function") throw new Error("expected work");

    expect((await work(context)).status).toBe("completed");
    expect(context.asked).toHaveLength(1);
    expect(fake.inputs.at(-1)).toBe("key:enter");
  });

  it("overrides a saved value, keeps numbers numbers, and ends without a final step", async () => {
    const fake = cred("F120", "120");
    const work = chainWork(
      "pay-shop",
      plan("pay-shop", { amount: 120 }),
      false,
    );
    if (typeof work !== "function") throw new Error("expected work");

    expect(await work(deps(fake))).toMatchObject({
      status: "completed",
      summary: 'Ran chain "pay-shop" (7 steps). Now on cred.amount_entered.',
    });
    expect(fake.inputs.at(-1)).toBe("type:120");
  });

  it("refuses an amount over the limit before the phone is leased", () => {
    expect(
      chainWork("pay-shop", plan("pay-shop", { amount: 5000 }), false),
    ).toMatchObject({
      status: "blocked",
      reason: expect.stringMatching(/cred_enter_amount: .*limit/),
    });
  });
});

describe("checking a chain before it runs", () => {
  it("rejects steps that do not pair, naming both screens", () => {
    expect(() =>
      planSteps([
        "whatsapp_chat_list",
        { tool: "whatsapp_type_draft", input: { text: "hi" } },
      ]),
    ).toThrow(
      "Step 1 (whatsapp_chat_list) ends on whatsapp.chat_list, but step 2 (whatsapp_type_draft) starts on whatsapp.chat.",
    );
  });

  it("lets a step that starts anywhere follow any step", () => {
    expect(planSteps(["whatsapp_chat_list", "phone_reset"])).toHaveLength(2);
  });

  it("allows an irreversible step only at the end", () => {
    expect(() =>
      planSteps([
        { tool: "whatsapp_send", input: { text: "hi" } },
        "phone_reset",
      ]),
    ).toThrow(/irreversible, so it must be the last step/);
  });

  it("needs every variable, and no others", () => {
    expect(() => plan("note-to")).toThrow(
      'The chain needs a value for "text".',
    );
    expect(() => plan("note-to", { text: "hi", txt: "typo" })).toThrow(
      /Unknown variable txt; this chain has: chat, text/,
    );
    expect(() =>
      planSteps([
        { tool: "whatsapp_type_draft", input: { text: "${missing}" } },
      ]),
    ).toThrow(/"\$\{missing\}" is not declared/);
  });

  it("keeps complete out of the file: it is decided when the chain runs", () => {
    expect(() =>
      planSteps([
        { tool: "whatsapp_send", input: { text: "hi", complete: true } },
      ]),
    ).toThrow(/leave out "complete"/);
  });

  it("checks each step's input with that step's own schema", () => {
    expect(() =>
      planSteps([{ tool: "whatsapp_type_draft", input: { text: "${text}" } }], {
        text: "Home by 8 🙂",
      }),
    ).toThrow(/Step 1 \(whatsapp_type_draft\):.*plain ASCII/s);
    expect(() => planSteps(["send_whatsapp_text"])).toThrow(/is not a step/);
  });

  it("names the chains when one is not found", () => {
    expect(() => plan("nope")).toThrow(/Chains: note-to, pay-shop\./);
  });
});

describe("the chain file", () => {
  it("is optional, and must be valid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neo-chains-"));
    try {
      expect(await loadChains(join(dir, "missing.json"))).toEqual({
        chains: {},
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(() => parseChains("{")).toThrow(/not valid JSON/);
    expect(() => parseChains(JSON.stringify({ chain: {} }))).toThrow(/Invalid/);
    expect(() =>
      parseChains(JSON.stringify({ chains: { x: { steps: [] } } })),
    ).toThrow(/Invalid/);
  });
});

describe("run_chain and list_chains", () => {
  const tool = (name: string) => {
    const found = PHONE_TOOLS.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(name);
    return found;
  };
  const setup = { config, loadChains: async () => book };

  it("answers without the phone when the chain cannot run", async () => {
    expect(
      await tool("run_chain").prepare({ name: "nope" }, setup),
    ).toMatchObject({
      status: "blocked",
      reason: expect.stringMatching(
        /No chain "nope".*Nothing on the phone was touched/,
      ),
    });
  });

  it("lists the chains with their variables and steps", async () => {
    const listed = await tool("list_chains").prepare({}, setup);
    expect(listed).toMatchObject({
      status: "completed",
      summary: expect.stringContaining(
        'note-to(chat="Family", text (required)): Draft a message in a chat, ready to send [open_app → whatsapp_chat_list',
      ),
    });
  });
});
