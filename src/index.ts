/**
 * pid-mcp: MCP capability loader for Pi.
 *
 *   pi -e /path/to/pid-mcp/src/index.ts
 *
 * Every MCP tool becomes a Pi tool named `<server>_<tool>`. At session start only pinned tools and
 * `mcp_search` are visible; a search activates the matching tools for the rest of the session and the
 * model then calls them directly. Execution runs through the official MCP SDK inside this process.
 */
import type { AgentToolResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SEARCH_TOOL_NAME } from "./activation.ts";
import { PidMcp, PID_MCP_VERSION } from "./core.ts";
import { buildPage, publishPage } from "./host-page.ts";
import { OAuthStore } from "./oauth.ts";
import { convertContent, guardOutput, stringifyStructured } from "./results.ts";
import {
  COMPAT_RUNTIME_REGISTER_EVENT,
  COMPAT_RUNTIME_SNAPSHOT_EVENT,
  OAUTH_STATUS_MESSAGE,
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_REGISTER_EVENT,
  RUNTIME_SNAPSHOT_EVENT,
  publishStatus,
} from "./status.ts";
import type { CatalogTool, ServerEntry, StatusSnapshot } from "./types.ts";
import { isServerDisabled } from "./types.ts";
import { writeDisabled } from "./write-config.ts";

export { PID_MCP_VERSION, SEARCH_TOOL_NAME };
export * from "./status.ts";
export type { StatusSnapshot, ServerStatusSnapshot } from "./types.ts";

interface RuntimeRegisterRequest {
  version: number;
  name: string;
  definition: ServerEntry;
  result?: { ok: true; registration: { dispose(): Promise<void> } } | { ok: false; error: Error };
}
interface RuntimeSnapshotRequest {
  version: number;
  name: string;
  result?: { ok: true; snapshot: unknown } | { ok: false; error: Error };
}

/** Another MCP extension is already loaded when it has claimed one of these tool names. */
const FOREIGN_MCP_TOOL_NAMES = ["mcp", "mcpScript"];

/**
 * `/reload` swaps extension instances inside one process; module state does not survive it but
 * globalThis does. The outgoing instance leaves its search activations here for the incoming one.
 */
const RELOAD_HANDOFF = Symbol.for("pid-mcp.reload-handoff");
type HandoffGlobal = typeof globalThis & { [RELOAD_HANDOFF]?: string[] };

function leaveReloadHandoff(names: string[]): void {
  (globalThis as HandoffGlobal)[RELOAD_HANDOFF] = names;
}

function takeReloadHandoff(): string[] {
  const g = globalThis as HandoffGlobal;
  const names = g[RELOAD_HANDOFF] ?? [];
  delete g[RELOAD_HANDOFF];
  return names;
}

type Details = Record<string, unknown>;
type ToolResult = AgentToolResult<Details>;

export default function pidMcp(pi: ExtensionAPI): void {
  let ctx: ExtensionContext | undefined;
  const registered = new Set<string>();

  const oauth = new OAuthStore({
    onAuthorizationRequired: (pending) => {
      ctx?.ui.notify(`MCP "${pending.serverName}" needs authorization. A browser window was opened; finish signing in there.`, "info");
    },
  });

  const core = new PidMcp({
    host: {
      registerTool: (tool) => registerCatalogTool(tool),
      publishStatus: (snapshot) => {
        publishStatus(pi.events, snapshot);
        if (ctx?.hasUI) ctx.ui.setStatus("mcp", core.statusLine() || undefined);
        // A terminal has one status line; a window can show the whole snapshot, so give it one.
        // A window has room for the servers themselves, not just a count.
        publishPage(ctx, buildPage(snapshot as StatusSnapshot));
      },
      log: (message) => console.error(`pid-mcp: ${message}`),
    },
    activation: { getActiveTools: () => pi.getActiveTools(), setActiveTools: (names) => pi.setActiveTools(names) },
    manager: { oauth },
  });

  // ---- direct tools -------------------------------------------------------------------------------

  function registerCatalogTool(tool: CatalogTool): void {
    registered.add(tool.piToolName);
    const schema = normalizeSchema(tool.inputSchema);
    pi.registerTool({
      name: tool.piToolName,
      label: `MCP: ${tool.serverName}/${tool.originalName}`,
      description: tool.description || `${tool.originalName} from MCP server ${tool.serverName}`,
      parameters: Type.Unsafe<Record<string, unknown>>(schema),
      async execute(_id, params, signal): Promise<ToolResult> {
        const current = core.toolFor(tool.piToolName);
        if (!current) {
          return {
            content: [{ type: "text", text: `Tool ${tool.piToolName} is no longer offered by server "${tool.serverName}". Run mcp_search again.` }],
            details: { error: "stale_tool", server: tool.serverName },
          };
        }
        const state = core.servers.get(current.serverName);
        if (!state) return errorResult(`Server "${current.serverName}" is not registered`, "unknown_server", current.serverName);
        if (isServerDisabled(state.entry)) return errorResult(`Server "${current.serverName}" is disabled`, "disabled", current.serverName);
        try {
          const result = await core.manager.callTool(state.name, state.entry, current.originalName, (params ?? {}) as Record<string, unknown>, signal);
          let blocks = convertContent(result.content);
          if (blocks.length === 0 && result.structuredContent !== undefined) {
            blocks = [{ type: "text", text: stringifyStructured(result.structuredContent) }];
          }
          const first = blocks[0];
          if (result.isError && first && first.type === "text") {
            blocks[0] = { type: "text", text: `Error: ${first.text}` };
          }
          const guarded = guardOutput(blocks, `${state.name}-${current.originalName}`);
          return {
            content: guarded.blocks,
            details: {
              server: state.name,
              tool: current.originalName,
              ...(result.isError ? { error: "tool_error" } : {}),
              ...(guarded.truncated ? { truncated: true, spillPath: guarded.spillPath } : {}),
              ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
            },
          };
        } catch (error) {
          const message = (error as Error).message ?? String(error);
          const aborted = signal?.aborted === true;
          const rt = core.manager.runtime(state.name);
          const hint = rt.needsAuth ? ` Run /mcp auth ${state.name} to sign in.` : "";
          return errorResult(`${aborted ? "Aborted" : "Call failed"}: ${message}${hint}`, aborted ? "aborted" : "call_failed", state.name);
        }
      },
    });
  }

  function errorResult(text: string, code: string, server: string): ToolResult {
    return { content: [{ type: "text", text }], details: { error: code, server } };
  }

  // ---- mcp_search ---------------------------------------------------------------------------------

  pi.registerTool({
    name: SEARCH_TOOL_NAME,
    label: "MCP Tool Search",
    description:
      "Search the configured MCP tool catalog for capabilities relevant to the task. Matching tools are activated as regular tools and can be called directly on the next step. Use this when the currently visible tools cannot perform the required external action.",
    promptSnippet: "Search MCP tools when the active tools do not provide the required external capability",
    parameters: Type.Object({
      query: Type.String({ description: "Capability, action, or system to look for, e.g. 'search github issues' or 'query production logs'" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 15, description: "How many tools to activate (default 5, max 15)" })),
      server: Type.Optional(Type.String({ description: "Restrict to one MCP server name" })),
    }),
    async execute(_id, params): Promise<ToolResult> {
      const { matches, unindexed } = core.search(params.query, { limit: params.limit, server: params.server });
      if (matches.length === 0) {
        const lines = [`No MCP tools match "${params.query}".`];
        if (unindexed.length > 0) {
          lines.push(`${unindexed.length} enabled server(s) have not published their tool list yet: ${unindexed.join(", ")}.`);
          lines.push("They are being indexed in the background; search again in a moment, or ask the user to run /mcp refresh.");
          void core.refreshUnindexed();
        }
        const servers = [...core.servers.keys()];
        if (servers.length > 0) lines.push(`Configured servers: ${servers.join(", ")}.`);
        return { content: [{ type: "text", text: lines.join("\n") }], details: { query: params.query, matches: [], added: [], unindexed } };
      }
      const result = core.activator.activate(matches.map((m) => m.tool.piToolName));
      const line = (t: CatalogTool) => `- ${t.piToolName} — ${firstSentence(t.description) || `(${t.serverName})`}`;
      const text: string[] = [];
      text.push(`Found ${matches.length} matching MCP tool(s).`);
      if (result.added.length > 0) {
        text.push(`Activated ${result.added.length} new tool(s):`);
        for (const m of matches) if (result.added.includes(m.tool.piToolName)) text.push(line(m.tool));
      }
      if (result.alreadyActive.length > 0) {
        text.push("Already active:");
        for (const m of matches) if (result.alreadyActive.includes(m.tool.piToolName)) text.push(line(m.tool));
      }
      text.push("Call the activated tools directly by name.");
      return {
        content: [{ type: "text", text: text.join("\n") }],
        details: {
          query: params.query,
          matches: matches.map((m) => ({ server: m.tool.serverName, tool: m.tool.piToolName, score: m.score })),
          added: result.added,
          alreadyActive: result.alreadyActive,
        },
      };
    },
  });

  // ---- runtime registration (wire-compatible with pi-mcp-adapter) ----------------------------------

  const onRegister = (raw: unknown) => {
    const request = raw as RuntimeRegisterRequest;
    if (!request || typeof request !== "object") return;
    if (request.result) return; // another extension already answered
    if (request.version !== RUNTIME_PROTOCOL_VERSION) {
      request.result = { ok: false, error: new Error(`Unsupported MCP runtime registration version: ${String(request.version)}`) };
      return;
    }
    try {
      request.result = { ok: true, registration: core.registerRuntimeServer(request.name, request.definition) };
    } catch (error) {
      request.result = { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  };
  const onSnapshot = (raw: unknown) => {
    const request = raw as RuntimeSnapshotRequest;
    if (!request || typeof request !== "object" || request.result) return;
    if (request.version !== RUNTIME_PROTOCOL_VERSION) {
      request.result = { ok: false, error: new Error(`Unsupported MCP runtime snapshot version: ${String(request.version)}`) };
      return;
    }
    try {
      request.result = { ok: true, snapshot: core.runtimeSnapshot(request.name) };
    } catch (error) {
      request.result = { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  };
  pi.events.on(RUNTIME_REGISTER_EVENT, onRegister);
  pi.events.on(COMPAT_RUNTIME_REGISTER_EVENT, onRegister);
  pi.events.on(RUNTIME_SNAPSHOT_EVENT, onSnapshot);
  pi.events.on(COMPAT_RUNTIME_SNAPSHOT_EVENT, onSnapshot);

  // ---- lifecycle ------------------------------------------------------------------------------------

  pi.on("session_start", (ev, c) => {
    ctx = c;
    if (hasForeignMcpExtension()) {
      c.ui.notify(
        "pid-mcp is standing down: another MCP extension (pi-mcp-adapter) is loaded in this Pi. Remove one of them to avoid duplicate servers.",
        "warning",
      );
      return;
    }
    core.activator.clearSession();
    // `/reload` builds a fresh extension instance in the same process while Pi keeps the active tool
    // set. The instance being replaced left its activations on globalThis; pick them up so the model's
    // toolset does not change under it.
    if (ev.reason === "reload") core.activator.adopt(takeReloadHandoff());
    core.load(c.cwd);
    core.publishNow();
    void core.refreshUnindexed();
  });

  pi.on("session_shutdown", async () => {
    ctx = undefined;
    leaveReloadHandoff(core.activator.exportActivations());
    await core.shutdown();
  });

  function hasForeignMcpExtension(): boolean {
    const names = new Set(pi.getAllTools().map((t) => t.name));
    return FOREIGN_MCP_TOOL_NAMES.some((n) => names.has(n));
  }

  // ---- commands -------------------------------------------------------------------------------------

  const usage = [
    "/mcp                      status of every server",
    "/mcp tools <server>       list a server's tools and which are active",
    "/mcp search <query>       run mcp_search from the command line",
    "/mcp connect <server>     connect now and refresh its tool list",
    "/mcp reconnect <server>   drop the connection and connect again",
    "/mcp refresh              refresh every enabled server's tool list",
    "/mcp auth <server>        sign in to an OAuth server",
    "/mcp logout <server>      forget stored OAuth credentials",
    "/mcp enable|disable <s>   flip `disabled` in the global mcp.json",
    "/mcp activate <s> [tool…] put a server's tools (or all of them) in the model's view",
    "/mcp deactivate [<s> [tool…]] take them out again; no args = every MCP tool",
    "/mcp reset-tools          deactivate search-activated tools (pins stay)",
  ].join("\n");

  /** Tool arguments as typed: the Pi tool name, or the server's own tool name. */
  function resolveTools(server: string, args: string[]): { found: string[]; missing: string[] } {
    const state = core.servers.get(server);
    const found: string[] = [];
    const missing: string[] = [];
    for (const a of args) {
      const hit = [...(state?.toolNames ?? [])].find((pi) => pi === a || core.toolFor(pi)?.originalName === a);
      if (hit) found.push(hit);
      else missing.push(a);
    }
    return { found, missing };
  }

  async function mcpCommand(argsRaw: string, c: ExtensionCommandContext): Promise<void> {
    ctx = c;
    const [verb = "", ...rest] = argsRaw.trim().split(/\s+/).filter(Boolean);
    const arg = rest.join(" ");
    const need = (): string | undefined => {
      if (!arg) {
        c.ui.notify(`Usage: /mcp ${verb} <server>`, "warning");
        return undefined;
      }
      if (!core.servers.has(arg)) {
        c.ui.notify(`Unknown MCP server "${arg}". Known: ${[...core.servers.keys()].join(", ") || "(none)"}`, "error");
        return undefined;
      }
      return arg;
    };
    try {
      switch (verb) {
        case "":
        case "status":
          c.ui.notify(renderStatus(), "info");
          return;
        case "help":
          c.ui.notify(usage, "info");
          return;
        case "tools": {
          const name = need();
          if (!name) return;
          const state = core.servers.get(name)!;
          const active = new Set(core.activator.activeOwnedNames());
          const lines = [...state.toolNames].sort().map((n) => `${active.has(n) ? "●" : "○"} ${n}${core.activator.isPinned(n) ? " (pinned)" : ""}`);
          c.ui.notify(lines.length ? `${name}: ${lines.length} tool(s)\n${lines.join("\n")}` : `${name}: no tools cached yet; try /mcp connect ${name}`, "info");
          return;
        }
        case "search": {
          if (!arg) return c.ui.notify("Usage: /mcp search <query>", "warning");
          const { matches } = core.search(arg);
          const result = core.activator.activate(matches.map((m) => m.tool.piToolName));
          c.ui.notify(
            matches.length
              ? `${matches.map((m) => `${m.tool.piToolName} (${m.score})`).join("\n")}\nactivated: ${result.added.join(", ") || "none new"}`
              : `No MCP tools match "${arg}"`,
            "info",
          );
          return;
        }
        case "connect":
        case "reconnect": {
          const name = need();
          if (!name) return;
          await core.refreshServer(name, { reason: "manual", force: verb === "reconnect" });
          const rt = core.manager.runtime(name);
          c.ui.notify(rt.lastError ? `${name}: ${rt.lastError}` : `${name}: connected, ${core.servers.get(name)!.toolNames.size} tool(s)`, rt.lastError ? "error" : "info");
          return;
        }
        case "refresh": {
          const names = [...core.servers.values()].filter((s) => !isServerDisabled(s.entry)).map((s) => s.name);
          await Promise.all(names.map((n) => core.refreshServer(n, { reason: "manual" })));
          c.ui.notify(renderStatus(), "info");
          return;
        }
        case "auth": {
          const name = need();
          if (!name) return;
          const state = core.servers.get(name)!;
          await core.manager.authorize(name, state.entry);
          await core.refreshServer(name, { reason: "manual" });
          reportOAuth(name, "authenticated", `MCP "${name}" authorized and connected.`);
          return;
        }
        case "logout": {
          const name = need();
          if (!name) return;
          oauth.clear(name);
          await core.manager.close(name);
          c.ui.notify(`${name}: stored OAuth credentials removed`, "info");
          return;
        }
        case "enable":
        case "disable": {
          const name = need();
          if (!name) return;
          const path = writeDisabled(name, verb === "disable", core.agentDir());
          core.load(c.cwd);
          core.publishNow();
          c.ui.notify(`${name}: ${verb}d in ${path}`, "info");
          return;
        }
        case "activate": {
          const [server, ...tools] = rest;
          if (!server || !core.servers.has(server)) {
            c.ui.notify(`Usage: /mcp activate <server> [tool…]. Known: ${[...core.servers.keys()].join(", ") || "(none)"}`, "warning");
            return;
          }
          const all = [...core.servers.get(server)!.toolNames];
          const { found, missing } = tools.length ? resolveTools(server, tools) : { found: all, missing: [] };
          const result = core.activator.activate(found);
          core.publishNow();
          const bits = [`${server}: ${result.added.length} activated`];
          if (result.alreadyActive.length) bits.push(`${result.alreadyActive.length} already active`);
          if (missing.length) bits.push(`unknown: ${missing.join(", ")}`);
          c.ui.notify(bits.join(" · "), missing.length ? "warning" : "info");
          return;
        }
        case "deactivate": {
          const [server, ...tools] = rest;
          let targets: string[];
          let missing: string[] = [];
          if (!server) targets = core.activator.activeOwnedNames();
          else if (!core.servers.has(server)) {
            c.ui.notify(`Unknown MCP server "${server}". Known: ${[...core.servers.keys()].join(", ") || "(none)"}`, "error");
            return;
          } else if (tools.length === 0) targets = [...core.servers.get(server)!.toolNames];
          else ({ found: targets, missing } = resolveTools(server, tools));
          const removed = core.activator.deactivate(targets);
          core.publishNow();
          const bits = [`${server ?? "all servers"}: ${removed.length} deactivated`];
          if (missing.length) bits.push(`unknown: ${missing.join(", ")}`);
          c.ui.notify(bits.join(" · "), missing.length ? "warning" : "info");
          return;
        }
        case "reset-tools": {
          const dropped = core.activator.reset();
          core.publishNow();
          c.ui.notify(dropped.length ? `Deactivated ${dropped.length} search-activated tool(s): ${dropped.join(", ")}` : "No search-activated tools to reset", "info");
          return;
        }
        default:
          c.ui.notify(`Unknown /mcp subcommand "${verb}".\n${usage}`, "warning");
      }
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      if (verb === "auth" && arg) reportOAuth(arg, "failed", `MCP "${arg}" authorization failed: ${message}`);
      else c.ui.notify(`/mcp ${verb}: ${message}`, "error");
    } finally {
      core.publishNow();
    }
  }

  function reportOAuth(server: string, status: "authenticated" | "failed", message: string): void {
    ctx?.ui.notify(message, status === "authenticated" ? "info" : "error");
    pi.sendMessage(
      { customType: OAUTH_STATUS_MESSAGE, content: [{ type: "text", text: message }], display: true, details: { server, status } },
      { triggerTurn: false },
    );
    pi.events.emit(OAUTH_STATUS_MESSAGE, { server, status, message });
  }

  function renderStatus(): string {
    const snap = core.snapshot();
    if (snap.servers.length === 0) {
      return `pid-mcp ${PID_MCP_VERSION}: no MCP servers configured.\nConfig files searched:\n${core.sources.map((s) => `  ${s.exists ? "✓" : "·"} ${s.path}`).join("\n")}`;
    }
    const lines = snap.servers.map((s) => {
      const bits = [`${s.status}`, `${s.toolCount} tools`, `${s.activeToolCount} active`];
      if (s.pinnedToolCount) bits.push(`${s.pinnedToolCount} pinned`);
      if (s.runtimeRegistered) bits.push("runtime");
      if (s.lastError) bits.push(`error: ${s.lastError}`);
      return `${s.name}: ${bits.join(" · ")}`;
    });
    return `pid-mcp ${PID_MCP_VERSION} · ${snap.connectedCount} connected · ${snap.activeToolCount}/${snap.totalTools} tools active\n${lines.join("\n")}`;
  }

  pi.registerCommand("mcp", {
    description: "MCP servers: status, tools, connect, auth, enable/disable, reset-tools",
    getArgumentCompletions: (prefix) => {
      const verbs = ["status", "tools", "search", "connect", "reconnect", "refresh", "auth", "logout", "enable", "disable", "reset-tools", "help"];
      const [v = "", ...rest] = prefix.split(/\s+/);
      if (rest.length === 0) return verbs.filter((x) => x.startsWith(v)).map((x) => ({ value: x, label: x }));
      const partial = rest.join(" ");
      return [...core.servers.keys()].filter((n) => n.startsWith(partial)).map((n) => ({ value: `${v} ${n}`, label: n }));
    },
    handler: mcpCommand,
  });
  pi.registerCommand("mcp-auth", {
    description: "Sign in to an OAuth MCP server (alias of /mcp auth)",
    handler: (args, c) => mcpCommand(`auth ${args}`, c),
  });
}

function normalizeSchema(schema: unknown): Record<string, unknown> {
  const obj: Record<string, unknown> =
    schema && typeof schema === "object" && !Array.isArray(schema) ? { ...(schema as Record<string, unknown>) } : { type: "object", properties: {} };
  delete obj.$schema;
  delete obj.additionalProperties;
  if (obj.type === undefined) obj.type = "object";
  if (obj.type === "object" && obj.properties === undefined) obj.properties = {};
  return obj;
}

function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const m = /^(.{1,140}?[.!?])(\s|$)/.exec(flat);
  const s = m ? m[1]! : flat;
  return s.length > 140 ? `${s.slice(0, 137)}...` : s;
}
