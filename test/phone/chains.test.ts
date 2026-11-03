import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import type { ApprovalDecision } from "../../src/phone/approval.js";
import {
  chainWork,
  loadChains,
  parseChains,
  planChain,
  type VarValue,
} from "../../src/phone/chains.js";
import {
  latestReplyAmount,
  showsName,
} from "../../src/phone/steps/whatsapp.js";
import { PHONE_TOOLS } from "../../src/phone/tools.js";
import { config, cred, deps, MESSAGE, PAYEE, whatsapp } from "./fake-apps.js";
import {
  FakePhone,
  screensWith,
  systemTransition,
  type FakeLine,
} from "./fake-phone.js";

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
    const work = chainWork(plan("note-to", { text: MESSAGE }), false);
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
    const work = chainWork(plan("note-to", { text: MESSAGE }), true);
    if (typeof work !== "function") throw new Error("expected work");

    expect((await work(context)).status).toBe("completed");
    expect(context.asked).toHaveLength(1);
    expect(fake.inputs.at(-1)).toBe("key:enter");
  });

  it("overrides a saved value, keeps numbers numbers, and ends without a final step", async () => {
    const fake = cred("F120", "120");
    const work = chainWork(plan("pay-shop", { amount: 120 }), false);
    if (typeof work !== "function") throw new Error("expected work");

    expect(await work(deps(fake))).toMatchObject({
      status: "completed",
      summary: 'Ran chain "pay-shop" (7 steps). Now on cred.amount_entered.',
    });
    expect(fake.inputs.at(-1)).toBe("type:120");
  });

  it("refuses an amount over the limit before the phone is leased", () => {
    expect(chainWork(plan("pay-shop", { amount: 5000 }), false)).toMatchObject({
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
    expect(planSteps(["whatsapp_chat_list", "phone_reset"]).links).toHaveLength(
      2,
    );
  });

  it("lets a reader save only into a declared variable, and only a reader save", () => {
    expect(() =>
      planSteps([{ tool: "whatsapp_chat_list", save: "x" }], { x: 1 }),
    ).toThrow(/reads nothing, so it cannot "save"/);
    expect(() =>
      planSteps([
        {
          tool: "whatsapp_read_reply_amount",
          input: { chat: TOP, maxInr: 200 },
          save: "amount",
        },
      ]),
    ).toThrow(/declare it in "vars" with an expected value/);
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

// ---------------------------------------------------------------- Reading the reply (as on the device)

const TOP = "Green Valley Water Supply";
const REPLY: FakeLine[] = [
  ["120", 26, 370],
  ["21:44", 67, 381],
];
/** The chat as read on the iPhone: the header cuts the name short; your order on the right. */
const topChat = (...extra: FakeLine[]): FakeLine[] => [
  ["09:41", 37, 25],
  ["<3", 20, 68],
  ["Green Valley Water...", 115, 71],
  ["online", 115, 87],
  ["One 20 L water can please.", 108, 294],
  ["Flat 4B, KR Garden", 108, 317],
  ["21:43", 321, 330],
  ...extra,
  ["+", 5, 798, 38],
];
const draft = (text: string): FakeLine => [text, 57, 809, 20];
const sent = (text: string, y: number): FakeLine => [text, 150, y];

function topPhone(reply: FakeLine[] = REPLY): FakePhone {
  const moves: Record<string, Record<string, string>> = {
    chat: { "type:Paid 120": "draftA" },
    draftA: { "key:enter": "sentA" },
    sentA: { "type:Thanks": "draftB" },
    draftB: { "key:enter": "sentB" },
  };
  return new FakePhone(
    "chat",
    screensWith({
      chat: topChat(...reply),
      draftA: topChat(...reply, draft("Paid 120")),
      sentA: topChat(...reply, sent("Paid 120", 600)),
      draftB: topChat(...reply, sent("Paid 120", 600), draft("Thanks")),
      sentB: topChat(...reply, sent("Paid 120", 600), sent("Thanks", 650)),
    }),
    (state, input) => moves[state]?.[input] ?? systemTransition(state, input),
  );
}

const readThenSend = (steps: unknown[] = []) =>
  parseChains(
    JSON.stringify({
      chains: {
        settle: {
          vars: { amount: 999 },
          steps: [
            {
              tool: "whatsapp_read_reply_amount",
              input: { chat: TOP, maxInr: 200 },
              save: "amount",
            },
            { tool: "whatsapp_type_draft", input: { text: "Paid ${amount}" } },
            { tool: "whatsapp_send", input: { text: "Paid ${amount}" } },
            ...steps,
          ],
        },
      },
    }),
  );

describe("reading a value and using it later in the chain", () => {
  it("knows a cut-short header, and finds their latest amount below your last message", async () => {
    expect(showsName("Green Valley Water...", TOP)).toBe(true);
    expect(showsName("Green...", TOP)).toBe(false);
    expect(latestReplyAmount(await topPhone().readText())).toBe(120);
    expect(latestReplyAmount(await topPhone([]).readText())).toBeUndefined();
  });

  it("saves the amount it read and rebuilds the later steps with it", async () => {
    const fake = topPhone();
    const plan = planChain(readThenSend(), "settle", {}, config, PHONE_TOOLS);
    const work = chainWork(plan, false);
    if (typeof work !== "function") throw new Error("expected work");

    expect(await work(deps(fake))).toMatchObject({
      status: "staged",
      summary: expect.stringMatching(/"Paid 120".*after: read 120 into amount/),
    });
    expect(fake.inputs).toContain("type:Paid 120");
  });

  it("stops above the cap, and when there is no reply, before typing anything", async () => {
    for (const reply of [[["500", 26, 370] as FakeLine], []]) {
      const fake = topPhone(reply);
      const work = chainWork(
        planChain(readThenSend(), "settle", {}, config, PHONE_TOOLS),
        true,
      );
      if (typeof work !== "function") throw new Error("expected work");

      expect(await work(deps(fake))).toMatchObject({
        status: "blocked",
        reason: expect.stringMatching(
          /above the ₹200 cap|No reply with an amount/,
        ),
      });
      expect(fake.inputs.filter((input) => input.startsWith("type:"))).toEqual(
        [],
      );
    }
  });

  it("asks for approval before each irreversible step, and reports what happened before a stop", async () => {
    const twoSends = readThenSend([
      { tool: "whatsapp_type_draft", input: { text: "Thanks" } },
      { tool: "whatsapp_send", input: { text: "Thanks" } },
    ]);
    const fake = topPhone();
    const context = deps(fake);
    const work = chainWork(
      planChain(twoSends, "settle", {}, config, PHONE_TOOLS),
      true,
    );
    if (typeof work !== "function") throw new Error("expected work");

    expect((await work(context)).status).toBe("completed");
    expect(context.asked).toHaveLength(2);
    expect(fake.inputs.filter((input) => input === "key:enter")).toHaveLength(
      2,
    );

    const declining = topPhone();
    let approvals = 0;
    const second = {
      ...deps(declining),
      // Approve the first send, reject the second.
      approve: async (): Promise<ApprovalDecision> =>
        approvals++ === 0 ? "approved" : "rejected",
    };
    const again = chainWork(
      planChain(twoSends, "settle", {}, config, PHONE_TOOLS),
      true,
    );
    if (typeof again !== "function") throw new Error("expected work");
    expect(await again(second)).toMatchObject({
      status: "declined",
      summary: expect.stringMatching(
        /after: read 120 into amount; Send WhatsApp/,
      ),
    });
  });
});

describe("the personal chain file", () => {
  it("merges chains.local.json, and refuses a name in both", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neo-chains-"));
    try {
      await mkdir(dir, { recursive: true });
      const one = (name: string) =>
        JSON.stringify({ chains: { [name]: { steps: ["phone_reset"] } } });
      await writeFile(join(dir, "chains.json"), one("shared"));
      await writeFile(join(dir, "chains.local.json"), one("mine"));
      expect(
        Object.keys((await loadChains(join(dir, "chains.json"))).chains),
      ).toEqual(["shared", "mine"]);

      await writeFile(join(dir, "chains.local.json"), one("shared"));
      await expect(loadChains(join(dir, "chains.json"))).rejects.toThrow(
        /defined in both/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
