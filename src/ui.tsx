/**
 * The desktop half of this extension.
 *
 * The terminal half is `src/index.ts`; it does the work and publishes a snapshot. This runs in the
 * window, composes the host's own primitives, and turns each affordance into the same `/mcp …`
 * command a terminal user would type. Neither half knows how the other draws.
 *
 * Only primitives: the window's stylesheet is built from the window's own sources, so a utility
 * class no host file uses does not exist by the time this loads.
 *
 * Declared as `"pid": { "ui": "./src/ui.tsx" }`. A host that has never heard of this file loads the
 * other half alone and loses nothing but the page.
 */

import { Action, Badge, Divider, Eyebrow, Inline, Line, Num, Panel, Row, Say, Spread, Stack, Toggle } from "@pid/ui";
import type { ServerStatusSnapshot, StatusSnapshot } from "./types.ts";

type Tone = "ok" | "warn" | "danger" | "muted" | "accent";

const STATUS_TONE: Record<string, Tone> = {
  connected: "ok",
  cached: "muted",
  connecting: "muted",
  "needs-auth": "warn",
  disabled: "muted",
  failed: "danger",
};

/**
 * One row per OAuth server, answering the only question an account section should: can this one
 * act right now. Never a green light it has not earned — `signedIn` is the token store's answer,
 * not an inference from a successful connection.
 */
function Account({ s, run }: { s: ServerStatusSnapshot; run: (c: string) => Promise<unknown> }) {
  return (
    <Line>
      <Say truncate>{s.name}</Say>
      <Say tone="faint">OAuth</Say>
      {s.signedIn ? (
        <Badge tone="ok">Signed in</Badge>
      ) : s.disabled ? (
        <Badge>Off</Badge>
      ) : (
        <Badge tone="warn">Needs sign-in</Badge>
      )}
      <Spread />
      {!s.signedIn && !s.disabled && (
        <Action tone="accent" onClick={() => void run(`/mcp auth ${s.name}`)}>
          Sign in
        </Action>
      )}
    </Line>
  );
}

/** How many of a server's tools to list. Past this the page is a wall, and `/mcp tools` is better. */
const MAX_TOOLS = 40;

function Server({ s, run }: { s: ServerStatusSnapshot; run: (c: string) => Promise<unknown> }) {
  const tools = s.activeToolNames.slice(0, MAX_TOOLS);
  const needsAuth = s.lastError?.toLowerCase().includes("auth") ?? false;
  return (
    <Panel>
      <Line>
        <Toggle
          value={!s.disabled}
          title={s.disabled ? "Turn on" : "Turn off"}
          onChange={(on) => void run(`/mcp ${on ? "enable" : "disable"} ${s.name}`)}
        />
        <Say truncate>{s.name}</Say>
        <Badge tone={STATUS_TONE[s.status] ?? "muted"}>{s.status}</Badge>
        {s.transport !== "unknown" && <Badge>{s.transport}</Badge>}
        {s.runtimeRegistered && <Badge>runtime</Badge>}
        {s.activeToolCount > 0 && <Badge tone="accent">{s.activeToolCount} active</Badge>}
        <Spread />
        <Num className="text-ink-3">
          {s.activeToolCount}/{s.toolCount}
        </Num>
        {!s.disabled && (
          <Inline>
            <Action onClick={() => void run(`/mcp reconnect ${s.name}`)}>Reconnect</Action>
            <Action
              tone={needsAuth ? "accent" : "soft"}
              onClick={() => void run(`/mcp ${needsAuth ? "auth" : "logout"} ${s.name}`)}
            >
              {needsAuth ? "Sign in" : "Sign out"}
            </Action>
          </Inline>
        )}
      </Line>
      {s.lastError && (
        <Line>
          <Say tone="danger" truncate title={s.lastError}>
            {s.lastError}
          </Say>
        </Line>
      )}
      {tools.length > 0 && (
        <>
          <Divider />
          {tools.map((name) => (
            <Row key={name} onClick={() => void run(`/mcp deactivate ${s.name} ${name}`)}>
              <Badge tone="accent">active</Badge>
              <Say truncate>{name}</Say>
              <Spread />
              <Say tone="faint">Deactivate</Say>
            </Row>
          ))}
        </>
      )}
    </Panel>
  );
}

interface Api {
  readonly id: string;
  page: (spec: { label?: string; render: (ctx: Ctx) => unknown }) => void;
}
interface Ctx {
  state: unknown;
  run: (command: string) => Promise<unknown>;
}

export default function register(pid: Api) {
  pid.page({
    label: "MCP",
    render: ({ state, run }: Ctx) => {
      const snap = state as StatusSnapshot | undefined;
      if (!snap) {
        return (
          <Line>
            <Say tone="faint">No snapshot yet.</Say>
          </Line>
        );
      }
      const servers = [...snap.servers].sort((a, b) => a.name.localeCompare(b.name));
      const accounts = servers.filter((s) => s.auth === "oauth");
      return (
        <Stack>
          <Line pad={false}>
            <Say tone="faint">
              {snap.connectedCount}/{servers.length} connected · {snap.activeToolCount}/
              {snap.totalTools} tools active
              {snap.disabledCount ? ` · ${snap.disabledCount} off` : ""}
            </Say>
          </Line>
          {accounts.length > 0 && (
            <Panel>
              <Line>
                <Eyebrow>Accounts</Eyebrow>
                <Say tone="faint">OAuth sign-in per server. Nothing here touches a terminal session.</Say>
              </Line>
              <Divider />
              {accounts.map((s) => (
                <Account key={s.name} s={s} run={run} />
              ))}
            </Panel>
          )}
          {servers.map((s) => (
            <Server key={s.name} s={s} run={run} />
          ))}
        </Stack>
      );
    },
  });
}
