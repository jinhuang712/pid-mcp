/**
 * MCP config loading.
 *
 * Reads the same layered files pi-mcp-adapter reads, in the same precedence, so nothing has to
 * move when a user switches. Lowest to highest:
 *
 *   ~/.config/mcp/mcp.json      shared across MCP hosts
 *   ~/.agents/mcp.json
 *   ~/.agents/mcp/mcp.json
 *   <agent dir>/mcp.json        Pi's own, normally ~/.pi/agent/mcp.json
 *   <cwd>/.mcp.json             project, shared
 *   <cwd>/.pi/mcp.json          project, Pi only
 *
 * Servers merge per field by name so a project file can flip `disabled` without restating the
 * command. When a higher layer changes a server's transport or URL, credential fields from the lower
 * layer are dropped rather than carried to the new endpoint.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { McpConfig, ServerEntry } from "./types.ts";

export interface ConfigSource {
  id: string;
  path: string;
  exists: boolean;
  serverNames: string[];
}

export interface LoadedConfig {
  config: McpConfig;
  sources: ConfigSource[];
  /** Highest-precedence file that defines each server, for diagnostics. */
  definedIn: Record<string, string[]>;
}

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR ? resolve(env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent");
}

export function configPaths(cwd: string, env: NodeJS.ProcessEnv = process.env): { id: string; path: string }[] {
  const home = homedir();
  const list = [
    { id: "shared-global", path: join(home, ".config", "mcp", "mcp.json") },
    { id: "agents-global", path: join(home, ".agents", "mcp.json") },
    { id: "agents-nested-global", path: join(home, ".agents", "mcp", "mcp.json") },
    { id: "pi-global", path: join(agentDir(env), "mcp.json") },
    { id: "shared-project", path: resolve(cwd, ".mcp.json") },
    { id: "pi-project", path: resolve(cwd, ".pi", "mcp.json") },
  ];
  const seen = new Set<string>();
  return list.filter((p) => (seen.has(p.path) ? false : (seen.add(p.path), true)));
}

export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  let config: McpConfig = { mcpServers: {} };
  const sources: ConfigSource[] = [];
  const definedIn: Record<string, string[]> = {};
  for (const { id, path } of configPaths(cwd, env)) {
    const exists = existsSync(path);
    let layer: McpConfig | undefined;
    if (exists) {
      try {
        layer = normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
      } catch (error) {
        console.error(`pid-mcp: cannot read ${path}: ${(error as Error).message}`);
      }
    }
    const names = layer ? Object.keys(layer.mcpServers) : [];
    sources.push({ id, path, exists, serverNames: names });
    for (const n of names) (definedIn[n] ??= []).push(path);
    if (layer) config = mergeConfigs(config, layer);
  }
  return { config, sources, definedIn };
}

export function normalizeConfig(raw: unknown): McpConfig {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const servers = obj.mcpServers && typeof obj.mcpServers === "object" ? (obj.mcpServers as Record<string, ServerEntry>) : {};
  const settings = obj.settings && typeof obj.settings === "object" ? (obj.settings as McpConfig["settings"]) : undefined;
  return settings ? { mcpServers: { ...servers }, settings } : { mcpServers: { ...servers } };
}

const STDIO_FIELDS = ["command", "args", "env", "cwd"] as const;
const HTTP_FIELDS = ["url", "headers", "auth", "bearerToken", "bearerTokenEnv", "oauth", "httpTransport"] as const;
const CREDENTIAL_FIELDS = ["headers", "auth", "bearerToken", "bearerTokenEnv", "oauth"] as const;

export function mergeConfigs(base: McpConfig, next: McpConfig): McpConfig {
  const mcpServers: Record<string, ServerEntry> = { ...base.mcpServers };
  for (const [name, override] of Object.entries(next.mcpServers)) {
    mcpServers[name] = mergeServer(mcpServers[name], override);
  }
  const settings = base.settings || next.settings ? { ...base.settings, ...next.settings } : undefined;
  return settings ? { mcpServers, settings } : { mcpServers };
}

function mergeServer(base: ServerEntry | undefined, next: ServerEntry): ServerEntry {
  if (!base) return { ...next };
  let inherited: ServerEntry = { ...base };
  const baseIsStdio = typeof base.command === "string";
  const nextIsStdio = typeof next.command === "string";
  const nextIsHttp = typeof next.url === "string";
  if (nextIsStdio && !baseIsStdio) {
    for (const f of HTTP_FIELDS) delete inherited[f];
  } else if (nextIsHttp && baseIsStdio) {
    for (const f of STDIO_FIELDS) delete inherited[f];
    for (const f of CREDENTIAL_FIELDS) delete inherited[f];
  } else if (nextIsHttp && base.url !== next.url) {
    for (const f of CREDENTIAL_FIELDS) delete inherited[f];
  }
  inherited = { ...inherited, ...next };
  return inherited;
}

const ENV_PATTERN = /\$\{(\w+)\}|\$env:(\w+)|\{env:(\w+)\}/g;

export function interpolateEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(ENV_PATTERN, (_m, a: string | undefined, b: string | undefined, c: string | undefined) => {
    const name = a ?? b ?? c ?? "";
    return env[name] ?? "";
  });
}

export function missingEnvVars(value: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const missing = new Set<string>();
  for (const m of value.matchAll(ENV_PATTERN)) {
    const name = m[1] ?? m[2] ?? m[3];
    if (name && env[name] === undefined) missing.add(name);
  }
  return [...missing];
}

export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

export function interpolateRecord(
  record: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  if (!record) return undefined;
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, interpolateEnv(v, env)]));
}

export function transportOf(entry: ServerEntry): "stdio" | "http" | "unknown" {
  if (typeof entry.command === "string" && entry.command) return "stdio";
  if (typeof entry.url === "string" && entry.url) return "http";
  return "unknown";
}
