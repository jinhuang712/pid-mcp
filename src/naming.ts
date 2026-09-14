/**
 * Pi tool names for MCP tools.
 *
 * Follows pi-mcp-adapter's scheme so a user switching between the two sees the same names:
 * `<server>_<tool>` by default, with `toolPrefix` selecting `none`, `short`, or `mcp`.
 */
import type { ToolPrefix } from "./types.ts";

/** Pi's built-in tool names. An MCP tool that would shadow one of these is skipped. */
export const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "mcp_search",
]);

/** Provider tool-name limit shared by Anthropic, OpenAI, and Bedrock. */
export const MAX_TOOL_NAME_LENGTH = 64;

function sanitizeSegment(value: string): string {
  return Array.from(value, (ch) => (/^[A-Za-z0-9_-]$/.test(ch) ? ch : `_${ch.codePointAt(0)!.toString(16)}_`)).join("");
}

export function serverPrefix(serverName: string, mode: ToolPrefix): string {
  if (mode === "none") return "";
  if (mode === "short") {
    const s = sanitizeSegment(serverName.replace(/-?mcp$/i, ""));
    return s || "mcp";
  }
  if (mode === "mcp") return `mcp__${sanitizeSegment(serverName)}`;
  return sanitizeSegment(serverName);
}

export function formatToolName(toolName: string, serverName: string, mode: ToolPrefix): string {
  const prefix = serverPrefix(serverName, mode);
  const sanitized = sanitizeSegment(toolName.replace(/\./g, "_"));
  const full = prefix ? `${prefix}_${sanitized}` : sanitized;
  return full.length <= MAX_TOOL_NAME_LENGTH ? full : truncateWithHash(full);
}

function truncateWithHash(name: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const tag = `_${h.toString(16).padStart(8, "0")}`;
  return name.slice(0, MAX_TOOL_NAME_LENGTH - tag.length) + tag;
}

export function resolveToolPrefix(serverPrefixSetting?: ToolPrefix, globalPrefix?: ToolPrefix): ToolPrefix {
  return serverPrefixSetting ?? globalPrefix ?? "server";
}
