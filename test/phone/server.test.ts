import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Spawns the real `neo-phone` server over stdio. Ghosthand points at a socket that does not
// exist, so no call here can reach the iPhone.
describe("neo-phone MCP server", { timeout: 30_000 }, () => {
  let dir: string;
  let client: Client;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "neo-mcp-"));
    client = new Client({ name: "neo-test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: "npx",
        args: ["tsx", "src/phone/server.ts"],
        env: {
          ...(process.env as Record<string, string>),
          HOME: dir,
          NEO_PHONE_CONFIG: join(dir, "phone.json"),
        },
        stderr: "pipe",
      }),
    );
  });

  afterAll(async () => {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("lists the actions, then their steps; only irreversible ones take complete, default false", async () => {
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      "send_whatsapp_text",
      "order_water",
      "send_money",
      "book_rapido",
      "open_app",
      "phone_screen",
      "phone_reset",
      "spotlight_open",
      "spotlight_launch",
      "unlock_app",
      "whatsapp_chat_list",
      "whatsapp_open_search",
      "whatsapp_open_chat",
      "whatsapp_open_chat_by_number",
      "whatsapp_type_draft",
      "whatsapp_send",
      "cred_home",
      "cred_open_upi",
      "cred_open_pay_search",
      "cred_find_payee",
      "cred_open_payee",
      "cred_enter_amount",
      "cred_send_money",
      "rapido_home",
      "rapido_search_drop",
      "rapido_pick_vehicle",
      "rapido_book",
      "run_chain",
      "list_chains",
    ]);
    const gated = tools.filter(
      (tool) => tool.inputSchema.properties?.["complete"] !== undefined,
    );
    expect(gated.map((tool) => tool.name)).toEqual([
      "send_whatsapp_text",
      "order_water",
      "send_money",
      "book_rapido",
      "whatsapp_send",
      "cred_send_money",
      "rapido_book",
      "run_chain",
    ]);
    for (const tool of gated) {
      expect(tool.inputSchema.properties?.["complete"]).toMatchObject({
        type: "boolean",
        default: false,
      });
    }
  });

  it("describes where each step starts and ends, for chaining", async () => {
    const { tools } = await client.listTools();
    const search = tools.find((tool) => tool.name === "whatsapp_open_search");

    expect(search?.description).toMatch(
      /Starts on whatsapp\.chat_list; refuses to run elsewhere\. Ends on whatsapp\.search\./,
    );
  });

  it("rejects invalid input as a tool error", async () => {
    const result = await client.callTool({
      name: "send_money",
      arguments: { vpa: "x", payeeName: "y", amountInr: -5 },
    });

    expect(result.isError).toBe(true);
  });

  it("reports an unreachable Ghosthand daemon instead of crashing", async () => {
    const result = await client.callTool({
      name: "order_water",
      arguments: { quantity: 1 },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("daemon-unreachable");
  });
});
