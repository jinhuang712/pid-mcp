/**
 * The page this extension asks a graphical host to draw.
 *
 * A terminal gets a status line and `/mcp`. A window can show every server, what each is doing and
 * the buttons to act on it — but the host cannot be expected to know what an MCP server is. So this
 * describes the page as data: rows, badges, a switch, some buttons. The host renders the shape and
 * learns nothing about MCP; each affordance is a `/mcp …` command it hands straight back, which is
 * the same command a terminal user would type.
 *
 * Published under `pid-mcp:page/v1`. A host with no renderer for that kind simply shows nothing,
 * and a host that has never heard of this extension shows no entry at all.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ServerStatusSnapshot, StatusSnapshot } from "./types.ts";

export const PAGE_WIDGET_KEY = "pid-mcp:page/v1";

type Tone = "ok" | "warn" | "danger" | "muted" | "accent";

interface Badge {
  text: string;
  tone?: Tone;
}
interface Action {
  label: string;
  command: string;
  tone?: Tone;
}
interface Row {
  id: string;
  title: string;
  subtitle?: string;
  badges?: Badge[];
  toggle?: { value: boolean; on: string; off: string };
  actions?: Action[];
  details?: { label: string; value: string }[];
  rows?: Row[];
}
export interface Page {
  title: string;
  note?: string;
  sections: { title?: string; note?: string; rows: Row[] }[];
}

/** How many of a server's tools to list. Past this the page is a wall, and `/mcp tools` is better. */
const MAX_TOOLS = 40;

const STATUS_TONE: Record<string, Tone> = {
  connected: "ok",
  cached: "muted",
  connecting: "muted",
  disabled: "muted",
  failed: "danger",
};

export function buildPage(snapshot: StatusSnapshot): Page {
  const servers = [...snapshot.servers].sort((a, b) => a.name.localeCompare(b.name));
  const note =
    `${snapshot.connectedCount}/${servers.length} connected · ` +
    `${snapshot.activeToolCount}/${snapshot.totalTools} tools active` +
    (snapshot.disabledCount ? ` · ${snapshot.disabledCount} off` : "");
  return {
    title: "MCP",
    note,
    sections: servers.length ? [{ rows: servers.map(serverRow) }] : [],
  };
}

function serverRow(s: ServerStatusSnapshot): Row {
  const badges: Badge[] = [{ text: s.status, tone: STATUS_TONE[s.status] ?? "muted" }];
  if (s.transport !== "unknown") badges.push({ text: s.transport });
  if (s.runtimeRegistered) badges.push({ text: "runtime" });
  if (s.activeToolCount) badges.push({ text: `${s.activeToolCount} active`, tone: "accent" });

  const actions: Action[] = [];
  // Only offer what the server's state makes meaningful: a disabled server has nothing to reconnect.
  if (!s.disabled) {
    actions.push({ label: "Reconnect", command: `/mcp reconnect ${s.name}` });
    if (s.lastError?.toLowerCase().includes("auth")) {
      actions.push({ label: "Sign in", command: `/mcp auth ${s.name}`, tone: "warn" });
    } else {
      actions.push({ label: "Sign out", command: `/mcp logout ${s.name}` });
    }
  }

  const details: { label: string; value: string }[] = [
    { label: "tools", value: `${s.activeToolCount} active of ${s.toolCount}` },
  ];
  if (s.pinnedToolCount) details.push({ label: "pinned", value: String(s.pinnedToolCount) });
  if (s.lastError) details.push({ label: "last error", value: s.lastError });

  return {
    id: s.name,
    title: s.name,
    ...(s.toolCount ? { subtitle: `${s.toolCount} tools` } : {}),
    badges,
    toggle: { value: !s.disabled, on: `/mcp enable ${s.name}`, off: `/mcp disable ${s.name}` },
    ...(actions.length ? { actions } : {}),
    details,
    ...(s.activeToolNames.length ? { rows: toolRows(s) } : {}),
  };
}

function toolRows(s: ServerStatusSnapshot): Row[] {
  return s.activeToolNames.slice(0, MAX_TOOLS).map((name) => ({
    id: `${s.name}:${name}`,
    title: name,
    badges: [{ text: "active", tone: "accent" as const }],
    actions: [{ label: "Deactivate", command: `/mcp deactivate ${s.name} ${name}` }],
  }));
}

/** Publish or clear the page. Safe in any mode: a terminal draws its own. */
export function publishPage(ctx: ExtensionContext | undefined, page: Page | undefined): void {
  if (!ctx || !ctx.hasUI || ctx.mode === "tui") return;
  try {
    ctx.ui.setWidget(PAGE_WIDGET_KEY, page ? [JSON.stringify(page)] : undefined);
  } catch {
    // The page must never break the session.
  }
}
