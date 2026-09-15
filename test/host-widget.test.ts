import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  publishWidget,
  STATUS_WIDGET_KEY,
  wantsWidget,
  withRuntimeDefinitions,
} from "../src/host-widget.ts";

function fakeCtx(mode: string, hasUI: boolean) {
  const calls: { key: string; lines: string[] | undefined }[] = [];
  const ctx = {
    mode,
    hasUI,
    ui: {
      setWidget(key: string, lines: string[] | undefined) {
        calls.push({ key, lines });
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, calls };
}

test("wantsWidget is true only for a drawing host that is not a terminal", () => {
  assert.equal(wantsWidget(fakeCtx("rpc", true).ctx), true);
  // A terminal has the status line; the widget would be JSON above the editor.
  assert.equal(wantsWidget(fakeCtx("tui", true).ctx), false);
  assert.equal(wantsWidget(fakeCtx("print", false).ctx), false);
  assert.equal(wantsWidget(undefined), false);
});

test("publishes the snapshot as JSON under its kind", () => {
  const { ctx, calls } = fakeCtx("rpc", true);
  publishWidget(ctx, STATUS_WIDGET_KEY, { servers: [{ name: "gh" }] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.key, "pid-mcp:mcp-status/v1");
  assert.equal(JSON.parse(calls[0]?.lines?.[0] ?? "{}").servers[0].name, "gh");
});

test("clears with undefined and stays out of a terminal", () => {
  const rpc = fakeCtx("rpc", true);
  publishWidget(rpc.ctx, STATUS_WIDGET_KEY, undefined);
  assert.deepEqual(rpc.calls, [{ key: STATUS_WIDGET_KEY, lines: undefined }]);

  const tui = fakeCtx("tui", true);
  publishWidget(tui.ctx, STATUS_WIDGET_KEY, { servers: [] });
  assert.deepEqual(tui.calls, []);
});

test("never throws, so status cannot break the session", () => {
  const ctx = {
    mode: "rpc",
    hasUI: true,
    ui: {
      setWidget() {
        throw new Error("host went away");
      },
    },
  } as unknown as ExtensionContext;
  assert.doesNotThrow(() => publishWidget(ctx, STATUS_WIDGET_KEY, {}));
});

test("marks the servers that were registered at runtime", () => {
  const snapshot = { servers: [{ name: "gh" }, { name: "fs" }, 7] };
  const out = withRuntimeDefinitions(snapshot, (name) =>
    name === "gh" ? { command: "gh-mcp", args: ["serve"] } : undefined,
  ) as { servers: { name?: string; runtime?: unknown }[] };
  assert.deepEqual(out.servers[0]?.runtime, { command: "gh-mcp", args: ["serve"] });
  // A configured server has an mcp.json entry to look up; leaving it unmarked is the signal.
  assert.equal(out.servers[1]?.runtime, undefined);
  assert.equal(out.servers[2], 7);
});

test("leaves a snapshot it does not understand alone", () => {
  assert.equal(withRuntimeDefinitions(undefined, () => undefined), undefined);
  assert.deepEqual(withRuntimeDefinitions({ servers: "nope" }, () => undefined), { servers: "nope" });
});
