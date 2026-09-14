import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { interpolateEnv, loadConfig, mergeConfigs, missingEnvVars } from "../src/config.ts";

test("merge is per field, project wins, disabled flips without restating the command", () => {
  const merged = mergeConfigs(
    { mcpServers: { s: { command: "node", args: ["a.js"], directTools: true } } },
    { mcpServers: { s: { disabled: true } } },
  );
  assert.deepEqual(merged.mcpServers.s, { command: "node", args: ["a.js"], directTools: true, disabled: true });
});

test("credentials do not follow a server to a new URL", () => {
  const merged = mergeConfigs(
    { mcpServers: { s: { url: "https://a.example/mcp", headers: { Authorization: "Bearer x" }, auth: "bearer" } } },
    { mcpServers: { s: { url: "https://b.example/mcp" } } },
  );
  assert.deepEqual(merged.mcpServers.s, { url: "https://b.example/mcp" });
});

test("switching stdio to http drops stdio fields and credentials", () => {
  const merged = mergeConfigs(
    { mcpServers: { s: { command: "node", args: ["x"], env: { A: "1" } } } },
    { mcpServers: { s: { url: "https://b.example/mcp" } } },
  );
  assert.deepEqual(merged.mcpServers.s, { url: "https://b.example/mcp" });
});

test("env interpolation supports all three syntaxes and reports missing vars", () => {
  const env = { TOKEN: "t1", HOST: "h" };
  assert.equal(interpolateEnv("${TOKEN}/$env:HOST/{env:TOKEN}", env), "t1/h/t1");
  assert.deepEqual(missingEnvVars("${TOKEN}/${NOPE}", env), ["NOPE"]);
});

test("loadConfig layers agent dir under project files and records where each server is defined", () => {
  const root = mkdtempSync(join(tmpdir(), "pid-mcp-cfg-"));
  const agent = join(root, "agent");
  const project = join(root, "proj");
  mkdirSync(agent, { recursive: true });
  mkdirSync(join(project, ".pi"), { recursive: true });
  writeFileSync(join(agent, "mcp.json"), JSON.stringify({ settings: { directTools: "search" }, mcpServers: { g: { command: "g" }, both: { command: "b" } } }));
  writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { shared: { url: "https://s" } } }));
  writeFileSync(join(project, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { both: { disabled: true } } }));
  const loaded = loadConfig(project, { PI_CODING_AGENT_DIR: agent, HOME: root });
  assert.deepEqual(Object.keys(loaded.config.mcpServers).sort(), ["both", "g", "shared"]);
  assert.equal(loaded.config.mcpServers.both?.disabled, true);
  assert.equal(loaded.config.mcpServers.both?.command, "b");
  assert.equal(loaded.config.settings?.directTools, "search");
  assert.equal(loaded.definedIn.both?.length, 2);
  assert.ok(loaded.sources.find((s) => s.id === "pi-global")?.exists);
});
