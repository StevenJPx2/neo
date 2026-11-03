import type { ScreenText } from "./ghosthand.js";
import {
  DEFAULT_WAIT,
  NavigationError,
  waitFor,
  type WaitLimits,
} from "./navigation.js";
import type { Phone } from "./phone.js";
import { classifyLock, type PasscodeSource } from "./unlock.js";
import type { Judge } from "./verify.js";

/** A screen neo recognizes from OCR. Steps pair on `name`; `shows` is checked on the device. */
export type Screen<Name extends string> = {
  readonly name: Name;
  readonly description: string;
  readonly shows: (screen: ScreenText) => boolean;
};

export type Anywhere = "anywhere";
export const ANYWHERE: Screen<Anywhere> = {
  name: "anywhere",
  description: "any screen",
  shows: () => true,
};

/** `S`, possibly hidden behind its app's Face ID lock; only an unlock step leads on from it. */
export type MaybeLocked<S extends string> = `${S}?locked`;

export function maybeLocked<S extends string>(
  screen: Screen<S>,
  appName: string,
): Screen<MaybeLocked<S>> {
  return {
    name: `${screen.name}?locked`,
    description: `${screen.description}, possibly behind ${appName}'s Face ID lock`,
    shows: (text) =>
      classifyLock(text, appName).kind !== "open" || screen.shows(text),
  };
}

/** What a step may use. Irreversible steps are not `Step`s; see final.ts. */
export type StepContext = {
  phone: Phone;
  judge: Judge;
  passcode: PasscodeSource;
};

/** One fixed move: runs only when `from` shows, and must leave `to` showing. */
export type Step<From extends string, To extends string> = {
  readonly name: string;
  readonly from: Screen<From>;
  readonly to: Screen<To>;
  readonly act: (context: StepContext) => Promise<void>;
  /** How long `to` may take to show after `act`. */
  readonly arrival?: WaitLimits;
};
type AnyStep = Step<string, string>;

export type ReadValue = string | number;

/** A step that, once it has run, reads a value off the screen (e.g. an amount in a reply). */
export type Reading<From extends string, To extends string> = {
  step: Step<From, To>;
  read: (context: StepContext) => Promise<ReadValue>;
};

/** Steps paired end to start. `then` accepts only a step that starts where the chain ends. */
export type Chain<From extends string, To extends string> = Step<From, To> & {
  readonly steps: readonly AnyStep[];
  then<Next extends string>(next: Step<To | Anywhere, Next>): Chain<From, Next>;
};

export function chain<From extends string, To extends string>(
  first: Step<From, To>,
): Chain<From, To> {
  return build(first.from, first.to, stepsOf(first));
}

function build<From extends string, To extends string>(
  from: Screen<From>,
  to: Screen<To>,
  steps: readonly AnyStep[],
): Chain<From, To> {
  return {
    name: steps.map((step) => step.name).join(" → "),
    from,
    to,
    steps,
    act: async (context) => {
      for (const step of steps) await runOne(context, step);
    },
    then: (next) => build(from, next.to, [...steps, ...stepsOf(next)]),
  };
}

function stepsOf(step: AnyStep): readonly AnyStep[] {
  return "steps" in step && Array.isArray(step.steps) ? step.steps : [step];
}

/** The phone is not on the screen a step starts on, or a step did not reach its end screen. */
export class WrongScreenError extends NavigationError {
  override readonly name = "WrongScreenError";
}

/** Runs a step or a chain, checking every start and end screen on the device. */
export async function runStep(
  context: StepContext,
  step: AnyStep,
): Promise<void> {
  for (const one of stepsOf(step)) await runOne(context, one);
}

async function runOne(context: StepContext, step: AnyStep): Promise<void> {
  if (!step.from.shows(await context.phone.readText())) {
    throw new WrongScreenError(
      `${step.name} starts on ${step.from.description} (${step.from.name}), which is not showing.`,
    );
  }
  await step.act(context);
  await arrive(context.phone, step.to, step.name, step.arrival);
}

export async function arrive(
  phone: Phone,
  screen: Screen<string>,
  stepName: string,
  limits: WaitLimits = DEFAULT_WAIT,
): Promise<ScreenText> {
  try {
    return await waitFor(
      phone,
      (text) => (screen.shows(text) ? text : undefined),
      screen.description,
      limits,
    );
  } catch (error) {
    if (!(error instanceof NavigationError)) throw error;
    throw new WrongScreenError(
      `${stepName} did not reach ${screen.description} (${screen.name}).`,
    );
  }
}
