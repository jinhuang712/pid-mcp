/**
 * The catalog: every MCP tool pid-mcp knows about, with the Pi name it is registered under and
 * whether it is pinned (active from session start) or waits for `mcp_search`.
 */
import { BUILTIN_TOOL_NAMES, formatToolName, resolveToolPrefix } from "./naming.ts";
import type { CachedTool, CatalogTool, McpConfig, ServerEntry } from "./types.ts";
import { isServerDisabled } from "./types.ts";

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

export function toolAllowed(name: string, entry: ServerEntry): boolean {
  const include = entry.includeTools;
  if (Array.isArray(include) && include.length > 0 && !include.some((g) => globToRegExp(g).test(name))) return false;
  const exclude = entry.excludeTools;
  if (Array.isArray(exclude) && exclude.some((g) => globToRegExp(g).test(name))) return false;
  return true;
}

export function isPinned(originalName: string, entry: ServerEntry, settings: McpConfig["settings"]): boolean {
  const selected = entry.directTools !== undefined ? entry.directTools : settings?.directTools;
  if (selected === true) return true;
  if (Array.isArray(selected)) return selected.includes(originalName);
  return false;
}

/** Build catalog entries for one server from its cached tool list. */
export function buildServerCatalog(
  serverName: string,
  entry: ServerEntry,
  tools: CachedTool[],
  config: McpConfig,
  taken: Set<string>,
): { tools: CatalogTool[]; skipped: { name: string; reason: string }[] } {
  const out: CatalogTool[] = [];
  const skipped: { name: string; reason: string }[] = [];
  if (isServerDisabled(entry)) return { tools: out, skipped };
  const prefix = resolveToolPrefix(entry.toolPrefix, config.settings?.toolPrefix);
  for (const tool of tools) {
    if (!toolAllowed(tool.name, entry)) continue;
    const piToolName = formatToolName(tool.name, serverName, prefix);
    if (BUILTIN_TOOL_NAMES.has(piToolName)) {
      skipped.push({ name: piToolName, reason: "collides with a built-in tool" });
      continue;
    }
    if (taken.has(piToolName)) {
      skipped.push({ name: piToolName, reason: "duplicate name" });
      continue;
    }
    taken.add(piToolName);
    out.push({
      serverName,
      originalName: tool.name,
      piToolName,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
      keywords: entry.searchKeywords?.[tool.name] ?? [],
      pinned: isPinned(tool.name, entry, config.settings),
    });
  }
  return { tools: out, skipped };
}
