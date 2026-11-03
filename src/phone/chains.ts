import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { complete } from "./actions.js";
import type { PhoneConfig } from "./config.js";
import { blocked, finish, type ActionOutcome } from "./final.js";
import { runStep } from "./flow.js";
import type { Link, PhoneTool, Work } from "./tool.js";

export const DEFAULT_CHAINS_PATH = join(
  homedir(),
  ".config",
  "neo",
  "chains.json",
);

export function chainsPath(): string {
  return process.env["NEO_PHONE_CHAINS"] ?? DEFAULT_CHAINS_PATH;
}

const CHAIN_NAME = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const VAR_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,30}$/;
const MAX_CHAIN_STEPS = 30;

const VarValue = z.union([z.string().max(1_000), z.number(), z.boolean()]);
export type VarValue = z.infer<typeof VarValue>;

const StepRef = z.union([
  z.string().min(1),
  z.strictObject({
    tool: z.string().min(1),
    input: z.record(z.string(), z.unknown()).default({}),
  }),
]);
const SavedChainSchema = z.strictObject({
  description: z.string().max(300).optional(),
  /** Defaults for `${name}` in step inputs; `null` must be given when the chain runs. */
  vars: z.record(z.string().regex(VAR_NAME), VarValue.nullable()).default({}),
  steps: z.array(StepRef).min(1).max(MAX_CHAIN_STEPS),
});
export type SavedChain = z.infer<typeof SavedChainSchema>;

const ChainBookSchema = z.strictObject({
  chains: z.record(z.string().regex(CHAIN_NAME), SavedChainSchema).default({}),
});
export type ChainBook = z.infer<typeof ChainBookSchema>;

/** A chain file or a chain in it is unusable; nothing on the phone was touched. */
export class ChainError extends Error {
  override readonly name = "ChainError";
}

/** Reads the chain file; a missing file means no chains. */
export async function loadChains(
  path: string = chainsPath(),
): Promise<ChainBook> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { chains: {} };
    throw error;
  }
  return parseChains(raw, path);
}

export function parseChains(raw: string, source = "chain file"): ChainBook {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ChainError(`${source} is not valid JSON.`);
  }
  const result = ChainBookSchema.safeParse(json);
  if (!result.success)
    throw new ChainError(
      `Invalid ${source}:\n${z.prettifyError(result.error)}`,
    );
  return result.data;
}

/** Saved defaults overridden by `given`; every variable needs a value, and no others are allowed. */
function resolveVars(
  chain: SavedChain,
  given: Record<string, VarValue>,
): Record<string, VarValue> {
  const unknown = Object.keys(given).filter((name) => !(name in chain.vars));
  if (unknown.length > 0)
    throw new ChainError(
      `Unknown variable ${unknown.join(", ")}; this chain has: ${Object.keys(chain.vars).join(", ") || "none"}.`,
    );
  const vars: Record<string, VarValue> = {};
  for (const [name, saved] of Object.entries(chain.vars)) {
    const value = given[name] ?? saved;
    if (value === null)
      throw new ChainError(`The chain needs a value for "${name}".`);
    vars[name] = value;
  }
  return vars;
}

const WHOLE_VAR = /^\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/;
const ANY_VAR = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

/** Replaces `${name}` in strings. A string that is only `${name}` takes the value's type (e.g. a number). */
function substitute(value: unknown, vars: Record<string, VarValue>): unknown {
  const lookup = (name: string): VarValue => {
    const found = vars[name];
    if (found === undefined)
      throw new ChainError(
        `"\${${name}}" is not declared in the chain's "vars".`,
      );
    return found;
  };
  if (typeof value === "string") {
    const whole = WHOLE_VAR.exec(value)?.[1];
    if (whole !== undefined) return lookup(whole);
    return value.replace(ANY_VAR, (_, name: string) => String(lookup(name)));
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, vars));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substitute(item, vars)]),
    );
  return value;
}

/**
 * Builds every step of the saved chain `name` and checks that each starts where the one
 * before it ends: the runtime form of `chain(...).then(...)`'s compile-time check.
 */
export function planChain(
  book: ChainBook,
  name: string,
  given: Record<string, VarValue>,
  config: PhoneConfig,
  tools: readonly PhoneTool[],
): Link[] {
  const chain = book.chains[name];
  if (chain === undefined) {
    const names = Object.keys(book.chains).join(", ") || "none";
    throw new ChainError(
      `No chain "${name}" in ${chainsPath()}. Chains: ${names}.`,
    );
  }
  const vars = resolveVars(chain, given);
  const links = chain.steps.map((ref, index) =>
    linkStep(ref, index + 1, vars, config, tools),
  );
  checkPairs(links);
  return links;
}

function linkStep(
  ref: SavedChain["steps"][number],
  position: number,
  vars: Record<string, VarValue>,
  config: PhoneConfig,
  tools: readonly PhoneTool[],
): Link {
  const { tool: name, input } =
    typeof ref === "string" ? { tool: ref, input: {} } : ref;
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool?.link === undefined) {
    const steps = tools
      .filter((candidate) => candidate.link)
      .map((candidate) => candidate.name);
    throw new ChainError(
      `Step ${position}: "${name}" is not a step. Steps: ${steps.join(", ")}.`,
    );
  }
  if ("complete" in input)
    throw new ChainError(
      `Step ${position} (${name}): leave out "complete"; it is given when the chain runs.`,
    );
  try {
    return tool.link(substitute(input, vars), config);
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    throw new ChainError(
      `Step ${position} (${name}): ${z.prettifyError(error)}`,
    );
  }
}

const endOf = (link: Link) =>
  link.kind === "step" ? link.step.to.name : link.final.to.name;
const startOf = (link: Link) =>
  link.kind === "step" ? link.step.from.name : link.final.from.name;

function checkPairs(links: readonly Link[]): void {
  links.forEach((link, index) => {
    if (link.kind === "final" && index !== links.length - 1)
      throw new ChainError(
        `Step ${index + 1} (${link.tool}) is irreversible, so it must be the last step.`,
      );
    const before = links[index - 1];
    if (before === undefined || startOf(link) === "anywhere") return;
    if (startOf(link) !== endOf(before))
      throw new ChainError(
        `Step ${index} (${before.tool}) ends on ${endOf(before)}, but step ${index + 1} (${link.tool}) starts on ${startOf(link)}.`,
      );
  });
}

/** The chain's work on a leased phone, or a refusal (e.g. an amount over the limit) before it. */
export function chainWork(
  name: string,
  links: readonly Link[],
  completeFinal: boolean,
): Work | ActionOutcome {
  const refused = links.find((link) => link.refusal !== undefined);
  if (refused !== undefined)
    return blocked(`Chain "${name}"`, `${refused.tool}: ${refused.refusal}`);
  return async (deps) => {
    for (const link of links) {
      if (link.kind === "final") return finish(deps, link.final, completeFinal);
      await runStep(deps, link.step);
    }
    const last = links.at(-1);
    const end = last === undefined ? "the same screen" : endOf(last);
    return {
      status: "completed",
      summary: `Ran chain "${name}" (${links.length} steps). Now on ${end}.`,
    };
  };
}

const RunChainInput = z.object({
  name: z.string().describe("A chain saved in ~/.config/neo/chains.json"),
  vars: z
    .record(z.string(), VarValue)
    .default({})
    .describe("Values for the chain's variables; override its saved defaults"),
  complete,
});

/** `run_chain` and `list_chains` over the given step tools. */
export function chainTools(steps: readonly PhoneTool[]): PhoneTool[] {
  const runChain: PhoneTool = {
    name: "run_chain",
    title: "Run a saved chain of steps",
    description:
      "Runs a chain of steps saved in ~/.config/neo/chains.json (NEO_PHONE_CHAINS), with its variables " +
      "filled in. Every step's start and end screen is checked on the device, as when run one by one. " +
      "If the chain ends in an irreversible step, complete=false (default) stops before its tap; " +
      "complete=true asks for approval on the Mac first. See list_chains.",
    shape: RunChainInput.shape,
    prepare: async (input, { config, loadChains }) => {
      const parsed = RunChainInput.parse(input);
      try {
        const links = planChain(
          await loadChains(),
          parsed.name,
          parsed.vars,
          config,
          steps,
        );
        return chainWork(parsed.name, links, parsed.complete);
      } catch (error) {
        if (!(error instanceof ChainError)) throw error;
        return blocked(
          `Chain "${parsed.name}"`,
          `${error.message} Nothing on the phone was touched.`,
        );
      }
    },
  };
  const listChains: PhoneTool = {
    name: "list_chains",
    title: "List the saved chains",
    description:
      "Lists the chains in ~/.config/neo/chains.json: their variables, saved values and steps. Does not use the phone.",
    shape: z.object({}).shape,
    prepare: async (_input, { loadChains }) => {
      try {
        return {
          status: "completed",
          summary: describeChains(await loadChains()),
        };
      } catch (error) {
        if (!(error instanceof ChainError)) throw error;
        return blocked("List chains", error.message);
      }
    },
  };
  return [runChain, listChains];
}

function describeChains(book: ChainBook): string {
  const lines = Object.entries(book.chains).map(([name, chain]) => {
    const vars = Object.entries(chain.vars)
      .map(([key, value]) =>
        value === null
          ? `${key} (required)`
          : `${key}=${JSON.stringify(value)}`,
      )
      .join(", ");
    const steps = chain.steps.map((ref) =>
      typeof ref === "string" ? ref : ref.tool,
    );
    const about =
      chain.description === undefined ? "" : ` ${chain.description}`;
    return `${name}(${vars}):${about} [${steps.join(" → ")}]`;
  });
  return lines.length === 0
    ? `No chains in ${chainsPath()}.`
    : lines.join("\n");
}
