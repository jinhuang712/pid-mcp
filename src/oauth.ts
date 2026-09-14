/**
 * OAuth for HTTP servers with `"auth": "oauth"`.
 *
 * The SDK owns discovery, PKCE, dynamic client registration, and token refresh through its
 * `OAuthClientProvider` interface. pid-mcp supplies the three things the SDK cannot: where tokens
 * live on disk, how the browser is opened, and a loopback listener that catches the redirect.
 *
 * Tokens are stored per server at `<agent dir>/pid-mcp/oauth/<server>.json`, readable only by the
 * user. Nothing is copied from pi-mcp-adapter's store; a user switching extensions signs in again.
 */
import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { agentDir } from "./config.ts";
import type { ServerEntry } from "./types.ts";

interface StoredAuth {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
  serverUrl: string;
}

export interface PendingAuthorization {
  serverName: string;
  authorizationUrl: URL;
  redirectUri: string;
  /** Resolves with the authorization code once the browser redirects back. */
  code: Promise<string>;
  cancel(): void;
}

export interface OAuthStoreOptions {
  dir?: string;
  openBrowser?: (url: string) => void;
  onAuthorizationRequired?: (pending: PendingAuthorization) => void;
  env?: NodeJS.ProcessEnv;
}

export class OAuthStore {
  private readonly dir: string;
  private readonly listeners = new Map<string, { server: Server; redirectUri: string }>();
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly options: OAuthStoreOptions;

  constructor(options: OAuthStoreOptions = {}) {
    this.options = options;
    this.dir = options.dir ?? join(agentDir(options.env), "pid-mcp", "oauth");
  }

  private file(serverName: string): string {
    return join(this.dir, `${encodeURIComponent(serverName)}.json`);
  }

  read(serverName: string): StoredAuth | undefined {
    const f = this.file(serverName);
    if (!existsSync(f)) return undefined;
    try {
      return JSON.parse(readFileSync(f, "utf8")) as StoredAuth;
    } catch {
      return undefined;
    }
  }

  private write(serverName: string, data: StoredAuth): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.file(serverName), JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  hasTokens(serverName: string): boolean {
    return this.read(serverName)?.tokens?.access_token !== undefined;
  }

  clear(serverName: string): void {
    rmSync(this.file(serverName), { force: true });
    this.closeListener(serverName);
  }

  pendingFor(serverName: string): PendingAuthorization | undefined {
    return this.pending.get(serverName);
  }

  /** Start a loopback listener for one server's redirect and return its URI. Idempotent. */
  async ensureListener(serverName: string): Promise<string> {
    const existing = this.listeners.get(serverName);
    if (existing) return existing.redirectUri;
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    server.unref();
    this.listeners.set(serverName, { server, redirectUri });
    return redirectUri;
  }

  closeListener(serverName: string): void {
    const l = this.listeners.get(serverName);
    if (!l) return;
    l.server.close();
    this.listeners.delete(serverName);
    this.pending.get(serverName)?.cancel();
    this.pending.delete(serverName);
  }

  providerFor(serverName: string, entry: ServerEntry, serverUrl: URL): OAuthClientProvider {
    const store = this;
    const oauth = entry.oauth && typeof entry.oauth === "object" ? entry.oauth : {};
    const load = (): StoredAuth => {
      const s = store.read(serverName);
      if (s && s.serverUrl === serverUrl.toString()) return s;
      return { serverUrl: serverUrl.toString() };
    };
    const save = (patch: Partial<StoredAuth>) => store.write(serverName, { ...load(), ...patch });
    const redirect = store.listeners.get(serverName)?.redirectUri ?? oauth.redirectUri;

    return {
      get redirectUrl() {
        return redirect;
      },
      get clientMetadata(): OAuthClientMetadata {
        return {
          client_name: oauth.clientName ?? "pid-mcp",
          redirect_uris: redirect ? [redirect] : [],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: oauth.clientSecret ? "client_secret_post" : "none",
          ...(oauth.scope ? { scope: oauth.scope } : {}),
        };
      },
      state() {
        const state = randomBytes(16).toString("hex");
        save({ state });
        return state;
      },
      clientInformation() {
        if (oauth.clientId) {
          return oauth.clientSecret ? { client_id: oauth.clientId, client_secret: oauth.clientSecret } : { client_id: oauth.clientId };
        }
        return load().clientInformation;
      },
      saveClientInformation(info) {
        save({ clientInformation: info });
      },
      tokens() {
        return load().tokens;
      },
      saveTokens(tokens) {
        save({ tokens });
      },
      redirectToAuthorization(authorizationUrl) {
        store.beginAuthorization(serverName, authorizationUrl, redirect);
      },
      saveCodeVerifier(codeVerifier) {
        save({ codeVerifier });
      },
      codeVerifier() {
        const v = load().codeVerifier;
        if (!v) throw new Error(`No PKCE verifier stored for "${serverName}"`);
        return v;
      },
      invalidateCredentials(scope) {
        const current = load();
        if (scope === "all") store.write(serverName, { serverUrl: current.serverUrl });
        else if (scope === "client") save({ clientInformation: undefined });
        else if (scope === "tokens") save({ tokens: undefined });
        else if (scope === "verifier") save({ codeVerifier: undefined });
      },
    };
  }

  private beginAuthorization(serverName: string, authorizationUrl: URL, redirectUri: string | undefined): void {
    const listener = this.listeners.get(serverName);
    let cancel = () => undefined as void;
    const code = new Promise<string>((resolve, reject) => {
      cancel = () => reject(new Error("authorization cancelled"));
      if (!listener) return;
      const expected = this.read(serverName)?.state;
      listener.server.removeAllListeners("request");
      listener.server.on("request", (req, res) => {
        const url = new URL(req.url ?? "/", listener.redirectUri);
        if (url.pathname !== "/callback") {
          res.statusCode = 404;
          res.end();
          return;
        }
        const error = url.searchParams.get("error");
        const state = url.searchParams.get("state");
        const authCode = url.searchParams.get("code");
        res.setHeader("content-type", "text/html; charset=utf-8");
        if (error || !authCode || (expected && state !== expected)) {
          res.statusCode = 400;
          res.end(`<p>pid-mcp: authorization for ${serverName} failed (${error ?? "missing code or state mismatch"}). You can close this tab.</p>`);
          reject(new Error(error ?? "authorization failed"));
          return;
        }
        res.end(`<p>pid-mcp: ${serverName} authorized. You can close this tab and return to Pi.</p>`);
        resolve(authCode);
      });
    });
    code.catch(() => undefined);
    const pending: PendingAuthorization = { serverName, authorizationUrl, redirectUri: redirectUri ?? "", code, cancel };
    this.pending.set(serverName, pending);
    (this.options.openBrowser ?? openInBrowser)(authorizationUrl.toString());
    this.options.onAuthorizationRequired?.(pending);
  }
}

export function openInBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${cmd} ${JSON.stringify(url)}`, () => undefined);
}
