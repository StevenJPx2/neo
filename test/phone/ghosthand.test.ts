import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GhosthandClient, GhosthandError } from "../../src/phone/ghosthand.js";
import { withPhone } from "../../src/phone/phone.js";

type Seen = { method: string; url: string; body: string };

/** A stand-in Ghosthand daemon on a real unix socket, answering like the documented API. */
async function startDaemon(
  dir: string,
  seen: Seen[],
  leased: boolean,
): Promise<Server> {
  const server = createServer(async (req, res) => {
    const body = await read(req);
    seen.push({ method: req.method ?? "", url: req.url ?? "", body });
    const send = (status: number, payload: object) => {
      res.writeHead(status, {
        "content-type":
          status >= 400 ? "application/problem+json" : "application/json",
      });
      res.end(JSON.stringify(payload));
    };

    if (req.url === "/v1/setup/status") {
      return send(200, {
        ready: true,
        device: "USB-1",
        overview: { phones: [{ id: "USB-1", assistiveTouch: true }] },
      });
    }
    if (req.url === "/v1/leases" && leased) {
      return send(409, {
        code: "device-leased",
        title: "busy",
        status: 409,
        detail: "held by ses_9",
      });
    }
    if (req.url === "/v1/leases") return send(201, { id: "7" });
    if (req.url?.startsWith("/v1/leases/7/text"))
      return send(200, { width: 402, height: 874, lines: [] });
    if (req.method === "POST") return send(200, { message: "ok", logs: [] });
    if (req.method === "DELETE")
      return send(200, { message: "released lease 7" });
    return send(404, {
      code: "not-found",
      title: "no",
      status: 404,
      detail: req.url ?? "",
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(join(dir, "daemon.sock"), resolve),
  );
  return server;
}

async function read(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

describe("GhosthandClient over a unix socket", () => {
  let dir: string;
  let server: Server | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "neo-gh-"));
  });

  afterEach(async () => {
    await new Promise(
      (resolve) => server?.close(resolve) ?? resolve(undefined),
    );
    await rm(dir, { recursive: true, force: true });
  });

  it("leases, sends input with waitText, and releases keeping AssistiveTouch", async () => {
    const seen: Seen[] = [];
    server = await startDaemon(dir, seen, false);
    const client = new GhosthandClient(join(dir, "daemon.sock"));

    await withPhone(client, "test", async (phone) => {
      await phone.tap(
        { text: "Pay" },
        { waitText: "UPI PIN", timeoutMs: 5000 },
      );
      await phone.readText();
    });

    expect(seen.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET /v1/setup/status",
      "POST /v1/leases",
      "POST /v1/leases/7/tap?waitText=UPI+PIN&timeoutMs=5000",
      "GET /v1/leases/7/text?settle=true",
      "DELETE /v1/leases/7?keepAssistiveTouch=true",
    ]);
    expect(JSON.parse(seen[1]?.body ?? "{}")).toMatchObject({
      device: "USB-1",
      reason: "test",
    });
  });

  it("releases the lease when the work fails, and rejects non-ASCII typing", async () => {
    const seen: Seen[] = [];
    server = await startDaemon(dir, seen, false);
    const client = new GhosthandClient(join(dir, "daemon.sock"));

    await expect(
      withPhone(client, "test", (phone) => phone.type("₹40")),
    ).rejects.toThrow(/US-ASCII/);
    expect(seen.at(-1)?.method).toBe("DELETE");
  });

  it("turns problem responses into GhosthandError codes", async () => {
    server = await startDaemon(dir, [], true);
    const client = new GhosthandClient(join(dir, "daemon.sock"));

    const error = await client
      .acquire("USB-1", "test")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GhosthandError);
    expect(error).toMatchObject({ code: "device-leased" });
  });

  it("reports a missing daemon clearly", async () => {
    const client = new GhosthandClient(join(dir, "missing.sock"));
    await expect(client.setupStatus()).rejects.toMatchObject({
      code: "daemon-unreachable",
    });
  });
});
