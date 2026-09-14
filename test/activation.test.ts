import assert from "node:assert/strict";
import { test } from "node:test";
import { SEARCH_TOOL_NAME, ToolActivator } from "../src/activation.ts";

function fakeApi(initial: string[]) {
  let active = [...initial];
  const calls: string[][] = [];
  return {
    api: {
      getActiveTools: () => [...active],
      setActiveTools: (names: string[]) => {
        active = [...names];
        calls.push([...names]);
      },
    },
    active: () => active,
    calls,
  };
}

test("baseline hides unpinned owned tools, keeps built-ins, third-party tools, pins, and mcp_search", () => {
  const f = fakeApi(["read", "bash", "third_party", "gh_search", "gh_get", "pin_me", SEARCH_TOOL_NAME]);
  const a = new ToolActivator(f.api);
  a.own("gh_search", false);
  a.own("gh_get", false);
  a.own("pin_me", true);
  a.applyBaseline();
  assert.deepEqual(f.active().sort(), ["bash", SEARCH_TOOL_NAME, "pin_me", "read", "third_party"].sort());
});

test("baseline adds mcp_search and pins even when Pi did not have them active", () => {
  const f = fakeApi(["read"]);
  const a = new ToolActivator(f.api);
  a.own("pin_me", true);
  a.applyBaseline();
  assert.deepEqual(f.active().sort(), ["read", "pin_me", SEARCH_TOOL_NAME].sort());
});

test("baseline is a no-op when nothing changes", () => {
  const f = fakeApi(["read", SEARCH_TOOL_NAME]);
  const a = new ToolActivator(f.api);
  a.applyBaseline();
  assert.equal(f.calls.length, 0);
});

test("activation is additive and idempotent", () => {
  const f = fakeApi(["read", SEARCH_TOOL_NAME]);
  const a = new ToolActivator(f.api);
  a.own("a1", false);
  a.own("a2", false);
  a.own("b1", false);
  const r1 = a.activate(["a1", "a2", "not_owned"]);
  assert.deepEqual(r1.added, ["a1", "a2"]);
  const r2 = a.activate(["a1", "b1"]);
  assert.deepEqual(r2.added, ["b1"]);
  assert.deepEqual(r2.alreadyActive, ["a1"]);
  assert.deepEqual(f.active().sort(), ["a1", "a2", "b1", SEARCH_TOOL_NAME, "read"].sort());
  for (const call of f.calls) assert.ok(call.includes("read"), "never removes a foreign tool");
});

test("a later baseline keeps search-activated tools", () => {
  const f = fakeApi(["read", SEARCH_TOOL_NAME]);
  const a = new ToolActivator(f.api);
  a.own("a1", false);
  a.activate(["a1"]);
  a.applyBaseline();
  assert.ok(f.active().includes("a1"));
});

test("reset drops search activations but keeps pins; clearSession forgets them for the next session", () => {
  const f = fakeApi(["read", SEARCH_TOOL_NAME]);
  const a = new ToolActivator(f.api);
  a.own("a1", false);
  a.own("p1", true);
  a.applyBaseline();
  a.activate(["a1"]);
  const dropped = a.reset();
  assert.deepEqual(dropped, ["a1"]);
  assert.deepEqual(f.active().sort(), ["p1", "read", SEARCH_TOOL_NAME].sort());
  a.activate(["a1"]);
  a.clearSession();
  a.applyBaseline();
  assert.ok(!f.active().includes("a1"));
});

test("deactivate takes owned tools out, pins included, and ignores names it does not own", () => {
  const f = fakeApi(["read", SEARCH_TOOL_NAME]);
  const a = new ToolActivator(f.api);
  a.own("gh_search", false);
  a.own("gh_get", false);
  a.own("pin_me", true);
  a.applyBaseline();
  a.activate(["gh_get"]);
  assert.deepEqual(f.active().sort(), ["gh_get", "pin_me", "read", SEARCH_TOOL_NAME].sort());

  assert.deepEqual(a.deactivate(["gh_get", "pin_me", "read", "nobody"]).sort(), ["gh_get", "pin_me"]);
  assert.deepEqual(f.active().sort(), ["read", SEARCH_TOOL_NAME].sort());
  // The pin is gone for this session: a later baseline does not bring pin_me back.
  a.applyBaseline();
  assert.ok(!f.active().includes("pin_me"));
  assert.deepEqual(a.deactivate(["gh_get"]), []);
});

test("reload handoff: the next instance adopts activations, so baseline keeps them active", () => {
  // Instance 1 activated `gh_get` via search, then Pi reloads: it keeps the active set and
  // marks every extension tool active while the new instance is built.
  const f = fakeApi(["read", SEARCH_TOOL_NAME]);
  const old = new ToolActivator(f.api);
  old.own("gh_search", false);
  old.own("gh_get", false);
  old.applyBaseline();
  old.activate(["gh_get"]);
  const handoff = old.exportActivations();
  assert.deepEqual(handoff, ["gh_get"]);
  f.api.setActiveTools([...f.active(), "gh_search"]); // Pi's reload: every extension tool active

  const fresh = new ToolActivator(f.api);
  fresh.clearSession();
  fresh.adopt([...handoff, "vanished_tool"]);
  fresh.own("gh_search", false);
  fresh.own("gh_get", false);
  fresh.applyBaseline();
  assert.deepEqual(f.active().sort(), ["gh_get", "read", SEARCH_TOOL_NAME].sort());
});
