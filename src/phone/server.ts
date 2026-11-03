import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defaultRuntime, PHONE_TOOLS, runPhoneTool } from "./tools.js";

// stdio transport: stdout carries JSON-RPC only, so nothing here may log to stdout.
const server = new McpServer({ name: "neo-phone", version: "0.1.0" });
const runtime = defaultRuntime();

for (const tool of PHONE_TOOLS) {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.shape,
    },
    async (input) => {
      try {
        const outcome = await runPhoneTool(tool, input, runtime);
        return {
          content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }],
          isError: outcome.status === "blocked",
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `${tool.name} failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}

await server.connect(new StdioServerTransport());
