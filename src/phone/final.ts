import type { Approver } from "./approval.js";
import type { PhoneConfig } from "./config.js";
import { runStep, type Screen, type Step, type StepContext } from "./flow.js";
import type { Phone } from "./phone.js";
import { verifyEventually, verifyScreen, type ScreenCheck } from "./verify.js";

export type ActionOutcome =
  /** `complete: false`: everything is filled in; the last tap was not made. */
  | { status: "staged"; summary: string }
  | { status: "completed"; summary: string; next?: string }
  /** `complete: true`, but the person at the Mac rejected it or did not answer. */
  | { status: "declined"; summary: string; decision: "rejected" | "timed_out" }
  /** A check failed; `reason` says whether the final tap was made. */
  | { status: "blocked"; summary: string; reason: string };

export type ActionDeps = StepContext & {
  approve: Approver;
  config: PhoneConfig;
};

/**
 * The one irreversible tap of an action (send, pay, book). It pairs after a step that ends
 * on `from`, and runs only through {@link finish}: checks, approval, re-check, tap, confirm.
 */
export type FinalStep<From extends string, To extends string> = {
  readonly name: string;
  readonly from: Screen<From>;
  readonly to: Screen<To>;
  /** Shown in the approval dialog; names the exact recipient and amount. */
  readonly summary: string;
  readonly ready: ScreenCheck;
  readonly press: (phone: Phone) => Promise<void>;
  readonly done: ScreenCheck;
  /** What is left to the user afterwards, e.g. the UPI PIN. */
  readonly next?: string;
};

export function blocked(summary: string, reason: string): ActionOutcome {
  return { status: "blocked", summary, reason };
}

/** Runs `route`, then the final step paired after it. */
export async function perform<To extends string>(
  deps: ActionDeps,
  route: Step<string, To>,
  final: FinalStep<NoInfer<To>, string>,
  complete: boolean,
): Promise<ActionOutcome> {
  await runStep(deps, route);
  return finish(deps, final, complete);
}

/** Verify, stop or get approval, re-verify, final tap, confirm the result. Never retried. */
export async function finish(
  deps: ActionDeps,
  final: FinalStep<string, string>,
  complete: boolean,
): Promise<ActionOutcome> {
  const { phone, judge } = deps;
  const { summary } = final;
  if (!final.from.shows(await phone.readText())) {
    return blocked(
      summary,
      `Stopped before the final tap: ${final.name} starts on ${final.from.description}, which is not showing.`,
    );
  }
  const ready = await verifyScreen(phone, judge, final.ready);
  if (!ready.ok)
    return blocked(summary, `Stopped before the final tap. ${ready.reason}`);
  if (!complete) return { status: "staged", summary };

  const decision = await deps.approve(summary);
  if (decision !== "approved") return { status: "declined", summary, decision };

  // The approval can take minutes; the screen must still be the one that was approved.
  const stillReady = await verifyScreen(phone, judge, final.ready);
  if (!stillReady.ok || !final.from.shows(await phone.readText())) {
    const reason = stillReady.ok ? "" : ` ${stillReady.reason}`;
    return blocked(
      summary,
      `The screen changed while waiting for approval.${reason}`,
    );
  }

  await final.press(phone);
  const done = await verifyEventually(phone, judge, final.done);
  if (!done.ok || !final.to.shows(await phone.readText())) {
    const reason = done.ok
      ? `${final.to.description} is not showing.`
      : done.reason;
    return blocked(
      summary,
      `The final tap was made, but the result is unconfirmed: ${reason} Check the iPhone before retrying.`,
    );
  }
  return final.next === undefined
    ? { status: "completed", summary }
    : { status: "completed", summary, next: final.next };
}
