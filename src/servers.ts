/**
 * Server connections, built on the official MCP TypeScript SDK.
 *
 * One `ServerManager` per Pi process. Connections are lazy: nothing starts until a tool is called or
 * metadata is requested. A connected server is closed again after `idleTimeout` minutes of silence
 * unless its lifecycle is `keep-alive`.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { expandHome, interpolateEnv, interpolateRecord, missingEnvVars, transportOf } from "./config.ts";
import { AuthorizationRequiredError, type OAuthStore } from "./oauth.ts";
import type { CachedResource, CachedTool, ServerEntry } from "./types.ts";

export interface ServerMetadata {
  tools: CachedTool[];
  resources: CachedResource[];
  instructions?: string;
}

export interface CallResult {
  content: unknown[];
  structuredContent?: unknown;
  isError: boolean;
}

interface Connection {
  client: Client;
  transport: Transport;
}

export interface ServerRuntime {
  connection?: Connection;
  connecting?: Promise<Connection>;
  idleTimer?: NodeJS.Timeout;
  lastError?: string;
  failedAt?: number;
  needsAuth: boolean;
  lastConnectedAt?: number;
}

export interface ServerManagerOptions {
  clientName?: string;
  clientVersion?: string;
  defaultIdleTimeoutMinutes?: number;
  defaultRequestTimeoutMs?: number;
  oauth?: OAuthStore;
  onToolListChanged?: (serverName: string) => void;
  onStatusChange?: (serverName: string) => void;
  env?: NodeJS.ProcessEnv;
}

export class ServerManager {
  private readonly runtimes = new Map<string, ServerRuntime>();
  private readonly options: ServerManagerOptions;
  constructor(options: ServerManagerOptions = {}) {
    this.options = options;
  }

  runtime(name: string): ServerRuntime {
    let rt = this.runtimes.get(name);
    if (!rt) {
      rt = { needsAuth: false };
      this.runtimes.set(name, rt);
    }
    return rt;
  }

  isConnected(name: string): boolean {
    return this.runtimes.get(name)?.connection !== undefined;
  }

  /**
   * Credential state for the Accounts section. The OAuth store stays behind
   * this method; snapshots carry the answer, never the store.
   */
  authState(name: string, entry: ServerEntry): { auth: "oauth" | "none"; signedIn: boolean } {
    if (entry.auth !== "oauth" || !this.options.oauth) return { auth: "none", signedIn: false };
    return { auth: "oauth", signedIn: this.options.oauth.hasTokens(name) };
  }

  async connect(name: string, entry: ServerEntry): Promise<Connection> {
    const rt = this.runtime(name);
    if (rt.connection) {
      this.touch(name, entry);
      return rt.connection;
    }
    if (rt.connecting) return rt.connecting;
    // An OAuth server with no stored tokens cannot connect without a browser. Say so instead of
    // letting the SDK attempt client registration with no redirect URI.
    if (entry.auth === "oauth" && this.options.oauth && !this.options.oauth.hasTokens(name) && !this.options.oauth.isInteractive(name)) {
      const error = new AuthorizationRequiredError(name);
      rt.needsAuth = true;
      rt.lastError = error.message;
      rt.failedAt = undefined;
      this.options.onStatusChange?.(name);
      return Promise.reject(error);
    }
    rt.connecting = this.open(name, entry)
      .then((connection) => {
        rt.connection = connection;
        rt.lastError = undefined;
        rt.failedAt = undefined;
        rt.needsAuth = false;
        rt.lastConnectedAt = Date.now();
        this.touch(name, entry);
        this.options.onStatusChange?.(name);
        return connection;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        rt.lastError = message;
        rt.needsAuth =
          error instanceof UnauthorizedError || error instanceof AuthorizationRequiredError || /401|unauthori[sz]ed/i.test(message);
        rt.failedAt = rt.needsAuth ? undefined : Date.now();
        this.options.onStatusChange?.(name);
        throw error;
      })
      .finally(() => {
        rt.connecting = undefined;
      });
    return rt.connecting;
  }

  private async open(name: string, entry: ServerEntry): Promise<Connection> {
    const env = this.options.env ?? process.env;
    const transport = this.makeTransport(name, entry, env);
    const client = new Client(
      { name: this.options.clientName ?? "pid-mcp", version: this.options.clientVersion ?? "0.1.0" },
      { capabilities: {} },
    );
    client.onerror = (error) => {
      const rt = this.runtime(name);
      rt.lastError = error.message;
      this.options.onStatusChange?.(name);
    };
    client.onclose = () => {
      const rt = this.runtime(name);
      if (rt.connection?.client === client) {
        this.clearIdle(rt);
        rt.connection = undefined;
        this.options.onStatusChange?.(name);
      }
    };
    try {
      await client.connect(transport, { timeout: this.requestTimeout(entry) });
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      this.options.onToolListChanged?.(name);
    });
    return { client, transport };
  }

  private makeTransport(name: string, entry: ServerEntry, env: NodeJS.ProcessEnv): Transport {
    const kind = transportOf(entry);
    if (kind === "stdio") {
      const command = interpolateEnv(entry.command!, env);
      const args = (entry.args ?? []).map((a) => interpolateEnv(a, env));
      const childEnv = { ...getDefaultEnvironment(), ...env, ...interpolateRecord(entry.env, env) } as Record<string, string>;
      for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
      return new StdioClientTransport({
        command,
        args,
        env: childEnv,
        cwd: entry.cwd ? expandHome(interpolateEnv(entry.cwd, env)) : undefined,
        stderr: "pipe",
      });
    }
    if (kind === "http") {
      const missing = missingEnvVars(entry.url!, env);
      if (missing.length > 0) throw new Error(`URL for "${name}" references unset env vars: ${missing.join(", ")}`);
      const url = new URL(interpolateEnv(entry.url!, env));
      const headers: Record<string, string> = { ...interpolateRecord(entry.headers, env) };
      const bearer = resolveBearer(entry, env);
      if (bearer) headers.Authorization = `Bearer ${bearer}`;
      const authProvider = entry.auth === "oauth" && this.options.oauth ? this.options.oauth.providerFor(name, entry, url) : undefined;
      const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;
      if (entry.httpTransport === "sse") {
        return new SSEClientTransport(url, { requestInit, authProvider });
      }
      return new StreamableHTTPClientTransport(url, { requestInit, authProvider });
    }
    throw new Error(`Server "${name}" has neither "command" nor "url"`);
  }

  /**
   * Interactive OAuth: open the browser, wait for the loopback redirect, exchange the code, then
   * connect normally with the stored tokens. Resolves once the server is connected.
   */
  async authorize(name: string, entry: ServerEntry): Promise<void> {
    if (entry.auth !== "oauth") throw new Error(`Server "${name}" is not configured with "auth": "oauth"`);
    if (!this.options.oauth) throw new Error("OAuth store unavailable");
    await this.close(name);
    const endInteractive = this.options.oauth.beginInteractive(name);
    try {
      await this.options.oauth.ensureListener(name);
      const env = this.options.env ?? process.env;
      const transport = this.makeTransport(name, entry, env) as StreamableHTTPClientTransport | SSEClientTransport;
      const probe = new Client({ name: "pid-mcp", version: "0.1.0" }, { capabilities: {} });
      try {
        await probe.connect(transport, { timeout: this.requestTimeout(entry) });
        await probe.close();
      } catch (error) {
        if (!(error instanceof UnauthorizedError)) {
          await transport.close().catch(() => undefined);
          throw error;
        }
        const pending = this.options.oauth.pendingFor(name);
        if (!pending) throw new Error(`Authorization for "${name}" did not start`);
        const code = await pending.code;
        await transport.finishAuth(code);
        await transport.close().catch(() => undefined);
      }
      const rt = this.runtime(name);
      rt.needsAuth = false;
      rt.lastError = undefined;
      await this.connect(name, entry);
    } finally {
      endInteractive();
    }
  }

  async listMetadata(name: string, entry: ServerEntry): Promise<ServerMetadata> {
    const { client } = await this.connect(name, entry);
    const tools: CachedTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: this.requestTimeout(entry) });
      for (const t of page.tools) {
        tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema });
      }
      cursor = page.nextCursor;
    } while (cursor);
    let resources: CachedResource[] = [];
    if (client.getServerCapabilities()?.resources) {
      try {
        const page = await client.listResources(undefined, { timeout: this.requestTimeout(entry) });
        resources = page.resources.map((r) => ({ uri: r.uri, name: r.name, description: r.description }));
      } catch {
        resources = [];
      }
    }
    this.touch(name, entry);
    return { tools, resources, instructions: client.getInstructions() };
  }

  async callTool(name: string, entry: ServerEntry, toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallResult> {
    const { client } = await this.connect(name, entry);
    const result = await client.callTool({ name: toolName, arguments: args }, undefined, {
      timeout: this.requestTimeout(entry),
      signal,
      resetTimeoutOnProgress: true,
    });
    this.touch(name, entry);
    const r = result as { content?: unknown[]; structuredContent?: unknown; isError?: boolean };
    return { content: Array.isArray(r.content) ? r.content : [], structuredContent: r.structuredContent, isError: r.isError === true };
  }

  async close(name: string): Promise<void> {
    const rt = this.runtimes.get(name);
    if (!rt?.connection) return;
    const { client, transport } = rt.connection;
    this.clearIdle(rt);
    rt.connection = undefined;
    try {
      await client.close();
    } catch {
      await transport.close().catch(() => undefined);
    }
    this.options.onStatusChange?.(name);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.runtimes.keys()].map((n) => this.close(n)));
  }

  forget(name: string): void {
    this.runtimes.delete(name);
  }

  private requestTimeout(entry: ServerEntry): number {
    const ms = entry.requestTimeoutMs ?? this.options.defaultRequestTimeoutMs;
    return typeof ms === "number" && ms > 0 ? ms : 60_000;
  }

  private touch(name: string, entry: ServerEntry): void {
    const rt = this.runtime(name);
    this.clearIdle(rt);
    if (entry.lifecycle === "keep-alive") return;
    const minutes = entry.idleTimeout ?? this.options.defaultIdleTimeoutMinutes ?? 5;
    if (!(minutes > 0)) return;
    rt.idleTimer = setTimeout(() => void this.close(name), minutes * 60_000);
    rt.idleTimer.unref?.();
  }

  private clearIdle(rt: ServerRuntime): void {
    if (rt.idleTimer) {
      clearTimeout(rt.idleTimer);
      rt.idleTimer = undefined;
    }
  }
}

export function resolveBearer(entry: ServerEntry, env: NodeJS.ProcessEnv): string | undefined {
  if (entry.auth !== "bearer" && !entry.bearerToken && !entry.bearerTokenEnv) return undefined;
  if (typeof entry.bearerToken === "string" && entry.bearerToken) {
    if (entry.bearerToken.startsWith("!!")) return interpolateEnv(entry.bearerToken.slice(1), env);
    if (entry.bearerToken.startsWith("!")) return undefined; // shell-command secrets are not supported
    return interpolateEnv(entry.bearerToken, env);
  }
  if (typeof entry.bearerTokenEnv === "string") return env[entry.bearerTokenEnv];
  return undefined;
}
