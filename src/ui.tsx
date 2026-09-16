/**
 * The desktop half of this extension.
 *
 * The terminal half is `src/index.ts`; it does the work and publishes a snapshot. This runs in the
 * window and composes the host's own primitives. Neither half knows how the other draws.
 *
 * The two halves sit in different processes, so a click here cannot call a function there. It sends
 * the `/mcp …` command a terminal user would type, which means this page needs no privileged
 * channel and every action it offers is one the terminal already has. That is transport. It stays
 * out of sight: a control says what it does to a server, never which command carries it.
 *
 * The page answers the same two questions the MCP page PID used to draw answered, in this order:
 *
 * 1. **Activated** — which MCP tool calls sit in the model's context right now, across servers.
 *    Each can be removed; a whole server's, or everything at once. This is the list that costs
 *    tokens and decides what the model can reach without `mcp_search`.
 * 2. **MCP Servers** — every server this extension knows, configured or registered by an extension
 *    at runtime, in one list. A row says whether it is connected, ready, needs a sign-in or
 *    failed, and how many of its tools are activated. Opening it lists every tool with its cached
 *    description and an Activate / Remove action, plus an Activate-all.
 *
 * Only primitives: the window's stylesheet is built from the window's own sources, so a utility
 * class no host file uses does not exist by the time this loads.
 *
 * Declared as `"pid": { "ui": "./src/ui.tsx" }`. A host that has never heard of this file loads the
 * other half alone and loses nothing but the page.
 */

import { Action, Badge, Disclosure, Divider, Dot, Eyebrow, Line, Panel, Say, Spread, Stack, Toggle } from "@pid/ui";
import { useState } from "react";
import type { ServerStatusSnapshot, StatusSnapshot, ToolStatusEntry } from "./types.ts";

/** One word per state, one dot per word. "Ready" is the normal resting state: the tool list is
 * indexed and the process starts on the first call. */
const STATUS_TONE: Record<string, "ok" | "warn" | "danger" | "muted" | "accent"> = {
  connected: "ok",
  cached: "muted",
  "not-connected": "muted",
  "needs-auth": "warn",
  disabled: "muted",
  failed: "danger",
};

function ago(seconds: number): string {
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

function agoAt(at: number | undefined): string | undefined {
  if (at === undefined) return undefined;
  const m = Math.round((Date.now() - at) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

const has = (text: string, q: string) => text.toLowerCase().includes(q);

/** A home path reads better shortened; every other path stays absolute. */
function tilde(path: string, home: string | undefined): string {
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** The one thing the page is doing, if it is doing anything. A phrase the reader recognises; the
 * command that carries it never reaches the page. */
interface Busy {
  server?: string;
  doing?: string;
  error?: string;
}

/** How many tools a row lists before the rest fold behind "N more". */
const COLLAPSED_TOOLS = 8;
/** Past this the row never starts collapsed: folding three lines to save three is noise. */
const ALWAYS_OPEN_TOOLS = 12;
/** Same idea for the Activated groups, which are usually short. */
const COLLAPSED_ACTIVATED = 3;
const ALWAYS_OPEN_ACTIVATED = 8;

/** One row of a tool list: the server's own name, the description the cache holds, and its state. */
function ToolLine({
  tool,
  action,
}: {
  tool: ToolStatusEntry;
  action: unknown;
}) {
  return (
    <Line pad={false} gap="wide" title={tool.description ?? tool.piName}>
      <Say mono truncate title={tool.piName}>
        {tool.name}
      </Say>
      {tool.active && <Badge tone="accent">activated</Badge>}
      <Spread />
      <Say tone="soft" truncate>
        {tool.description}
      </Say>
      {action}
    </Line>
  );
}

/** The status words a row is allowed to say, with the dot that says the rest. */
function StatusWords({ s }: { s: ServerStatusSnapshot }) {
  if (s.disabled) return <Say tone="faint">Off</Say>;
  switch (s.status) {
    case "connected":
      return <Say tone="ok">Connected</Say>;
    case "cached":
      return (
        <Say tone="soft">
          Ready · starts on first call{s.cachedAt !== undefined ? ` · cached ${agoAt(s.cachedAt)}` : ""}
        </Say>
      );
    case "not-connected":
      return <Say tone="soft">Not indexed yet · connect once</Say>;
    case "needs-auth":
      return <Say tone="warn">Needs sign-in</Say>;
    case "failed":
      return (
        <Say tone="danger">
          Failed{s.failedAgoSeconds !== undefined ? ` · ${ago(s.failedAgoSeconds)}` : ""}
        </Say>
      );
    default:
      return <Say tone="soft">{s.status}</Say>;
  }
}

function ServerCard({
  s,
  query,
  run,
  busy,
  setBusy,
  home,
}: {
  s: ServerStatusSnapshot;
  query: string;
  run: (c: string) => Promise<unknown>;
  busy: Busy;
  setBusy: (b: Busy) => void;
  home?: string;
}) {
  const [manual, setManual] = useState<boolean | undefined>(undefined);
  const [showAll, setShowAll] = useState(false);
  const tools = s.tools ?? [];
  const active = s.activeToolNames;
  const hits = query ? tools.filter((t) => has(t.name, query) || has(t.piName, query)) : tools;
  // A search that matched inside this server opens it: a row that says "3 match" and stays shut
  // makes the reader click to find what they already asked for.
  const open = manual ?? (query.length > 0 && hits.length > 0);
  const working = busy.doing !== undefined;
  const needsAuth = s.status === "needs-auth" || (s.auth === "oauth" && !s.signedIn && !s.disabled);
  const canActivate = !s.disabled && tools.length > 0;

  /** `doing` is what the reader sees; `command` is how it gets there, and never reaches the page. */
  const send = (doing: string, command: string) => {
    setBusy({ server: s.name, doing });
    void run(command)
      .then(() => setBusy({}))
      .catch((e: unknown) =>
        setBusy({ error: `Could not ${doing} — ${e instanceof Error ? e.message : String(e)}` }),
      );
  };

  const shown = showAll || hits.length <= ALWAYS_OPEN_TOOLS ? hits : hits.slice(0, COLLAPSED_TOOLS);

  return (
    <Panel>
      <Disclosure
        open={open}
        onToggle={() => setManual(!open)}
        lead={
          s.runtimeRegistered ? (
            // Registered by a Pi extension at session start; no config entry, so no switch.
            <Badge title="Registered by a Pi extension at session start; no config entry, so no switch">ext</Badge>
          ) : (
            <Toggle
              value={!s.disabled}
              disabled={working}
              title={s.disabled ? `Turn ${s.name} on` : `Turn ${s.name} off`}
              onChange={(on) =>
                send(`turn ${s.name} ${on ? "on" : "off"}`, `/mcp ${on ? "enable" : "disable"} ${s.name}`)
              }
            />
          )
        }
        summary={
          <>
            <Dot tone={s.disabled ? undefined : (STATUS_TONE[s.status] ?? "muted")} title={s.status} />
            <Say tone={s.disabled ? "faint" : "normal"} truncate>
              {s.name}
            </Say>
            <Badge tone="muted">{s.transport === "unknown" ? "runtime" : s.transport}</Badge>
            {s.auth === "oauth" && <Badge tone="muted">oauth</Badge>}
            <Spread />
            <StatusWords s={s} />
            <Say tone="faint" mono>
              {s.activeToolCount > 0 ? `${s.activeToolCount} of ${s.toolCount} activated` : `${s.toolCount} tool${s.toolCount === 1 ? "" : "s"}`}
            </Say>
          </>
        }
        trail={
          busy.server === s.name && busy.doing ? (
            <Say tone="faint">{busy.doing}…</Say>
          ) : needsAuth ? (
            // The one action that goes on a collapsed row: a server nobody signed into does
            // nothing at all, and burying the fix one click deep means the row states a problem
            // and hides its answer.
            <Action disabled={working} tone="accent" onClick={() => send(`sign in to ${s.name}`, `/mcp auth ${s.name}`)}>
              Sign in
            </Action>
          ) : s.status === "failed" && !s.disabled ? (
            <Action disabled={working} onClick={() => send(`retry ${s.name}`, `/mcp reconnect ${s.name}`)}>
              Retry
            </Action>
          ) : undefined
        }
        className="px-3 py-2"
      >
        <Stack gap="tight" pad={false} className="pb-2">
          <Divider />
          <Line pad={false} gap="wide">
            <Say mono truncate title={s.startedFrom}>
              {s.startedFrom ?? (s.runtimeRegistered ? "the reporting extension gave no definition" : "configured")}
            </Say>
            {s.definedIn && (
              <Say tone="faint">from {s.definedIn.map((p) => tilde(p, home)).join(", ")}</Say>
            )}
            {!s.definedIn && <Say tone="faint">registered by an extension at session start</Say>}
            <Spread />
            {!s.disabled && (
              <Action disabled={working} onClick={() => send(`reconnect ${s.name}`, `/mcp reconnect ${s.name}`)}>
                Reconnect
              </Action>
            )}
            {s.auth === "oauth" && !s.disabled && (
              <Action
                disabled={working}
                tone={s.signedIn ? "soft" : "accent"}
                onClick={() =>
                  send(`sign ${s.signedIn ? "out of" : "in to"} ${s.name}`, `/mcp ${s.signedIn ? "logout" : "auth"} ${s.name}`)
                }
              >
                {s.signedIn ? "Sign out" : "Sign in"}
              </Action>
            )}
            {canActivate && (
              <Action
                disabled={working}
                tone="accent"
                onClick={() => send(`activate every tool of ${s.name}`, `/mcp activate ${s.name}`)}
              >
                Activate all
              </Action>
            )}
          </Line>
          {s.lastError && (
            <Line pad={false}>
              <Say tone="danger" truncate title={s.lastError}>
                last error: {s.lastError}
              </Say>
            </Line>
          )}
          {s.status === "needs-auth" && tools.length > 0 && (
            <Line pad={false}>
              <Say tone="faint">
                {tools.length} tool calls stay indexed; calling one fails until you sign in again.
              </Say>
            </Line>
          )}
          {tools.length === 0 && (
            <Line pad={false}>
              <Say tone="faint">No tool list yet — Reconnect fetches it.</Say>
            </Line>
          )}
          {shown.map((t) => (
            <ToolLine
              key={t.piName}
              tool={t}
              action={
                s.disabled ? undefined : t.active ? (
                  <Action
                    disabled={working}
                    onClick={() => send(`deactivate ${t.name}`, `/mcp deactivate ${s.name} ${t.piName}`)}
                  >
                    Remove
                  </Action>
                ) : (
                  <Action
                    disabled={working}
                    tone="accent"
                    onClick={() => send(`activate ${t.name}`, `/mcp activate ${s.name} ${t.piName}`)}
                  >
                    Activate
                  </Action>
                )
              }
            />
          ))}
          {shown.length < hits.length && (
            <Line pad={false}>
              <Action tone="soft" onClick={() => setShowAll(true)}>
                {hits.length - shown.length} more · show all
              </Action>
            </Line>
          )}
          {query && hits.length === 0 && tools.length > 0 && (
            <Line pad={false}>
              <Say tone="faint">no tool here matches</Say>
            </Line>
          )}
        </Stack>
      </Disclosure>
    </Panel>
  );
}

/** The Activated section: one group per server that has active tools, each tool removable. */
function Activated({
  servers,
  run,
  busy,
  setBusy,
}: {
  servers: ServerStatusSnapshot[];
  run: (c: string) => Promise<unknown>;
  busy: Busy;
  setBusy: (b: Busy) => void;
}) {
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const working = busy.doing !== undefined;
  const send = (doing: string, command: string) => {
    setBusy({ doing });
    void run(command)
      .then(() => setBusy({}))
      .catch((e: unknown) =>
        setBusy({ error: `Could not ${doing} — ${e instanceof Error ? e.message : String(e)}` }),
      );
  };

  const groups = servers
    .map((s) => ({ s, tools: (s.tools ?? []).filter((t) => t.active) }))
    .filter((g) => g.tools.length > 0);
  const count = groups.reduce((n, g) => n + g.tools.length, 0);

  return (
    <Stack pad={false} gap="tight">
      <Line pad={false}>
        <Eyebrow>Activated</Eyebrow>
        <Say tone="faint">
          {count === 0
            ? "nothing in the model's context yet · mcp_search or Activate below puts a tool call here"
            : `${count} tool call${count === 1 ? "" : "s"} in the model's context right now`}
        </Say>
        <Spread />
        {count > 0 && (
          <Action
            disabled={working}
            onClick={() => send("take every MCP tool out of the model's view", "/mcp deactivate")}
          >
            Remove all
          </Action>
        )}
      </Line>
      {groups.map(({ s, tools }) => {
        const key = `act:${s.name}`;
        const expanded = showAll[key] || tools.length <= ALWAYS_OPEN_ACTIVATED;
        const shown = expanded ? tools : tools.slice(0, COLLAPSED_ACTIVATED);
        return (
          <Panel key={s.name} className="px-3 py-2">
            <Line pad={false}>
              <Say tone="soft">{s.name}</Say>
              <Say tone="faint">· {tools.length}</Say>
              {s.pinnedToolCount > 0 && <Say tone="faint">· {s.pinnedToolCount} by config</Say>}
              <Spread />
              <Action
                disabled={working}
                onClick={() => send(`deactivate every tool of ${s.name}`, `/mcp deactivate ${s.name}`)}
              >
                Remove {tools.length}
              </Action>
            </Line>
            {shown.map((t) => (
              <ToolLine
                key={t.piName}
                tool={t}
                action={
                  <Action
                    disabled={working}
                    onClick={() => send(`deactivate ${t.name}`, `/mcp deactivate ${s.name} ${t.piName}`)}
                  >
                    Remove
                  </Action>
                }
              />
            ))}
            {!expanded && (
              <Action tone="soft" onClick={() => setShowAll((m) => ({ ...m, [key]: true }))}>
                {tools.length - shown.length} more · show
              </Action>
            )}
          </Panel>
        );
      })}
    </Stack>
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

/** Servers a query keeps: the name matched, or one of its tools did — active or not. */
function matching(servers: ServerStatusSnapshot[], query: string): ServerStatusSnapshot[] {
  const q = query.trim().toLowerCase();
  if (!q) return servers;
  return servers.filter((s) => has(s.name, q) || (s.tools ?? []).some((t) => has(t.name, q) || has(t.piName, q)));
}

function Page({ ctx }: { ctx: Ctx }) {
  const [busy, setBusy] = useState<Busy>({});
  const snap = snapshot(ctx.state);
  const home = snap?.home;
  if (!snap) return <Say tone="faint">No snapshot yet — open a session and this fills in.</Say>;
  const servers = [...snap.servers].sort((a, b) => a.name.localeCompare(b.name));
  const q = ctx.query.trim().toLowerCase();
  const kept = matching(servers, ctx.query);
  const indexed = servers.reduce((n, s) => n + s.toolCount, 0);
  return (
    <Stack pad={false} gap="wide">
      {busy.error && (
        <Say tone="danger" title={busy.error}>
          {busy.error}
        </Say>
      )}
      <Activated servers={servers} run={ctx.run} busy={busy} setBusy={setBusy} />
      <Stack pad={false} gap="tight">
        <Line pad={false}>
          <Eyebrow>MCP Servers</Eyebrow>
          <Say tone="faint">
            {servers.length} server{servers.length === 1 ? "" : "s"} · {indexed} tool calls indexed
          </Say>
          <Spread />
          {snap.cachePath && (
            <Say tone="faint" title={snap.cachePath}>
              cache {tilde(snap.cachePath ?? "", home)}
            </Say>
          )}
        </Line>
        {kept.map((s) => (
          <ServerCard key={s.name} s={s} query={q} run={ctx.run} busy={busy} setBusy={setBusy} home={home} />
        ))}
        {kept.length === 0 && (
          <Say tone="faint">{q ? "Nothing matches." : "No servers configured."}</Say>
        )}
        <Say tone="faint">
          The switch writes <Say mono>disabled: true</Say> to the config file; running sessions apply
          it after <Say mono>/reload</Say>. <Say mono>ext</Say> servers come from an extension and
          have no switch here.
        </Say>
      </Stack>
    </Stack>
  );
}

export default function register(pid: Api) {
  pid.page({
    label: "MCP",
    search: "Search servers and tools…",
    note: (ctx) => {
      const snap = snapshot(ctx.state);
      if (!snap) return null;
      return (
        <Line pad={false}>
          <Say tone="faint">
            {snap.connectedCount}/{snap.servers.length - snap.disabledCount} connected ·{" "}
            {snap.activeToolCount} of {snap.totalTools} tools active · pid-mcp {snap.pidMcpVersion}
          </Say>
          <Spread />
          <Action onClick={() => void ctx.run("/mcp refresh")}>Refresh</Action>
        </Line>
      );
    },
    render: (ctx) => <Page ctx={ctx} />,
  });
}
