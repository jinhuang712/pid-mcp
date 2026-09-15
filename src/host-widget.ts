/**
 * Status for a host that draws, but not in a terminal.
 *
 * A terminal shows `ctx.ui.setStatus("mcp", …)` — one line, which is all a status bar can hold.
 * A graphical host can show the servers, their tools and what needs authorizing, so it gets the
 * snapshot itself as JSON on the widget channel, under `<ns>:<kind>/v<n>`.
 *
 * This used to be done for pid-mcp by a relay shipped inside PID, which meant PID's own code named
 * this extension and its channels. Publishing here instead keeps that knowledge where the data is:
 * the host reads a kind, not a product.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const STATUS_WIDGET_KEY = "pid-mcp:mcp-status/v1";
export const OAUTH_WIDGET_KEY = "pid-mcp:mcp-oauth/v1";

/** A host that draws, but not in a terminal. `hasUI` alone is true in a terminal too. */
export function wantsWidget(ctx: ExtensionContext | undefined): boolean {
  return !!ctx && ctx.hasUI && ctx.mode !== "tui";
}

/** Where a runtime-registered server is started from; mirrors the entry the caller registered. */
export interface RuntimeDefinition {
  command?: string;
  args?: string[];
  url?: string;
}

/**
 * Attach `runtime` to every server that was registered at runtime rather than read from an
 * mcp.json. A host has no other way to tell the two apart, and a runtime server has no config
 * entry to look up — so without this it can list the server but never say where it came from.
 */
export function withRuntimeDefinitions(
  snapshot: unknown,
  definition: (name: string) => RuntimeDefinition | undefined,
): unknown {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const servers = (snapshot as { servers?: unknown }).servers;
  if (!Array.isArray(servers)) return snapshot;
  return {
    ...(snapshot as object),
    servers: servers.map((server) => {
      const name = (server as { name?: unknown } | null)?.name;
      if (typeof name !== "string") return server;
      const runtime = definition(name);
      return runtime ? { ...(server as object), runtime } : server;
    }),
  };
}

/** Publish or clear one widget. Safe in any mode: in a terminal it does nothing. */
export function publishWidget(ctx: ExtensionContext | undefined, key: string, payload: unknown): void {
  if (!wantsWidget(ctx) || !ctx) return;
  try {
    ctx.ui.setWidget(key, payload === undefined ? undefined : [JSON.stringify(payload)]);
  } catch {
    // Status must never break the session.
  }
}
