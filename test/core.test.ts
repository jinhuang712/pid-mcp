/**
 * End-to-end through the real MCP SDK: a stdio fixture server, the metadata cache, catalog,
 * activation policy and tool calls. No Pi process: the host is a fake registry.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { SEARCH_TOOL_NAME } from "../src/activation.ts";
import { PidMcp } from "../src/core.ts";
import type { CatalogTool, StatusSnapshot } from "../src/types.ts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "echo-server.mjs");

function harness(opts: { serverName?: string; extra?: Record<string, unknown>; settings?: Record<string, unknown> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pid-mcp-core-"));
  const agent = join(root, "agent");
  const project = join(root, "project");
  mkdirSync(agent, { recursive: true });
  mkdirSync(project, { recursive: true });
  const serverName = opts.serverName ?? "fixture";
  writeFileSync(
    join(agent, "mcp.json"),
    JSON.stringify({
      settings: opts.settings ?? {},
      mcpServers: { [serverName]: { command: process.execPath, args: [fixture], ...opts.extra } },
    }),
  );
  const env = { ...process.env, PI_CODING_AGENT_DIR: agent, HOME: root };
  let active: string[] = ["read", "bash", SEARCH_TOOL_NAME];
  const registered = new Map<string, CatalogTool>();
  const snapshots: StatusSnapshot[] = [];
  const logs: string[] = [];
  const core = new PidMcp({
    env,
    host: {
      registerTool: (t) => registered.set(t.piToolName, t),
      publishStatus: (s) => snapshots.push(s),
      log: (m) => logs.push(m),
    },
    activation: {
      getActiveTools: () => [...active],
      setActiveTools: (names) => {
        active = [...names];
      },
    },
    manager: { defaultIdleTimeoutMinutes: 0 },
  });
  return { core, agent, project, serverName, active: () => active, registered, snapshots, logs };
}

const cores: PidMcp[] = [];
after(async () => {
  await Promise.all(cores.map((c) => c.shutdown()));
});

test("first run: no cache → refresh populates cache, registers tools inactive; search activates; call goes through", async () => {
  const h = harness();
  cores.push(h.core);
  h.core.load(h.project);
  assert.deepEqual(h.core.unindexedServers(), ["fixture"]);
  assert.equal(h.registered.size, 0);

  await h.core.refreshUnindexed();
  const cachePath = join(h.agent, "mcp-cache.json");
  assert.ok(existsSync(cachePath));
  const cache = JSON.parse(readFileSync(cachePath, "utf8"));
  assert.equal(cache.version, 1);
  assert.equal(cache.servers.fixture.tools.length, 4);
  assert.equal(cache.servers.fixture.instructions, "Fixture server for pid-mcp tests.");

  assert.deepEqual([...h.registered.keys()].sort(), ["fixture_always_fails", "fixture_big_output", "fixture_echo", "fixture_search_issues"]);
  assert.deepEqual(h.active().sort(), ["bash", SEARCH_TOOL_NAME, "read"].sort(), "nothing MCP is visible before a search");

  const { matches } = h.core.search("search issues in repo");
  assert.equal(matches[0]?.tool.piToolName, "fixture_search_issues");
  const result = h.core.activator.activate(matches.map((m) => m.tool.piToolName));
  assert.ok(result.added.includes("fixture_search_issues"));
  assert.ok(h.active().includes("fixture_search_issues"));
  assert.ok(h.active().includes("read"));

  const state = h.core.servers.get("fixture")!;
  const call = await h.core.manager.callTool("fixture", state.entry, "search_issues", { query: "mcp" });
  assert.equal(call.isError, false);
  assert.deepEqual(call.structuredContent, { query: "mcp", items: [] });

  const failing = await h.core.manager.callTool("fixture", state.entry, "always_fails", {});
  assert.equal(failing.isError, true);

  const snap = h.core.snapshot();
  assert.equal(snap.source, "pid-mcp");
  assert.equal(snap.servers[0]?.status, "connected");
  assert.equal(snap.servers[0]?.toolCount, 4);
  assert.deepEqual(snap.servers[0]?.activeToolNames, ["fixture_search_issues"]);
  assert.equal(snap.servers[0]?.transport, "stdio");
});

test("second run: cache hit registers tools without starting the server; pinned tools are active from the start", async () => {
  const h = harness({ extra: { directTools: ["echo"] } });
  cores.push(h.core);
  h.core.load(h.project);
  await h.core.refreshUnindexed();
  await h.core.manager.closeAll();

  // A fresh core over the same agent dir: cache only.
  const h2 = new PidMcp({
    env: { ...process.env, PI_CODING_AGENT_DIR: h.agent, HOME: dirname(h.agent) },
    host: { registerTool: () => undefined, publishStatus: () => undefined, log: () => undefined },
    activation: {
      getActiveTools: () => h.active(),
      setActiveTools: (names) => {
        (h as { active: () => string[] }).active = () => names;
      },
    },
  });
  cores.push(h2);
  h2.load(h.project);
  assert.deepEqual(h2.unindexedServers(), []);
  assert.equal(h2.servers.get("fixture")?.toolNames.size, 4);
  assert.equal(h2.manager.isConnected("fixture"), false);
  assert.ok(h2.activator.isPinned("fixture_echo"));
  assert.equal(h2.serverStatus(h2.servers.get("fixture")!), "cached");
});

test("disabled servers register nothing and report disabled", async () => {
  const h = harness({ extra: { disabled: true } });
  cores.push(h.core);
  h.core.load(h.project);
  assert.deepEqual(h.core.unindexedServers(), []);
  await h.core.refreshUnindexed();
  assert.equal(h.registered.size, 0);
  assert.equal(h.core.snapshot().servers[0]?.status, "disabled");
  assert.equal(h.core.snapshot().disabledCount, 1);
});

test("a server that fails to start is reported as failed with its error, and other work continues", async () => {
  const h = harness({ extra: { env: { ECHO_FIXTURE_FAIL_START: "1" }, requestTimeoutMs: 3000 } });
  cores.push(h.core);
  h.core.load(h.project);
  await h.core.refreshUnindexed();
  const s = h.core.snapshot().servers[0]!;
  assert.equal(s.status, "failed");
  assert.ok(s.lastError, "lastError is set");
  assert.ok(typeof s.failedAgoSeconds === "number");
  assert.ok(h.logs.some((l) => l.includes("refresh of \"fixture\" failed")));
});

test("runtime registration: wire-compatible request, tools appear, dispose removes them", async () => {
  const h = harness({ extra: { disabled: true } });
  cores.push(h.core);
  h.core.load(h.project);
  const reg = h.core.registerRuntimeServer("rt", { command: process.execPath, args: [fixture] });
  assert.ok(h.core.servers.get("rt")?.runtime);
  assert.throws(() => h.core.registerRuntimeServer("rt", { command: "x" }), /already registered/);
  assert.throws(() => h.core.registerRuntimeServer("fixture", { command: "x" }), /already registered/);
  // registration kicks off a background refresh; wait for it
  await h.core.refreshServer("rt", { reason: "manual" });
  assert.equal(h.core.servers.get("rt")?.toolNames.size, 4);
  assert.deepEqual(h.core.runtimeSnapshot("rt").definition, { command: process.execPath, args: [fixture] });
  assert.ok(!h.active().includes("rt_echo"), "runtime servers are search-mode by default");
  const r = h.core.search("echo text", { server: "rt" });
  assert.equal(r.matches[0]?.tool.piToolName, "rt_echo");
  await reg.dispose();
  assert.equal(h.core.servers.has("rt"), false);
  assert.throws(() => h.core.runtimeSnapshot("rt"), /not registered/);
  assert.equal(h.core.toolFor("rt_echo"), undefined);
});

test("include/exclude filters and toolPrefix none", async () => {
  const h = harness({ extra: { includeTools: ["echo", "search_*"], excludeTools: ["search_issues"], toolPrefix: "none" } });
  cores.push(h.core);
  h.core.load(h.project);
  await h.core.refreshUnindexed();
  assert.deepEqual([...h.registered.keys()], ["echo"]);
});

test("shutdown: nothing re-arms the status timer, so a ctx Pi invalidated on /reload is never touched", async () => {
  const h = harness();
  h.core.load(h.project);
  await h.core.refreshUnindexed();
  await h.core.shutdown();

  // After `await ctx.reload()` every accessor on the old ctx throws; the old core instance keeps living
  // only through its timers. Model that on the activation host and poke the scheduler.
  const core = h.core as unknown as { activator: { api: { getActiveTools: () => string[] } }; scheduleStatus: () => void };
  core.activator.api.getActiveTools = () => {
    throw new Error("This extension ctx is stale after session replacement or reload.");
  };
  const published = h.snapshots.length;
  core.scheduleStatus(); // what the manager's onStatusChange does while closeAll() drains
  h.core.publishNow();
  await new Promise((r) => setTimeout(r, 80));

  assert.equal(h.snapshots.length, published, "no status publish may run after shutdown");
  assert.deepEqual(h.logs.filter((l) => l.includes("status publish failed")), []);
});
