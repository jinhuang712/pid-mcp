/**
 * Shared types for pid-mcp.
 *
 * The config shapes follow the fields Pi users already have in mcp.json so an existing file works
 * unchanged. Fields pid-mcp does not implement are accepted and ignored rather than rejected.
 */

export type ToolPrefix = "server" | "none" | "short" | "mcp";

/**
 * How a server's tools reach the model.
 * - `false` / absent: registered as Pi tools, inactive until `mcp_search` activates them.
 * - `"search"`: same as absent; accepted for compatibility with pi-mcp-adapter configs.
 * - `true`: every tool is active from session start (pinned).
 * - `string[]`: only the listed original tool names are pinned; the rest wait for search.
 */
export type DirectToolsSetting = boolean | string[] | "search";

export interface OAuthConfig {
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  redirectUri?: string;
  clientName?: string;
}

export interface ServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: "oauth" | "bearer" | false;
  bearerToken?: string;
  bearerTokenEnv?: string;
  oauth?: OAuthConfig | false;
  httpTransport?: "streamable-http" | "sse";
  lifecycle?: "keep-alive" | "lazy" | "eager";
  idleTimeout?: number;
  requestTimeoutMs?: number;
  directTools?: DirectToolsSetting;
  toolPrefix?: ToolPrefix;
  includeTools?: string[];
  excludeTools?: string[];
  searchKeywords?: Record<string, string[]>;
  disabled?: boolean;
  /** Unknown keys from other tools' configs are carried along untouched. */
  [extra: string]: unknown;
}

export interface McpSettings {
  toolPrefix?: ToolPrefix;
  directTools?: boolean | "search";
  idleTimeout?: number;
  requestTimeoutMs?: number;
  /** Upper bound `mcp_search` will activate in one call. Default 15. */
  searchActivationLimit?: number;
  /** Default number of matches `mcp_search` returns. Default 5. */
  searchDefaultLimit?: number;
  [extra: string]: unknown;
}

export interface McpConfig {
  mcpServers: Record<string, ServerEntry>;
  settings?: McpSettings;
}

/** Only the literal boolean `true` disables a server, the same rule pi-mcp-adapter uses. */
export function isServerDisabled(entry: ServerEntry | undefined): boolean {
  return entry?.disabled === true;
}

export interface CachedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

export interface CachedResource {
  uri: string;
  name: string;
  description?: string;
}

export interface ServerCacheEntry {
  configHash: string;
  tools: CachedTool[];
  resources: CachedResource[];
  prompts?: unknown[];
  instructions?: string;
  cachedAt: number;
  [extra: string]: unknown;
}

export interface MetadataCache {
  version: number;
  servers: Record<string, ServerCacheEntry>;
}

/** One entry of the searchable catalog: an MCP tool with the Pi name it is registered under. */
export interface CatalogTool {
  serverName: string;
  originalName: string;
  piToolName: string;
  description: string;
  inputSchema?: unknown;
  keywords: string[];
  pinned: boolean;
}

export type ServerRuntimeStatus =
  | "connected"
  | "cached"
  | "failed"
  | "needs-auth"
  | "not-connected"
  | "disabled";

/** Per-server status entry. The first block mirrors pi-mcp-adapter's snapshot, field for field. */
export interface ServerStatusSnapshot {
  name: string;
  status: ServerRuntimeStatus;
  toolCount: number;
  directToolCount: number;
  resourceCount?: number;
  failedAgoSeconds?: number;
  disabled: boolean;
  listenState: "not-listening";
  // pid-mcp additions
  activeToolCount: number;
  pinnedToolCount: number;
  activeToolNames: string[];
  lastError?: string;
  /** Registered by another extension at runtime; no config file defines it. */
  runtimeRegistered: boolean;
  transport: "stdio" | "http" | "unknown";
  cachedAt?: number;
  // pid-mcp additions: credential state for the Accounts section. Trailing
  // fields; readers written against the adapter snapshot ignore them.
  /** Whether this server signs in with OAuth. */
  auth: "oauth" | "none";
  /** Whether the OAuth store holds tokens. Always false when auth is "none". */
  signedIn: boolean;
}

export interface StatusSnapshot {
  version: 1;
  servers: ServerStatusSnapshot[];
  totalTools: number;
  totalResources: number;
  connectedCount: number;
  disabledCount: number;
  // pid-mcp additions
  source: "pid-mcp";
  pidMcpVersion: string;
  activeToolCount: number;
}
