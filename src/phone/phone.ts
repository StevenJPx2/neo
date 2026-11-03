import { setTimeout as delay } from "node:timers/promises";
import {
  GhosthandClient,
  GhosthandError,
  type InputOptions,
  type Point,
  type ScrollDirection,
  type ScreenText,
  type TapTarget,
} from "./ghosthand.js";

/** One leased iPhone. Every method acts on the lease taken by {@link withPhone}. */
export type Phone = {
  readText(): Promise<ScreenText>;
  screenshot(): Promise<Uint8Array>;
  tap(target: TapTarget, options?: InputOptions): Promise<void>;
  key(combo: string, options?: InputOptions): Promise<void>;
  type(text: string, options?: InputOptions): Promise<void>;
  /** Mouse-wheel ticks at `at`; scrolls lists that a drag would tap. */
  scroll(direction: ScrollDirection, ticks: number, at: Point): Promise<void>;
  /** Lets an animation finish before the next read or input. */
  pause(ms: number): Promise<void>;
};

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** Whether the Bluetooth keyboard can type `text`: printable US-ASCII only. */
export function isTypeable(text: string): boolean {
  return PRINTABLE_ASCII.test(text);
}

/** Lease the ready iPhone for `work`, then release it, even when `work` fails. */
export async function withPhone<T>(
  client: GhosthandClient,
  reason: string,
  work: (phone: Phone) => Promise<T>,
): Promise<T> {
  const status = await client.setupStatus();
  const device = status.device;
  if (!status.ready || device === undefined) {
    throw new GhosthandError(
      "not-ready",
      "The iPhone is not ready. Run `ghosthand setup status` and finish setup.",
    );
  }

  // Ghosthand turns AssistiveTouch off on release; keep it on if the user had it on.
  const keepAssistiveTouch =
    status.overview.phones.find((phone) => phone.id === device)
      ?.assistiveTouch === true;
  const lease = await client.acquire(device, reason);

  let result: T;
  try {
    result = await work(bindPhone(client, lease));
  } catch (error) {
    await client.release(lease, keepAssistiveTouch).catch(() => undefined);
    throw error;
  }
  await client.release(lease, keepAssistiveTouch);
  return result;
}

function bindPhone(client: GhosthandClient, lease: string): Phone {
  return {
    readText: () => client.screenText(lease),
    screenshot: () => client.screenshot(lease),
    tap: (target, options = {}) => client.tap(lease, target, options),
    key: (combo, options = {}) => client.key(lease, combo, options),
    type: (text, options = {}) => {
      if (!PRINTABLE_ASCII.test(text)) {
        return Promise.reject(
          new GhosthandError(
            "invalid-request",
            "The phone keyboard types US-ASCII only.",
          ),
        );
      }
      return client.type(lease, text, options);
    },
    scroll: (direction, ticks, at) =>
      client.scroll(lease, direction, ticks, at),
    pause: async (ms) => {
      await delay(ms);
    },
  };
}
