// Smoke test of the PID integration path: `pi --mode rpc` with pid-mcp AND PID's pid-bridge loaded
// via -e, exactly as PID starts it. Asserts that a `pid:mcp-status` widget arrives carrying
// pid-mcp's snapshot. Usage: node test/smoke-bridge.mjs <path-to-pid-repo>
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pidRepo = resolve(process.argv[2] ?? join(homedir(), "dev", "pi", "pid"));
const bridge = join(pidRepo, "resources", "pid-bridge", "index.ts");
if (!existsSync(bridge)) {
  console.error(`pid-bridge not found at ${bridge}`);
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "echo-server.mjs");
const entry = join(here, "..", "src", "index.ts");

const root = mkdtempSync(join(tmpdir(), "pid-mcp-bridge-"));
const agent = join(root, "agent");
mkdirSync(agent, { recursive: true });
for (const f of ["models.json", "auth.json"]) {
  const src = join(homedir(), ".pi", "agent", f);
  if (existsSync(src)) copyFileSync(src, join(agent, f));
}
writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [], defaultProjectTrust: "always" }));
writeFileSync(
  join(agent, "mcp.json"),
  JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [fixture], directTools: ["echo"] } } }),
);

const pi = spawn("pi", ["--mode", "rpc", "--no-session", "-e", entry, "-e", bridge], {
  cwd: root,
  env: { ...process.env, PI_CODING_AGENT_DIR: agent },
  stdio: ["pipe", "pipe", "pipe"],
});

const widgets = [];
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
      if (msg.type === "extension_ui_request" && msg.method === "setWidget" && msg.widgetKey === "pid:mcp-status") {
        widgets.push(JSON.parse(msg.widgetLines.join("")));
      }
    } catch {
      /* ignore */
    }
  }
});
pi.stderr.on("data", (c) => process.stderr.write(`[pi stderr] ${c}`));

const send = (obj) => pi.stdin.write(`${JSON.stringify(obj)}\n`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(3500);
send({ type: "prompt", message: "/mcp search search issues" });
await wait(1200);
pi.kill();

const last = widgets.at(-1);
console.log(`[bridge] ${widgets.length} pid:mcp-status widgets received`);
if (!last) {
  console.error("FAIL: no pid:mcp-status widget");
  process.exit(1);
}
console.log(`[bridge] last snapshot: ${JSON.stringify(last)}`);
const ok =
  last.source === "pid-mcp" &&
  last.servers?.[0]?.name === "fixture" &&
  last.servers[0].toolCount === 4 &&
  Array.isArray(last.servers[0].activeToolNames) &&
  last.servers[0].activeToolNames.includes("fixture_echo") &&
  last.servers[0].activeToolNames.includes("fixture_search_issues");
console.log(ok ? "PASS" : "FAIL: snapshot did not match expectations");
process.exit(ok ? 0 : 1);
