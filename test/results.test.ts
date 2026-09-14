import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_RESULT_BYTES, convertContent, guardOutput } from "../src/results.ts";

test("content conversion covers text, image, resource, link, audio and unknown", () => {
  const blocks = convertContent([
    { type: "text", text: "hi" },
    { type: "image", data: "AAA", mimeType: "image/jpeg" },
    { type: "resource", resource: { uri: "file:///a", text: "body" } },
    { type: "resource_link", uri: "https://x", name: "X" },
    { type: "audio", mimeType: "audio/mp3" },
    { type: "weird", foo: 1 },
  ]);
  assert.equal(blocks.length, 6);
  assert.deepEqual(blocks[0], { type: "text", text: "hi" });
  assert.deepEqual(blocks[1], { type: "image", data: "AAA", mimeType: "image/jpeg" });
  assert.match((blocks[2] as { text: string }).text, /file:\/\/\/a[\s\S]*body/);
  assert.match((blocks[5] as { text: string }).text, /"foo":1/);
});

test("oversized output is truncated and spilled to a file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pid-mcp-spill-"));
  const big = "x".repeat(MAX_RESULT_BYTES + 1000);
  const g = guardOutput([{ type: "text", text: big }], "srv-tool", dir);
  assert.equal(g.truncated, true);
  assert.ok(g.spillPath);
  assert.equal(readFileSync(g.spillPath!, "utf8").length, big.length);
  const text = (g.blocks[0] as { text: string }).text;
  assert.ok(text.includes("output truncated"));
  assert.ok(Buffer.byteLength(text) < MAX_RESULT_BYTES + 500);
});

test("small output passes through untouched", () => {
  const g = guardOutput([{ type: "text", text: "ok" }], "s");
  assert.equal(g.truncated, false);
  assert.deepEqual(g.blocks, [{ type: "text", text: "ok" }]);
});
