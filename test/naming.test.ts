import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_TOOL_NAME_LENGTH, formatToolName, serverPrefix } from "../src/naming.ts";

test("default prefix is the sanitized server name", () => {
  assert.equal(formatToolName("query_log", "klook-engine", "server"), "klook-engine_query_log");
  assert.equal(formatToolName("search.issues", "github", "server"), "github_search_issues");
});

test("prefix modes", () => {
  assert.equal(formatToolName("query_log", "klook-engine", "none"), "query_log");
  assert.equal(formatToolName("q", "github-mcp", "short"), "github_q");
  assert.equal(formatToolName("q", "mcp", "short"), "mcp_q");
  assert.equal(formatToolName("q", "github", "mcp"), "mcp__github_q");
});

test("unsafe characters are hex-escaped, never dropped", () => {
  assert.equal(serverPrefix("my server", "server"), "my_20_server");
  assert.notEqual(serverPrefix("a b", "server"), serverPrefix("a-b", "server"));
});

test("long names are truncated with a stable hash tag", () => {
  const long = formatToolName("x".repeat(80), "server", "server");
  assert.ok(long.length <= MAX_TOOL_NAME_LENGTH);
  assert.equal(long, formatToolName("x".repeat(80), "server", "server"));
  assert.notEqual(long, formatToolName("x".repeat(81), "server", "server"));
});
