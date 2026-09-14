/**
 * Which pid-mcp tools the model can see.
 *
 * Pi registers every tool active. At session start pid-mcp removes its own unpinned tools from the
 * active set and leaves everything else exactly as it was. `mcp_search` adds tools back, never
 * removes. The only subtraction after session start is an explicit `/mcp reset-tools`.
 */
export const SEARCH_TOOL_NAME = "mcp_search";

export interface ActivationApi {
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

export interface ActivationResult {
  requested: string[];
  added: string[];
  alreadyActive: string[];
}

export class ToolActivator {
  private readonly owned = new Set<string>();
  private readonly pinned = new Set<string>();
  private readonly searchActivated = new Set<string>();
  private readonly api: ActivationApi;

  constructor(api: ActivationApi) {
    this.api = api;
  }

  /** Record a tool as pid-mcp's, replacing pin state if it was known before. */
  own(name: string, pinned: boolean): void {
    this.owned.add(name);
    if (pinned) this.pinned.add(name);
    else this.pinned.delete(name);
  }

  forget(name: string): void {
    this.owned.delete(name);
    this.pinned.delete(name);
    this.searchActivated.delete(name);
  }

  isOwned(name: string): boolean {
    return this.owned.has(name);
  }

  isPinned(name: string): boolean {
    return this.pinned.has(name);
  }

  ownedNames(): string[] {
    return [...this.owned];
  }

  pinnedNames(): string[] {
    return [...this.pinned];
  }

  activeOwnedNames(): string[] {
    const active = new Set(this.api.getActiveTools());
    return [...this.owned].filter((n) => active.has(n));
  }

  /**
   * Bring the active set to pid-mcp's baseline: every non-owned tool untouched, pinned tools and
   * search-activated tools present, unpinned owned tools absent, and mcp_search present.
   */
  applyBaseline(): void {
    const current = this.api.getActiveTools();
    const next = current.filter((n) => !this.owned.has(n) || this.pinned.has(n) || this.searchActivated.has(n));
    for (const p of this.pinned) if (!next.includes(p)) next.push(p);
    for (const s of this.searchActivated) if (this.owned.has(s) && !next.includes(s)) next.push(s);
    if (!next.includes(SEARCH_TOOL_NAME)) next.push(SEARCH_TOOL_NAME);
    if (!sameSet(current, next)) this.api.setActiveTools(next);
  }

  /** Additive activation. Never removes anything. */
  activate(names: readonly string[]): ActivationResult {
    const active = this.api.getActiveTools();
    const activeSet = new Set(active);
    const added: string[] = [];
    const alreadyActive: string[] = [];
    for (const name of names) {
      if (!this.owned.has(name)) continue;
      if (activeSet.has(name)) {
        alreadyActive.push(name);
        continue;
      }
      activeSet.add(name);
      added.push(name);
      this.searchActivated.add(name);
    }
    if (added.length > 0) this.api.setActiveTools([...active, ...added]);
    return { requested: [...names], added, alreadyActive };
  }

  /** Explicit reset: drop search activations, keep pins. Called only from a user command. */
  reset(): string[] {
    const dropped = [...this.searchActivated];
    this.searchActivated.clear();
    const current = this.api.getActiveTools();
    const next = current.filter((n) => !this.owned.has(n) || this.pinned.has(n));
    if (!next.includes(SEARCH_TOOL_NAME)) next.push(SEARCH_TOOL_NAME);
    this.api.setActiveTools(next);
    return dropped;
  }

  /** New session: search activations do not carry over. */
  clearSession(): void {
    this.searchActivated.clear();
  }

  /** The search activations to hand to the instance Pi builds on `/reload`. */
  exportActivations(): string[] {
    return [...this.searchActivated];
  }

  /**
   * Take over activations from the instance `/reload` replaced. Pi keeps its active tool set across a
   * reload, so the model still believes these tools exist; dropping them at baseline made every one
   * of them "Tool ... not found" until the next mcp_search. Names not owned are ignored at baseline.
   */
  adopt(names: readonly string[]): void {
    for (const n of names) this.searchActivated.add(n);
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}
