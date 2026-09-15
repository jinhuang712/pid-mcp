import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPage } from "../src/host-page.ts";
import type { ServerStatusSnapshot, StatusSnapshot } from "../src/types.ts";

const server = (over: Partial<ServerStatusSnapshot> = {}): ServerStatusSnapshot => ({
  name: "github",
  status: "connected",
  toolCount: 12,
  directToolCount: 2,
  disabled: false,
  listenState: "not-listening",
  activeToolCount: 2,
  pinnedToolCount: 1,
  activeToolNames: ["search_issues", "get_issue"],
  runtimeRegistered: false,
  transport: "http",
  ...over,
});

const snapshot = (...servers: ServerStatusSnapshot[]): StatusSnapshot => ({
  version: 1,
  servers,
  totalTools: servers.reduce((n, s) => n + s.toolCount, 0),
  totalResources: 0,
  connectedCount: servers.filter((s) => s.status === "connected").length,
  disabledCount: servers.filter((s) => s.disabled).length,
  source: "pid-mcp",
  pidMcpVersion: "0.1.1",
  activeToolCount: servers.reduce((n, s) => n + s.activeToolCount, 0),
});

test("describes a server as a row a host can draw without knowing what MCP is", () => {
  const row = buildPage(snapshot(server())).sections[0]?.rows[0];
  assert.equal(row?.id, "github");
  assert.deepEqual(
    row?.badges?.map((b) => b.text),
    ["connected", "http", "2 active"],
  );
  // The switch is two commands, not a value to write: the config stays this extension's.
  assert.deepEqual(row?.toggle, {
    value: true,
    on: "/mcp enable github",
    off: "/mcp disable github",
  });
  assert.deepEqual(
    row?.actions?.map((a) => a.command),
    ["/mcp reconnect github", "/mcp logout github"],
  );
  assert.equal(row?.rows?.[0]?.title, "search_issues");
  assert.equal(row?.rows?.[0]?.actions?.[0]?.command, "/mcp deactivate github search_issues");
});

test("offers signing in only when that is what failed", () => {
  const row = buildPage(snapshot(server({ lastError: "401 auth required" }))).sections[0]?.rows[0];
  assert.deepEqual(
    row?.actions?.map((a) => a.label),
    ["Reconnect", "Sign in"],
  );
});

test("offers nothing to act on for a server that is switched off", () => {
  const row = buildPage(snapshot(server({ disabled: true, status: "disabled" }))).sections[0]?.rows[0];
  assert.equal(row?.actions, undefined);
  assert.equal(row?.toggle?.value, false);
});

test("caps the tool list rather than handing a host a wall", () => {
  const many = Array.from({ length: 60 }, (_, i) => `tool_${i}`);
  const row = buildPage(snapshot(server({ activeToolNames: many }))).sections[0]?.rows[0];
  assert.equal(row?.rows?.length, 40);
});

test("says what it is in the note, and has no section when there is nothing", () => {
  const page = buildPage(snapshot(server()));
  assert.equal(page.title, "MCP");
  assert.match(page.note ?? "", /1\/1 connected · 2\/12 tools active/);
  assert.deepEqual(buildPage(snapshot()).sections, []);
});
