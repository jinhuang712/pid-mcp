// Smoke test against a real `pi --mode rpc` child, no model needed: drives slash commands and
// prints what the extension says back. Usage: node test/smoke-rpc.mjs
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "echo-server.mjs");
// PID_MCP_ENTRY lets the smoke run against an installed copy (e.g. PID's node_modules/pid-mcp).
const entry = process.env.PID_MCP_ENTRY ?? join(here, "..", "src", "index.ts");

const root = mkdtempSync(join(tmpdir(), "pid-mcp-smoke-"));
const agent = join(root, "agent");
mkdirSync(agent, { recursive: true });
// Reuse the user's model catalogue so Pi can start; nothing is written back.
for (const f of ["models.json", "auth.json", "settings.json"]) {
  const src = join(homedir(), ".pi", "agent", f);
  if (existsSync(src)) copyFileSync(src, join(agent, f));
}
// A fresh settings.json with no packages, so only -e extensions load.
writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [], defaultProjectTrust: "always" }));
writeFileSync(
  join(agent, "mcp.json"),
  JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [fixture], directTools: ["echo"] } } }, null, 2),
);

const pi = spawn("pi", ["--mode", "rpc", "--no-session", "-e", entry], {
  cwd: root,
  env: { ...process.env, PI_CODING_AGENT_DIR: agent },
  stdio: ["pipe", "pipe", "pipe"],
});

const seen = [];
let buffer = "";
pi.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      seen.push(msg);
      if (msg.type === "extension_ui_request" && (msg.method === "notify" || msg.method === "setStatus")) {
        console.log(`[${msg.method}] ${msg.message ?? msg.statusText ?? msg.text ?? JSON.stringify(msg)}`);
      } else if (msg.type === "extension_error" || msg.type === "error") {
        console.log(`[${msg.type}] ${JSON.stringify(msg)}`);
      }
    } catch {
      console.log(`[raw] ${line}`);
    }
  }
});
pi.stderr.on("data", (c) => process.stderr.write(`[pi stderr] ${c}`));

const send = (obj) => pi.stdin.write(`${JSON.stringify(obj)}\n`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await wait(2500);
send({ type: "prompt", message: "/mcp" });
await wait(1500);
send({ type: "prompt", message: "/mcp refresh" });
await wait(3000);
send({ type: "prompt", message: "/mcp tools fixture" });
await wait(800);
send({ type: "prompt", message: "/mcp search search issues" });
await wait(800);
send({ type: "prompt", message: "/mcp tools fixture" });
await wait(800);
send({ type: "prompt", message: "/mcp reset-tools" });
await wait(800);
send({ type: "get_state" });
await wait(800);

const state = seen.filter((m) => m.type === "response" && m.command === "get_state").at(-1);
if (state) console.log(`[get_state] ${JSON.stringify(state.data ?? state).slice(0, 400)}`);
const widgets = seen.filter((m) => m.type === "extension_ui_request" && m.method === "setWidget");
console.log(`[widgets] ${widgets.length} setWidget requests`);
pi.kill();
