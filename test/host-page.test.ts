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
  auth: "none",
  signedIn: false,
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

test("answers sign-in state per account, never a green light it has not earned", () => {
  const page = buildPage(
    snapshot(
      server({ name: "a", auth: "oauth", signedIn: true }),
      server({ name: "b", auth: "oauth", signedIn: false, status: "needs-auth" }),
      server({ name: "c", auth: "oauth", signedIn: false, disabled: true, status: "disabled" }),
    ),
  );
  const accounts = page.sections[0];
  assert.equal(accounts?.title, "Accounts");
  const labels = new Map(
    (accounts?.rows ?? []).map((r) => [r.id, r.badges?.map((b) => b.text)]),
  );
  assert.deepEqual(labels.get("account:a"), ["Signed in"]);
  assert.deepEqual(labels.get("account:b"), ["Needs sign-in"]);
  assert.deepEqual(labels.get("account:c"), ["Off"]);
  // Only the server that can act gets the action; the switch stays on the server row.
  const byId = new Map((accounts?.rows ?? []).map((r) => [r.id, r]));
  assert.deepEqual(
    byId.get("account:b")?.actions?.map((a) => a.command),
    ["/mcp auth b"],
  );
  assert.equal(byId.get("account:a")?.actions, undefined);
  assert.equal(byId.get("account:c")?.actions, undefined);
});

test("has no Accounts section when nothing signs in", () => {
  const page = buildPage(snapshot(server()));
  assert.deepEqual(
    page.sections.map((s) => s.title),
    [undefined],
  );
});
