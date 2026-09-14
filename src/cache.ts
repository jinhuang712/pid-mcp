/**
 * Metadata cache: the tools each server advertised the last time it was connected.
 *
 * Stored at `<agent dir>/mcp-cache.json` in the exact shape pi-mcp-adapter writes (version 1), so a
 * cache populated by either extension serves the other. The cache is what lets pid-mcp register
 * every MCP tool at startup without starting a single server process.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentDir, interpolateEnv, interpolateRecord } from "./config.ts";
import type { MetadataCache, ServerCacheEntry, ServerEntry } from "./types.ts";

export const CACHE_VERSION = 1;
export const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function cachePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentDir(env), "mcp-cache.json");
}

export function readCache(path: string = cachePath()): MetadataCache {
  if (!existsSync(path)) return { version: CACHE_VERSION, servers: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<MetadataCache>;
    if (parsed?.version !== CACHE_VERSION || !parsed.servers || typeof parsed.servers !== "object") {
      return { version: CACHE_VERSION, servers: {} };
    }
    return { version: CACHE_VERSION, servers: parsed.servers as Record<string, ServerCacheEntry> };
  } catch {
    return { version: CACHE_VERSION, servers: {} };
  }
}

/** Merge one server's entry into the file on disk; other servers' entries are preserved. */
export function writeCacheEntry(serverName: string, entry: ServerCacheEntry, path: string = cachePath()): void {
  const current = readCache(path);
  current.servers[serverName] = entry;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(current, null, 2));
  renameSync(tmp, path);
}

export function removeCacheEntry(serverName: string, path: string = cachePath()): void {
  const current = readCache(path);
  if (!(serverName in current.servers)) return;
  delete current.servers[serverName];
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(current, null, 2));
  renameSync(tmp, path);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as object).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

/**
 * Hash of the fields that change what a server advertises. Lifecycle and timeouts are excluded on
 * purpose: changing them should not invalidate the tool list.
 */
export function computeConfigHash(entry: ServerEntry, env: NodeJS.ProcessEnv = process.env): string {
  const identity = {
    command: entry.command,
    args: entry.args,
    env: interpolateRecord(entry.env, env),
    cwd: entry.cwd,
    url: typeof entry.url === "string" ? interpolateEnv(entry.url, env) : undefined,
    headers: interpolateRecord(entry.headers, env),
    auth: entry.auth,
    bearerToken: entry.bearerToken,
    bearerTokenEnv: entry.bearerTokenEnv,
    includeTools: entry.includeTools,
    excludeTools: entry.excludeTools,
  };
  return createHash("sha256").update(stableStringify(identity)).digest("hex");
}

export function isCacheEntryValid(entry: ServerCacheEntry | undefined, hash: string, now = Date.now()): boolean {
  if (!entry || entry.configHash !== hash) return false;
  if (typeof entry.cachedAt !== "number") return false;
  return now - entry.cachedAt <= CACHE_MAX_AGE_MS;
}
