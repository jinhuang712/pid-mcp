/**
 * The snapshot this extension hands a graphical host.
 *
 * A terminal gets a status line and `/mcp`. A window has room for the servers themselves, so the
 * snapshot crosses as JSON under this extension's own name and the desktop half — `src/ui.tsx` —
 * decides what to draw with it. The host routes the lines back by name and reads none of them.
 *
 * `setWidget` is Pi's own fire-and-forget channel and the key is an identity, nothing more. Safe in
 * any mode: a terminal draws its own and never sees this.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { StatusSnapshot } from "./types.ts";

export const HOST_KEY = "pid-mcp";

export function publishSnapshot(ctx: ExtensionContext | undefined, snapshot: StatusSnapshot | undefined): void {
  if (!ctx || !ctx.hasUI || ctx.mode === "tui") return;
  try {
    ctx.ui.setWidget(HOST_KEY, snapshot ? [JSON.stringify(snapshot)] : undefined);
  } catch {
    // Presentation must never break the session.
  }
}
