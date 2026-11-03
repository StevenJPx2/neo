import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { complete } from "./actions.js";
import type { PhoneConfig } from "./config.js";
import {
  blocked,
  finish,
  type ActionDeps,
  type ActionOutcome,
} from "./final.js";
import { runStep } from "./flow.js";
import { NavigationError } from "./navigation.js";
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

/** Personal chains (addresses, payees) beside the shared file, kept out of git: chains.local.json. */
export function localChainsPath(path: string = chainsPath()): string {
  return path.replace(/\.json$/, "") + ".local.json";
}

const CHAIN_NAME = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const VAR_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,30}$/;
const MAX_CHAIN_STEPS = 30;

const VarValue = z.union([z.string().max(1_000), z.number(), z.boolean()]);
export type VarValue = z.infer<typeof VarValue>;
type Vars = Record<string, VarValue>;

const StepRef = z.union([
  z.string().min(1),
  z.strictObject({
    tool: z.string().min(1),
    input: z.record(z.string(), z.unknown()).default({}),
    /** Reader steps only: the variable that takes the value read, for the steps after it. */
    save: z.string().regex(VAR_NAME).optional(),
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

/** Reads the shared chain file and the personal one beside it; missing files mean no chains. */
export async function loadChains(
  path: string = chainsPath(),
): Promise<ChainBook> {
  const shared = await readBook(path);
  const local = await readBook(localChainsPath(path));
  const both = Object.keys(shared.chains).filter(
    (name) => name in local.chains,
  );
  if (both.length > 0)
    throw new ChainError(
      `Chains defined in both ${path} and ${localChainsPath(path)}: ${both.join(", ")}.`,
    );
  return { chains: { ...shared.chains, ...local.chains } };
}

async function readBook(path: string): Promise<ChainBook> {
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
function resolveVars(chain: SavedChain, given: Vars): Vars {
  const unknown = Object.keys(given).filter((name) => !(name in chain.vars));
  if (unknown.length > 0)
    throw new ChainError(
      `Unknown variable ${unknown.join(", ")}; this chain has: ${Object.keys(chain.vars).join(", ") || "none"}.`,
    );
  const vars: Vars = {};
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
function substitute(value: unknown, vars: Vars): unknown {
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

/** A checked chain, ready to run. `relink` rebuilds its steps after a reader saves a value. */
export type ChainPlan = {
  name: string;
  links: Link[];
  vars: Vars;
  /** Per step: the variable a reader step saves into. */
  saves: (string | undefined)[];
  relink: (vars: Vars) => Link[];
};

/**
 * Builds every step of the saved chain `name` and checks that each starts where the one
 * before it ends: the runtime form of `chain(...).then(...)`'s compile-time check.
 */
export function planChain(
  book: ChainBook,
  name: string,
  given: Vars,
  config: PhoneConfig,
  tools: readonly PhoneTool[],
): ChainPlan {
  const chain = book.chains[name];
  if (chain === undefined) {
    const names = Object.keys(book.chains).join(", ") || "none";
    throw new ChainError(
      `No chain "${name}" in ${chainsPath()}. Chains: ${names}.`,
    );
  }
  const vars = resolveVars(chain, given);
  const relink = (current: Vars) =>
    chain.steps.map((ref, index) =>
      linkStep(ref, index + 1, current, config, tools),
    );
  const links = relink(vars);
  const saves = chain.steps.map((ref) =>
    typeof ref === "string" ? undefined : ref.save,
  );
  checkSaves(links, saves, chain);
  checkPairs(links);
  return { name, links, vars, saves, relink };
}

function linkStep(
  ref: SavedChain["steps"][number],
  position: number,
  vars: Vars,
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

/** Only reader steps save, into a declared variable whose saved value stands in until the read. */
function checkSaves(
  links: readonly Link[],
  saves: readonly (string | undefined)[],
  chain: SavedChain,
): void {
  saves.forEach((save, index) => {
    const link = links[index];
    if (save === undefined || link === undefined) return;
    if (link.kind !== "read")
      throw new ChainError(
        `Step ${index + 1} (${link.tool}) reads nothing, so it cannot "save".`,
      );
    if (chain.vars[save] === undefined || chain.vars[save] === null)
      throw new ChainError(
        `Step ${index + 1} saves into "${save}": declare it in "vars" with an expected value, used to check the chain before it runs.`,
      );
  });
}

const endOf = (link: Link) =>
  link.kind === "final" ? link.final.to.name : link.step.to.name;
const startOf = (link: Link) =>
  link.kind === "final" ? link.final.from.name : link.step.from.name;

function checkPairs(links: readonly Link[]): void {
  links.forEach((link, index) => {
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
  plan: ChainPlan,
  completeFinals: boolean,
): Work | ActionOutcome {
  const refused = plan.links.find((link) => link.refusal !== undefined);
  if (refused !== undefined)
    return blocked(
      `Chain "${plan.name}"`,
      `${refused.tool}: ${refused.refusal}`,
    );
  return async (deps) => {
    const progress = new Progress(plan.name);
    try {
      return await runLinks(deps, plan, completeFinals, progress);
    } catch (error) {
      if (!(error instanceof NavigationError || error instanceof ChainError))
        throw error;
      return progress.stopped(error.message);
    }
  };
}

/** What a running chain has done, for its outcome: values read and irreversible steps made. */
class Progress {
  readonly done: string[] = [];
  constructor(private readonly name: string) {}

  /** An outcome that stopped the chain, saying what already happened before it. */
  with(outcome: ActionOutcome): ActionOutcome {
    if (this.done.length === 0) return outcome;
    return {
      ...outcome,
      summary: `${outcome.summary} (chain "${this.name}", after: ${this.done.join("; ")})`,
    };
  }

  stopped(reason: string): ActionOutcome {
    const done =
      this.done.length === 0
        ? "No irreversible step was made."
        : `Done before this: ${this.done.join("; ")}.`;
    return blocked(`Chain "${this.name}"`, `${reason} ${done}`);
  }
}

async function runLinks(
  deps: ActionDeps,
  plan: ChainPlan,
  completeFinals: boolean,
  progress: Progress,
): Promise<ActionOutcome> {
  let links = plan.links;
  let vars = plan.vars;
  for (let index = 0; index < links.length; index += 1) {
    const link = links[index];
    if (link === undefined) break;
    if (link.refusal !== undefined)
      return progress.stopped(`${link.tool}: ${link.refusal}`);
    if (link.kind === "final") {
      const outcome = await finish(deps, link.final, completeFinals);
      if (outcome.status !== "completed") return progress.with(outcome);
      progress.done.push(outcome.summary);
      continue;
    }
    await runStep(deps, link.step);
    if (link.kind !== "read") continue;
    const save = plan.saves[index];
    const value = await link.read(deps);
    progress.done.push(
      `read ${String(value)}${save === undefined ? "" : ` into ${save}`}`,
    );
    if (save === undefined) continue;
    vars = { ...vars, [save]: value };
    links = plan.relink(vars);
  }
  const end = links.at(-1);
  return {
    status: "completed",
    summary:
      `Ran chain "${plan.name}" (${links.length} steps). Now on ${end === undefined ? "the same screen" : endOf(end)}. ${progress.done.join("; ")}`.trim(),
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
      "Runs a chain of steps saved in ~/.config/neo/chains.json or chains.local.json (NEO_PHONE_CHAINS), " +
      "with its variables filled in. Every step's start and end screen is checked on the device, as when run one by one. " +
      "complete=false (default) stops before the chain's first irreversible step; complete=true asks for approval " +
      "on the Mac before each irreversible step. See list_chains.",
    shape: RunChainInput.shape,
    prepare: async (input, { config, loadChains }) => {
      const parsed = RunChainInput.parse(input);
      try {
        const plan = planChain(
          await loadChains(),
          parsed.name,
          parsed.vars,
          config,
          steps,
        );
        return chainWork(plan, parsed.complete);
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
      "Lists the chains in ~/.config/neo/chains.json and chains.local.json: their variables, saved values and steps. Does not use the phone.",
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
      typeof ref === "string"
        ? ref
        : ref.save === undefined
          ? ref.tool
          : `${ref.tool}→${ref.save}`,
    );
    const about =
      chain.description === undefined ? "" : ` ${chain.description}`;
    return `${name}(${vars}):${about} [${steps.join(" → ")}]`;
  });
  return lines.length === 0
    ? `No chains in ${chainsPath()}.`
    : lines.join("\n");
}
