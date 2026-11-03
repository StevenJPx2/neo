import type { z } from "zod";
import {
  finish,
  type ActionDeps,
  type ActionOutcome,
  type FinalStep,
} from "./final.js";
import { runStep, type Step } from "./flow.js";

/** One action or step, exposed identically as an MCP tool and a CLI command. */
export type PhoneTool = {
  name: string;
  title: string;
  description: string;
  shape: z.ZodRawShape;
  /** Validates input before the phone is touched; returns the work to run on a leased phone. */
  prepare(input: unknown): (deps: ActionDeps) => Promise<ActionOutcome>;
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
    prepare(input) {
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

/** A single reversible step as a tool. */
export function defineStep<S extends z.ZodObject>(
  definition: Definition<S> &
    Ends & {
      step: (input: z.output<S>, deps: ActionDeps) => Step<string, string>;
      /** A reason to refuse before the phone is touched. */
      refuse?: (input: z.output<S>, deps: ActionDeps) => string | undefined;
    },
): PhoneTool {
  return defineTool({
    ...definition,
    description: definition.description + ends(definition),
    run: async (deps, input) => {
      const refusal = definition.refuse?.(input, deps);
      if (refusal !== undefined)
        return {
          status: "blocked",
          summary: definition.title,
          reason: refusal,
        };
      const step = definition.step(input, deps);
      await runStep(deps, step);
      return {
        status: "completed",
        summary: `${definition.title}. Now on ${step.to.name}.`,
      };
    },
  });
}

/** An irreversible step as a tool: `input.complete` and the Mac approval gate it. */
export function defineFinal<S extends z.ZodObject>(
  definition: Definition<S> &
    Ends & {
      final: (
        input: z.output<S>,
        deps: ActionDeps,
      ) => FinalStep<string, string>;
      complete: (input: z.output<S>) => boolean;
      refuse?: (input: z.output<S>, deps: ActionDeps) => string | undefined;
    },
): PhoneTool {
  return defineTool({
    ...definition,
    description: definition.description + ends(definition),
    run: async (deps, input) => {
      const final = definition.final(input, deps);
      const refusal = definition.refuse?.(input, deps);
      if (refusal !== undefined)
        return { status: "blocked", summary: final.summary, reason: refusal };
      return finish(deps, final, definition.complete(input));
    },
  });
}
