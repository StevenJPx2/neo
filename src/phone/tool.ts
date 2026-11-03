import type { z } from "zod";
import type { ChainBook } from "./chains.js";
import type { PhoneConfig } from "./config.js";
import {
  finish,
  type ActionDeps,
  type ActionOutcome,
  type FinalStep,
} from "./final.js";
import {
  runStep,
  type Reading,
  type ReadValue,
  type Step,
  type StepContext,
} from "./flow.js";

/** The work a tool does on a leased phone. */
export type Work = (deps: ActionDeps) => Promise<ActionOutcome>;

/** What a tool may read before the phone is leased. */
export type Setup = {
  config: PhoneConfig;
  loadChains: () => Promise<ChainBook>;
};

/** A step tool built from its input, ready to pair in a chain. */
export type Link =
  | {
      kind: "step";
      tool: string;
      step: Step<string, string>;
      refusal: string | undefined;
    }
  | {
      kind: "final";
      tool: string;
      final: FinalStep<string, string>;
      refusal: string | undefined;
    }
  | {
      /** Reads a value off the screen; a chain can save it into a variable for later steps. */
      kind: "read";
      tool: string;
      step: Step<string, string>;
      read: (context: StepContext) => Promise<ReadValue>;
      refusal: string | undefined;
    };

/** One action or step, exposed identically as an MCP tool and a CLI command. */
export type PhoneTool = {
  name: string;
  title: string;
  description: string;
  shape: z.ZodRawShape;
  /**
   * Validates input before the phone is touched. Returns the work to run on a leased
   * phone, or an outcome that needs no phone (a refusal, a listing).
   */
  prepare(input: unknown, setup: Setup): Promise<Work | ActionOutcome>;
  /** Steps only: builds the step from its input, for chains. */
  link?: (input: unknown, config: PhoneConfig) => Link;
};

type Definition<S extends z.ZodObject> = {
  name: string;
  title: string;
  description: string;
  input: S;
};

export function defineTool<S extends z.ZodObject>(
  definition: Definition<S> & {
    run: (deps: ActionDeps, input: z.output<S>) => Promise<ActionOutcome>;
  },
): PhoneTool {
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    shape: definition.input.shape,
    prepare: async (input) => {
      const parsed = definition.input.parse(input);
      return (deps) => definition.run(deps, parsed);
    },
  };
}

type Ends = {
  /** Screen names, for agents chaining steps: run a step only where the last one ended. */
  from: string;
  to: string;
};

const ends = ({ from, to }: Ends) =>
  ` Starts on ${from}; refuses to run elsewhere. Ends on ${to}.`;

/** A reason to refuse before the phone is touched, e.g. an amount over the limit. */
type Refuse<S extends z.ZodObject> = (
  input: z.output<S>,
  config: PhoneConfig,
) => string | undefined;

/** A single reversible step as a tool. */
export function defineStep<S extends z.ZodObject>(
  definition: Definition<S> &
    Ends & {
      step: (input: z.output<S>, config: PhoneConfig) => Step<string, string>;
      refuse?: Refuse<S>;
    },
): PhoneTool {
  const link = (input: unknown, config: PhoneConfig) => {
    const parsed = definition.input.parse(input);
    return {
      kind: "step" as const,
      tool: definition.name,
      step: definition.step(parsed, config),
      refusal: definition.refuse?.(parsed, config),
    };
  };
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description + ends(definition),
    shape: definition.input.shape,
    link,
    prepare: async (input, { config }) => {
      const { step, refusal } = link(input, config);
      if (refusal !== undefined)
        return {
          status: "blocked",
          summary: definition.title,
          reason: refusal,
        };
      return async (deps) => {
        await runStep(deps, step);
        return {
          status: "completed",
          summary: `${definition.title}. Now on ${step.to.name}.`,
        };
      };
    },
  };
}

/** An irreversible step as a tool: `complete` and the Mac approval gate it. */
export function defineFinal<S extends z.ZodObject>(
  definition: Definition<S> &
    Ends & {
      final: (
        input: z.output<S>,
        config: PhoneConfig,
      ) => FinalStep<string, string>;
      complete: (input: z.output<S>) => boolean;
      refuse?: Refuse<S>;
    },
): PhoneTool {
  const build = (input: unknown, config: PhoneConfig) => {
    const parsed = definition.input.parse(input);
    const link = {
      kind: "final" as const,
      tool: definition.name,
      final: definition.final(parsed, config),
      refusal: definition.refuse?.(parsed, config),
    };
    return { parsed, link };
  };
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description + ends(definition),
    shape: definition.input.shape,
    link: (input, config) => build(input, config).link,
    prepare: async (input, { config }) => {
      const { parsed, link } = build(input, config);
      if (link.refusal !== undefined)
        return {
          status: "blocked",
          summary: link.final.summary,
          reason: link.refusal,
        };
      return (deps) => finish(deps, link.final, definition.complete(parsed));
    },
  };
}

/** A reader step as a tool: runs the step, then reports the value it read. */
export function defineReader<S extends z.ZodObject>(
  definition: Definition<S> &
    Ends & {
      reading: (
        input: z.output<S>,
        config: PhoneConfig,
      ) => Reading<string, string>;
      refuse?: Refuse<S>;
    },
): PhoneTool {
  const link = (input: unknown, config: PhoneConfig) => {
    const parsed = definition.input.parse(input);
    const { step, read } = definition.reading(parsed, config);
    return {
      kind: "read" as const,
      tool: definition.name,
      step,
      read,
      refusal: definition.refuse?.(parsed, config),
    };
  };
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description + ends(definition),
    shape: definition.input.shape,
    link,
    prepare: async (input, { config }) => {
      const { step, read, refusal } = link(input, config);
      if (refusal !== undefined)
        return {
          status: "blocked",
          summary: definition.title,
          reason: refusal,
        };
      return async (deps) => {
        await runStep(deps, step);
        const value = await read(deps);
        return {
          status: "completed",
          summary: `${definition.title}: ${String(value)}. Now on ${step.to.name}.`,
        };
      };
    },
  };
}
