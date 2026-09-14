/**
 * The extension's state: config, cache, catalog, connections, and the active-tool policy.
 *
 * `PidMcp` knows nothing about Pi's API beyond two callbacks it is given: one to register a Pi tool
 * for a catalog entry, and one to publish a status snapshot. index.ts supplies both. Keeping Pi out
 * of this file is what makes the behaviour testable with a fake registry.
 */
import { buildServerCatalog } from "./catalog.ts";
import { computeConfigHash, isCacheEntryValid, readCache, cachePath as defaultCachePath, writeCacheEntry } from "./cache.ts";
import { agentDir, loadConfig, transportOf, type ConfigSource } from "./config.ts";
import { ToolActivator, type ActivationApi, SEARCH_TOOL_NAME } from "./activation.ts";
import { LexicalRanker, type RankedTool, type Ranker } from "./ranking.ts";
import { ServerManager, type ServerManagerOptions } from "./servers.ts";
import type {
  CatalogTool,
  McpConfig,
  MetadataCache,
  ServerCacheEntry,
  ServerEntry,
  ServerRuntimeStatus,
  ServerStatusSnapshot,
  StatusSnapshot,
} from "./types.ts";
import { isServerDisabled } from "./types.ts";

export const PID_MCP_VERSION = "0.1.0";
export const DEFAULT_SEARCH_LIMIT = 5;
export const MAX_SEARCH_LIMIT = 15;

export interface ServerState {
  name: string;
  entry: ServerEntry;
  /** Registered at runtime by another extension; no config file defines it. */
  runtime: boolean;
  /** Pi tool names currently in the catalog for this server. */
  toolNames: Set<string>;
  resourceCount: number;
  cachedAt?: number;
  refreshing?: Promise<void>;
  skipped: { name: string; reason: string }[];
}

export interface PidMcpHost {
  /** Register (or re-register) a Pi tool for a catalog entry. */
  registerTool(tool: CatalogTool): void;
  publishStatus(snapshot: StatusSnapshot): void;
  log(message: string): void;
}

export interface PidMcpOptions {
  host: PidMcpHost;
  activation: ActivationApi;
  cachePath?: string;
  env?: NodeJS.ProcessEnv;
  ranker?: Ranker;
  manager?: ServerManagerOptions;
}

export class PidMcp {
  readonly activator: ToolActivator;
  readonly manager: ServerManager;
  readonly ranker: Ranker;
  readonly servers = new Map<string, ServerState>();
  readonly catalog = new Map<string, CatalogTool>();
  config: McpConfig = { mcpServers: {} };
  sources: ConfigSource[] = [];
  definedIn: Record<string, string[]> = {};
  cwd = process.cwd();
  private readonly host: PidMcpHost;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cachePath: string;
  private cache: MetadataCache = { version: 1, servers: {} };
  private statusTimer?: NodeJS.Timeout;

  constructor(options: PidMcpOptions) {
    this.host = options.host;
    this.env = options.env ?? process.env;
    this.cachePath = options.cachePath ?? defaultCachePath(this.env);
    this.activator = new ToolActivator(options.activation);
    this.ranker = options.ranker ?? new LexicalRanker();
    this.manager = new ServerManager({
      ...options.manager,
      env: this.env,
      clientVersion: PID_MCP_VERSION,
      onToolListChanged: (name) => {
        options.manager?.onToolListChanged?.(name);
        void this.refreshServer(name, { reason: "list_changed" });
      },
      onStatusChange: (name) => {
        options.manager?.onStatusChange?.(name);
        this.scheduleStatus();
      },
    });
  }

  agentDir(): string {
    return agentDir(this.env);
  }

  // ---- lifecycle -------------------------------------------------------------------------------

  /** (Re)load config for a working directory and rebuild the catalog from cache. */
  load(cwd: string): void {
    this.cwd = cwd;
    const loaded = loadConfig(cwd, this.env);
    this.config = loaded.config;
    this.sources = loaded.sources;
    this.definedIn = loaded.definedIn;
    this.cache = readCache(this.cachePath);

    for (const [name, state] of [...this.servers]) {
      if (!state.runtime && !(name in this.config.mcpServers)) this.dropServer(name);
    }
    for (const [name, entry] of Object.entries(this.config.mcpServers)) {
      const existing = this.servers.get(name);
      if (existing?.runtime) {
        this.host.log(`runtime-registered server "${name}" now collides with a configured server; keeping the configured one`);
        this.dropServer(name);
      }
      this.servers.set(name, {
        name,
        entry,
        runtime: false,
        toolNames: existing && !existing.runtime ? existing.toolNames : new Set(),
        resourceCount: existing?.resourceCount ?? 0,
        cachedAt: existing?.cachedAt,
        skipped: [],
      });
    }
    for (const state of this.servers.values()) this.rebuildFromCache(state);
    this.activator.applyBaseline();
    this.scheduleStatus();
  }

  /** Servers whose cache is missing or stale. `mcp_search` cannot find their tools until refreshed. */
  unindexedServers(): string[] {
    return [...this.servers.values()]
      .filter((s) => !isServerDisabled(s.entry) && !this.hasValidCache(s))
      .map((s) => s.name);
  }

  /** Fetch metadata for every enabled server without a valid cache. Runs in the background. */
  refreshUnindexed(): Promise<void> {
    return Promise.all(this.unindexedServers().map((n) => this.refreshServer(n, { reason: "no_cache" }))).then(() => undefined);
  }

  async shutdown(): Promise<void> {
    if (this.statusTimer) clearTimeout(this.statusTimer);
    await this.manager.closeAll();
    this.activator.clearSession();
    this.host.publishStatus(this.emptySnapshot());
  }

  // ---- servers -----------------------------------------------------------------------------------

  private dropServer(name: string): void {
    const state = this.servers.get(name);
    if (!state) return;
    for (const toolName of state.toolNames) {
      this.catalog.delete(toolName);
      this.activator.forget(toolName);
    }
    this.servers.delete(name);
    void this.manager.close(name);
    this.manager.forget(name);
  }

  registerRuntimeServer(name: string, definition: ServerEntry): { dispose: () => Promise<void> } {
    if (typeof name !== "string" || name.trim() === "") throw new Error("MCP server name must be a non-empty string");
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
      throw new Error(`MCP server definition for "${name}" must be an object`);
    }
    if (this.servers.has(name)) throw new Error(`MCP server "${name}" is already registered`);
    const entry: ServerEntry = structuredClone(definition);
    const state: ServerState = { name, entry, runtime: true, toolNames: new Set(), resourceCount: 0, skipped: [] };
    this.servers.set(name, state);
    this.rebuildFromCache(state);
    this.activator.applyBaseline();
    if (!this.hasValidCache(state) && !isServerDisabled(entry)) void this.refreshServer(name, { reason: "no_cache" });
    this.scheduleStatus();
    let disposed = false;
    return {
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        const current = this.servers.get(name);
        if (!current || current !== state) return;
        this.dropServer(name);
        this.activator.applyBaseline();
        this.scheduleStatus();
      },
    };
  }

  runtimeSnapshot(name: string): { name: string; definition: ServerEntry; runtime: true; persisted: false } {
    const state = this.servers.get(name);
    if (!state || !state.runtime) throw new Error(`MCP server "${name}" is not registered at runtime or has been disposed`);
    return { name, definition: structuredClone(state.entry), runtime: true, persisted: false };
  }

  private hasValidCache(state: ServerState): boolean {
    const entry = this.cache.servers[state.name];
    return isCacheEntryValid(entry, computeConfigHash(state.entry, this.env));
  }

  /** Register catalog tools for a server from whatever the cache holds. */
  private rebuildFromCache(state: ServerState): void {
    const cached = this.cache.servers[state.name];
    const usable = cached && cached.configHash === computeConfigHash(state.entry, this.env) ? cached : undefined;
    this.applyMetadata(state, usable);
  }

  private applyMetadata(state: ServerState, cached: ServerCacheEntry | undefined): void {
    const previous = state.toolNames;
    for (const toolName of previous) this.catalog.delete(toolName);
    const taken = new Set(this.catalog.keys());
    const { tools, skipped } = buildServerCatalog(state.name, state.entry, cached?.tools ?? [], this.config, taken);
    state.skipped = skipped;
    state.toolNames = new Set(tools.map((t) => t.piToolName));
    state.resourceCount = cached?.resources?.length ?? 0;
    state.cachedAt = cached?.cachedAt;
    for (const tool of tools) {
      this.catalog.set(tool.piToolName, tool);
      this.activator.own(tool.piToolName, tool.pinned);
      this.host.registerTool(tool);
    }
    // Tools that disappeared stay registered with Pi (there is no unregister) but leave the catalog
    // and the active set at the next baseline; calling one reports it as stale.
    for (const gone of previous) if (!state.toolNames.has(gone)) this.activator.forget(gone);
  }

  /** Connect, list tools, update cache and catalog. Concurrent calls for one server share a run. */
  refreshServer(name: string, opts: { reason: string; force?: boolean } = { reason: "manual" }): Promise<void> {
    const state = this.servers.get(name);
    if (!state) return Promise.reject(new Error(`Unknown MCP server "${name}"`));
    if (isServerDisabled(state.entry)) return Promise.resolve();
    if (state.refreshing) return state.refreshing;
    state.refreshing = (async () => {
      try {
        if (opts.force) await this.manager.close(name);
        const meta = await this.manager.listMetadata(name, state.entry);
        const entry: ServerCacheEntry = {
          configHash: computeConfigHash(state.entry, this.env),
          tools: meta.tools,
          resources: meta.resources,
          instructions: meta.instructions,
          cachedAt: Date.now(),
        };
        this.cache.servers[name] = entry;
        writeCacheEntry(name, entry, this.cachePath);
        this.applyMetadata(state, entry);
        this.activator.applyBaseline();
        if (state.entry.lifecycle !== "keep-alive" && state.entry.lifecycle !== "eager" && opts.reason === "no_cache") {
          // Metadata-only connect: let the server go again right away.
          await this.manager.close(name);
        }
      } catch (error) {
        this.host.log(`refresh of "${name}" failed: ${(error as Error).message}`);
      } finally {
        state.refreshing = undefined;
        this.scheduleStatus();
      }
    })();
    return state.refreshing;
  }

  // ---- tools ---------------------------------------------------------------------------------------

  search(query: string, opts: { limit?: number; server?: string } = {}): { matches: RankedTool[]; unindexed: string[] } {
    const settings = this.config.settings;
    const max = Math.max(1, Math.min(settings?.searchActivationLimit ?? MAX_SEARCH_LIMIT, MAX_SEARCH_LIMIT));
    const limit = Math.max(1, Math.min(opts.limit ?? settings?.searchDefaultLimit ?? DEFAULT_SEARCH_LIMIT, max));
    let pool = [...this.catalog.values()];
    if (opts.server) pool = pool.filter((t) => t.serverName === opts.server);
    return { matches: this.ranker.rank(query, pool, limit), unindexed: this.unindexedServers() };
  }

  toolFor(piToolName: string): CatalogTool | undefined {
    return this.catalog.get(piToolName);
  }

  // ---- status ----------------------------------------------------------------------------------------

  private scheduleStatus(): void {
    if (this.statusTimer) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = undefined;
      this.host.publishStatus(this.snapshot());
    }, 20);
    this.statusTimer.unref?.();
  }

  publishNow(): void {
    if (this.statusTimer) {
      clearTimeout(this.statusTimer);
      this.statusTimer = undefined;
    }
    this.host.publishStatus(this.snapshot());
  }

  serverStatus(state: ServerState): ServerRuntimeStatus {
    if (isServerDisabled(state.entry)) return "disabled";
    const rt = this.manager.runtime(state.name);
    if (rt.connection) return "connected";
    if (rt.needsAuth) return "needs-auth";
    if (rt.failedAt !== undefined) return "failed";
    if (state.toolNames.size > 0 || this.hasValidCache(state)) return "cached";
    return "not-connected";
  }

  snapshot(): StatusSnapshot {
    const activeOwned = new Set(this.activator.activeOwnedNames());
    const servers: ServerStatusSnapshot[] = [];
    let totalTools = 0;
    let totalResources = 0;
    let connected = 0;
    let disabled = 0;
    for (const state of this.servers.values()) {
      const rt = this.manager.runtime(state.name);
      const status = this.serverStatus(state);
      if (status === "connected") connected++;
      if (status === "disabled") disabled++;
      const names = [...state.toolNames];
      const active = names.filter((n) => activeOwned.has(n));
      const pinned = names.filter((n) => this.activator.isPinned(n));
      totalTools += names.length;
      totalResources += state.resourceCount;
      servers.push({
        name: state.name,
        status,
        toolCount: names.length,
        directToolCount: active.length,
        resourceCount: state.resourceCount,
        ...(rt.failedAt !== undefined ? { failedAgoSeconds: Math.round((Date.now() - rt.failedAt) / 1000) } : {}),
        disabled: status === "disabled",
        listenState: "not-listening",
        activeToolCount: active.length,
        pinnedToolCount: pinned.length,
        activeToolNames: active,
        ...(rt.lastError ? { lastError: rt.lastError } : {}),
        runtimeRegistered: state.runtime,
        transport: transportOf(state.entry),
        ...(state.cachedAt !== undefined ? { cachedAt: state.cachedAt } : {}),
      });
    }
    return {
      version: 1,
      servers,
      totalTools,
      totalResources,
      connectedCount: connected,
      disabledCount: disabled,
      source: "pid-mcp",
      pidMcpVersion: PID_MCP_VERSION,
      activeToolCount: activeOwned.size,
    };
  }

  private emptySnapshot(): StatusSnapshot {
    return {
      version: 1,
      servers: [],
      totalTools: 0,
      totalResources: 0,
      connectedCount: 0,
      disabledCount: 0,
      source: "pid-mcp",
      pidMcpVersion: PID_MCP_VERSION,
      activeToolCount: 0,
    };
  }

  statusLine(): string {
    const snap = this.snapshot();
    const total = snap.servers.length;
    if (total === 0) return "";
    const parts = [`MCP ${snap.connectedCount}/${total - snap.disabledCount}`];
    parts.push(`${snap.activeToolCount}/${snap.totalTools} tools`);
    const needAuth = snap.servers.filter((s) => s.status === "needs-auth").length;
    if (needAuth > 0) parts.push(`${needAuth} need auth`);
    const failed = snap.servers.filter((s) => s.status === "failed").length;
    if (failed > 0) parts.push(`${failed} failed`);
    return parts.join(" · ");
  }
}

export { SEARCH_TOOL_NAME };
