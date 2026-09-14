/**
 * The one config write pid-mcp performs on its own: flipping `disabled` on a server in the global
 * Pi mcp.json, the same edit `/mcp disable` in pi-mcp-adapter and the switch on PID's MCP page make.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function writeDisabled(serverName: string, disabled: boolean, agentDirPath: string): string {
  const path = join(agentDirPath, "mcp.json");
  let root: Record<string, unknown> = { mcpServers: {} };
  if (existsSync(path)) {
    root = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  }
  const servers = (root.mcpServers ??= {}) as Record<string, Record<string, unknown>>;
  const entry = (servers[serverName] ??= {});
  if (disabled) entry.disabled = true;
  else delete entry.disabled;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(root, null, 2)}\n`);
  renameSync(tmp, path);
  return path;
}
