import assert from "node:assert/strict";
import { test } from "node:test";
import { LexicalRanker, tokenize } from "../src/ranking.ts";
import type { CatalogTool } from "../src/types.ts";

const tool = (serverName: string, originalName: string, description: string): CatalogTool => ({
  serverName,
  originalName,
  piToolName: `${serverName}_${originalName}`,
  description,
  keywords: [],
  pinned: false,
});

const catalog: CatalogTool[] = [
  tool("klook-engine", "query_log", "Query service logs from LogQuery for prod, stage or fat"),
  tool("klook-engine", "monitor_rpc", "gRPC latency and error-rate panels for a service"),
  tool("klook-engine", "lookup_db_account", "Find MySQL accounts and permissions for a database"),
  tool("github", "search_issues", "Search GitHub issues across repositories"),
  tool("github", "get_issue", "Get one GitHub issue by number"),
  tool("github", "create_pull_request", "Open a pull request"),
  tool("serena", "find_symbol", "Find code symbols by name path"),
];

const ranker = new LexicalRanker();

test("tokenize splits snake, kebab, dots and camelCase", () => {
  assert.deepEqual(tokenize("getIssueComments"), ["get", "issue", "comments", "getissuecomments"]);
  assert.deepEqual(tokenize("klook-engine.query_log"), ["klook", "engine", "query", "log"]);
  assert.ok(tokenize("gRPC latency").includes("grpc"));
});

test("natural-language query finds the right github tools first", () => {
  const top = ranker.rank("search github issues", catalog, 3).map((r) => r.tool.piToolName);
  assert.equal(top[0], "github_search_issues");
  assert.ok(top.includes("github_get_issue"));
  assert.ok(!top.includes("serena_find_symbol"));
});

test("abbreviations in tool names are reachable via synonyms", () => {
  const top = ranker.rank("database account", catalog, 2).map((r) => r.tool.piToolName);
  assert.equal(top[0], "klook-engine_lookup_db_account");
  const rpc = ranker.rank("grpc latency", catalog, 1).map((r) => r.tool.piToolName);
  assert.equal(rpc[0], "klook-engine_monitor_rpc");
});

test("exact tool name wins outright", () => {
  const top = ranker.rank("query_log", catalog, 1);
  assert.equal(top[0]?.tool.piToolName, "klook-engine_query_log");
});

test("unrelated queries return nothing rather than noise", () => {
  assert.deepEqual(ranker.rank("bake sourdough bread", catalog, 5), []);
});

test("limit is respected", () => {
  assert.equal(ranker.rank("github", catalog, 2).length, 2);
});
