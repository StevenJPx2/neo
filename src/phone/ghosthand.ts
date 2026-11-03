import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const DEFAULT_SOCKET_PATH = join(homedir(), ".ghosthand", "daemon.sock");
// Ghosthand can wait up to 60 s for `waitText` after an input; leave headroom for the input.
const REQUEST_TIMEOUT_MS = 90_000;

const LineSchema = z.object({
  text: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  confidence: z.number(),
});
const ScreenTextSchema = z.object({
  width: z.number(),
  height: z.number(),
  lines: z.array(LineSchema),
});
export type ScreenLine = z.infer<typeof LineSchema>;
export type ScreenText = z.infer<typeof ScreenTextSchema>;

const LeaseIdSchema = z.string().regex(/^([a-z0-9-]+:)?[1-9][0-9]*$/);
const LeaseSchema = z.object({ id: LeaseIdSchema });
const ProblemSchema = z.object({ code: z.string(), detail: z.string() });
const ActionSchema = z.object({ message: z.string() });
const SetupSchema = z.object({
  ready: z.boolean(),
  device: z.string().optional(),
  overview: z.object({
    phones: z.array(
      z.object({ id: z.string(), assistiveTouch: z.boolean().optional() }),
    ),
  }),
});
export type SetupStatus = z.infer<typeof SetupSchema>;

export type TapTarget =
  { text: string; index?: number } | { x: number; y: number };
export type Point = { x: number; y: number };
/** `up` shows content further up, like pulling a list down with a finger. */
export type ScrollDirection = "up" | "down" | "left" | "right";
export type InputOptions = { waitText?: string; timeoutMs?: number };

export class GhosthandError extends Error {
  override readonly name = "GhosthandError";

  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

type Reply = { status: number; body: Buffer };

/** Client for the Ghosthand daemon's HTTP API on its local unix socket. */
export class GhosthandClient {
  constructor(private readonly socketPath: string = DEFAULT_SOCKET_PATH) {}

  async setupStatus(): Promise<SetupStatus> {
    return SetupSchema.parse(await this.json("GET", "/v1/setup/status"));
  }

  async acquire(device: string, reason: string): Promise<string> {
    const body = {
      device,
      reason,
      label: "neo-phone",
      idleTimeoutSeconds: 180,
    };
    return LeaseSchema.parse(await this.json("POST", "/v1/leases", body)).id;
  }

  async release(lease: string, keepAssistiveTouch: boolean): Promise<void> {
    await this.json(
      "DELETE",
      `${leasePath(lease)}?keepAssistiveTouch=${keepAssistiveTouch}`,
    );
  }

  async screenText(lease: string): Promise<ScreenText> {
    return ScreenTextSchema.parse(
      await this.json("GET", `${leasePath(lease)}/text?settle=true`),
    );
  }

  async screenshot(lease: string): Promise<Buffer> {
    return (
      await this.send("GET", `${leasePath(lease)}/screenshot?settle=true`)
    ).body;
  }

  async tap(
    lease: string,
    target: TapTarget,
    options: InputOptions = {},
  ): Promise<void> {
    await this.input(lease, "tap", target, options);
  }

  async key(
    lease: string,
    key: string,
    options: InputOptions = {},
  ): Promise<void> {
    await this.input(lease, "key", { key }, options);
  }

  async type(
    lease: string,
    text: string,
    options: InputOptions = {},
  ): Promise<void> {
    await this.input(lease, "type", { text }, options);
  }

  async scroll(
    lease: string,
    direction: ScrollDirection,
    ticks: number,
    at: Point,
  ): Promise<void> {
    await this.input(lease, "scroll", { direction, ticks, at }, {});
  }

  private async input(
    lease: string,
    action: "tap" | "key" | "type" | "scroll",
    body: object,
    options: InputOptions,
  ): Promise<void> {
    const query = new URLSearchParams();
    if (options.waitText !== undefined) query.set("waitText", options.waitText);
    if (options.timeoutMs !== undefined)
      query.set("timeoutMs", String(options.timeoutMs));
    const suffix = query.size > 0 ? `?${query.toString()}` : "";

    ActionSchema.parse(
      await this.json("POST", `${leasePath(lease)}/${action}${suffix}`, body),
    );
  }

  private async json(
    method: string,
    path: string,
    body?: object,
  ): Promise<unknown> {
    const reply = await this.send(method, path, body);
    return JSON.parse(reply.body.toString("utf8"));
  }

  private send(method: string, path: string, body?: object): Promise<Reply> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> =
      payload === undefined ? {} : { "content-type": "application/json" };

    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers,
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => {
            const reply = {
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks),
            };
            if (reply.status >= 200 && reply.status < 300) resolve(reply);
            else reject(problemFrom(reply));
          });
        },
      );
      req.on("timeout", () => {
        req.destroy(
          new GhosthandError(
            "timeout",
            `${method} ${path} took over ${REQUEST_TIMEOUT_MS} ms`,
          ),
        );
      });
      req.on("error", (error) => reject(connectionError(error)));
      req.end(payload);
    });
  }
}

function leasePath(lease: string): string {
  return `/v1/leases/${LeaseIdSchema.parse(lease)}`;
}

function problemFrom(reply: Reply): GhosthandError {
  const text = reply.body.toString("utf8");
  try {
    const problem = ProblemSchema.parse(JSON.parse(text));
    return new GhosthandError(problem.code, problem.detail);
  } catch {
    return new GhosthandError(`http-${reply.status}`, text.slice(0, 300));
  }
}

function connectionError(error: Error): Error {
  if (error instanceof GhosthandError) return error;
  return new GhosthandError(
    "daemon-unreachable",
    `${error.message}. Is the Ghosthand daemon running? Try \`ghosthand daemon start\`.`,
  );
}
