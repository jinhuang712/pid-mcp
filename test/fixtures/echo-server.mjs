// A tiny stdio MCP server for tests: three tools, one of them noisy, one that errors.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo-fixture", version: "1.0.0" }, { instructions: "Fixture server for pid-mcp tests." });

server.registerTool(
  "echo",
  { description: "Echo the given text back", inputSchema: { text: z.string().describe("Text to echo") } },
  async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
);

server.registerTool(
  "search_issues",
  { description: "Search issues in a repository", inputSchema: { query: z.string(), limit: z.number().optional() } },
  async ({ query, limit }) => ({
    content: [{ type: "text", text: JSON.stringify({ query, limit: limit ?? 10, items: [] }) }],
    structuredContent: { query, items: [] },
  }),
);

server.registerTool(
  "always_fails",
  { description: "Returns an MCP-level error", inputSchema: {} },
  async () => ({ isError: true, content: [{ type: "text", text: "nope" }] }),
);

const big = "line\n".repeat(5000);
server.registerTool("big_output", { description: "Emit a large text block", inputSchema: {} }, async () => ({
  content: [{ type: "text", text: big }],
}));

if (process.env.ECHO_FIXTURE_FAIL_START === "1") {
  process.stderr.write("fixture refusing to start\n");
  process.exit(3);
}

await server.connect(new StdioServerTransport());
