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
