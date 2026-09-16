/**
 * The desktop half of this extension.
 *
 * The terminal half is `src/index.ts`; it does the work and publishes a snapshot. This runs in the
 * window, composes the host's own primitives, and turns each affordance into the same `/mcp …`
 * command a terminal user would type. Neither half knows how the other draws.
 *
 * What the page is for: five servers and a hundred and fifty tools, and the reader wants one of
 * three things — is anything broken, where is the tool I am looking for, and turn that off. So the
 * collapsed row answers the first, the host's search box answers the second, and the switch answers
 * the third. Everything else — the transport, the cache age, reconnecting, signing out — is a
 * detail of one server and lives inside that server's row, because a detail repeated on every row
 * is not a detail, it is wallpaper.
 *
 * Only primitives: the window's stylesheet is built from the window's own sources, so a utility
 * class no host file uses does not exist by the time this loads.
 *
 * Declared as `"pid": { "ui": "./src/ui.tsx" }`. A host that has never heard of this file loads the
 * other half alone and loses nothing but the page.
 */

import { Action, Badge, Disclosure, Divider, Dot, Inline, Line, Panel, Row, Say, Spread, Stack, Toggle } from "@pid/ui";
import { useState } from "react";
import type { ServerStatusSnapshot, StatusSnapshot } from "./types.ts";

type Tone = "ok" | "warn" | "danger" | "muted" | "accent";

/**
 * One dot per server, and the word only when the dot is not enough.
 *
 * This replaced three grey pills on every row — the status, the transport, and whether the server
 * was registered at runtime. Repeated five times they said nothing; a reader scanning for trouble
 * was scanning identical text. The transport and the rest moved inside the row.
 */
const STATUS_TONE: Record<string, Tone> = {
  connected: "ok",
  cached: "muted",
  connecting: "muted",
  "needs-auth": "warn",
  disabled: "muted",
  failed: "danger",
};

/** Said out loud only when it is not the state a reader assumes. */
const QUIET = new Set(["connected", "cached"]);

function ago(at: number | undefined): string | undefined {
  if (at === undefined) return undefined;
  const m = Math.round((Date.now() - at) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

const has = (text: string, q: string) => text.toLowerCase().includes(q);

/** How many of a server's tools to list. Past this the row is a wall, and the search box is better. */
const MAX_TOOLS = 60;

interface Busy {
  /** The command in flight, so every affordance can be disabled while one runs. */
  command?: string;
  error?: string;
}

function Server({
  s,
  query,
  run,
  busy,
  setBusy,
}: {
  s: ServerStatusSnapshot;
  query: string;
  run: (c: string) => Promise<unknown>;
  busy: Busy;
  setBusy: (b: Busy) => void;
}) {
  const [manual, setManual] = useState<boolean | undefined>(undefined);
  const tools = s.activeToolNames;
  const hits = query ? tools.filter((t) => has(t, query)) : tools;
  // A search that matched inside this server opens it: a row that says "3 match" and stays shut
  // makes the reader click to find what they already asked for.
  const open = manual ?? (query.length > 0 && hits.length > 0);
  const shown = hits.slice(0, MAX_TOOLS);
  const needsAuth = s.status === "needs-auth" || (s.auth === "oauth" && !s.signedIn && !s.disabled);
  const working = busy.command !== undefined;
  const send = (command: string) => {
    setBusy({ command });
    void run(command)
      .then(() => setBusy({}))
      .catch((e: unknown) => setBusy({ error: `${command}: ${e instanceof Error ? e.message : String(e)}` }));
  };

  return (
    <Panel>
      <Disclosure
        open={open}
        onToggle={() => setManual(!open)}
        lead={
          <Toggle
            value={!s.disabled}
            disabled={working}
            title={s.disabled ? `Turn ${s.name} on` : `Turn ${s.name} off`}
            onChange={(on) => send(`/mcp ${on ? "enable" : "disable"} ${s.name}`)}
          />
        }
        summary={
          <>
            <Dot tone={s.disabled ? undefined : (STATUS_TONE[s.status] ?? "muted")} title={s.status} />
            <Say tone={s.disabled ? "faint" : "normal"} truncate>
              {s.name}
            </Say>
            {!QUIET.has(s.status) && !s.disabled && (
              <Say tone={STATUS_TONE[s.status] === "danger" ? "danger" : "warn"}>{s.status}</Say>
            )}
            <Spread />
            {/* One number, not two: how much of this server the model can actually reach. */}
            <Say tone="faint" mono>
              {s.activeToolCount > 0 ? `${s.activeToolCount}/${s.toolCount} active` : `${s.toolCount} tools`}
            </Say>
          </>
        }
        trail={
          busy.command?.endsWith(s.name) ? (
            <Say tone="faint">working…</Say>
          ) : needsAuth ? (
            // The one action that goes on a collapsed row: a server nobody signed into does nothing
            // at all, and burying the fix one click deep means the row states a problem and hides
            // its answer.
            <Action disabled={working} tone="accent" onClick={() => send(`/mcp auth ${s.name}`)}>
              Sign in
            </Action>
          ) : undefined
        }
        className="px-3 py-2"
      >
        <Stack gap="tight" pad={false} className="pb-1.5">
          <Line pad={false} gap="wide">
            <Say tone="faint">{s.transport === "unknown" ? "transport unknown" : s.transport}</Say>
            {s.runtimeRegistered && <Say tone="faint">registered at runtime</Say>}
            {ago(s.cachedAt) && <Say tone="faint">cached {ago(s.cachedAt)}</Say>}
            {s.auth === "oauth" && (
              <Say tone={s.signedIn ? "faint" : "warn"}>{s.signedIn ? "signed in" : "not signed in"}</Say>
            )}
            <Spread />
            {!s.disabled && (
              <Inline>
                <Action disabled={working} onClick={() => send(`/mcp reconnect ${s.name}`)}>
                  Reconnect
                </Action>
                {s.auth === "oauth" && (
                  <Action
                    disabled={working}
                    tone={s.signedIn ? "soft" : "accent"}
                    onClick={() => send(`/mcp ${s.signedIn ? "logout" : "auth"} ${s.name}`)}
                  >
                    {s.signedIn ? "Sign out" : "Sign in"}
                  </Action>
                )}
              </Inline>
            )}
          </Line>
          {s.lastError && (
            <Line pad={false}>
              <Say tone="danger" truncate title={s.lastError}>
                {s.lastError}
              </Say>
            </Line>
          )}
          {shown.length > 0 && (
            <>
              <Divider />
              {shown.map((name) => (
                <Row key={name} disabled={working} onClick={() => send(`/mcp deactivate ${s.name} ${name}`)}>
                  <Say truncate mono>
                    {name}
                  </Say>
                  <Spread />
                  <Say tone="faint">Deactivate</Say>
                </Row>
              ))}
              {hits.length > shown.length && (
                <Line pad={false}>
                  <Say tone="faint">{hits.length - shown.length} more — narrow the search</Say>
                </Line>
              )}
            </>
          )}
          {query && hits.length === 0 && tools.length > 0 && (
            <Line pad={false}>
              <Say tone="faint">no active tool here matches</Say>
            </Line>
          )}
        </Stack>
      </Disclosure>
    </Panel>
  );
}

interface Ctx {
  state: unknown;
  run: (command: string) => Promise<unknown>;
  query: string;
}

interface Api {
  readonly id: string;
  page: (spec: {
    label?: string;
    note?: (ctx: Ctx) => unknown;
    search?: string;
    render: (ctx: Ctx) => unknown;
  }) => void;
}

const snapshot = (state: unknown) => state as StatusSnapshot | undefined;

/** Servers a query keeps: the name matched, or one of the tools it has active did. */
function matching(servers: ServerStatusSnapshot[], query: string): ServerStatusSnapshot[] {
  const q = query.trim().toLowerCase();
  if (!q) return servers;
  return servers.filter((s) => has(s.name, q) || s.activeToolNames.some((t) => has(t, q)));
}

function Page({ ctx }: { ctx: Ctx }) {
  const [busy, setBusy] = useState<Busy>({});
  const snap = snapshot(ctx.state);
  if (!snap) return <Say tone="faint">No snapshot yet — open a session and this fills in.</Say>;
  const servers = [...snap.servers].sort((a, b) => a.name.localeCompare(b.name));
  const q = ctx.query.trim().toLowerCase();
  const kept = matching(servers, ctx.query);
  return (
    <Stack pad={false}>
      {busy.error && (
        <Say tone="danger" title={busy.error}>
          {busy.error}
        </Say>
      )}
      {kept.map((s) => (
        <Server key={s.name} s={s} query={q} run={ctx.run} busy={busy} setBusy={setBusy} />
      ))}
      {kept.length === 0 && (
        <Say tone="faint">{q ? "Nothing matches." : "No servers configured."}</Say>
      )}
    </Stack>
  );
}

export default function register(pid: Api) {
  pid.page({
    label: "MCP",
    search: "Search servers and active tools…",
    note: (ctx) => {
      const snap = snapshot(ctx.state);
      if (!snap) return null;
      const trouble = snap.servers.filter((s) => !s.disabled && (s.status === "failed" || s.status === "needs-auth"));
      return (
        <Inline gap="normal">
          <Say tone="faint">
            {snap.connectedCount}/{snap.servers.length} connected · {snap.activeToolCount} of {snap.totalTools} tools
            active
            {snap.disabledCount ? ` · ${snap.disabledCount} off` : ""}
          </Say>
          {trouble.length > 0 && <Badge tone="warn">{trouble.map((s) => s.name).join(", ")}</Badge>}
        </Inline>
      );
    },
    render: (ctx) => <Page ctx={ctx} />,
  });
}
