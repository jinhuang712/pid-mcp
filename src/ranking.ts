/**
 * Lexical ranking for `mcp_search`.
 *
 * Tool names are structured text: `query_log`, `monitor_rpc`, `getIssueComments`. Splitting on
 * underscores, hyphens, dots and camelCase gives tokens that match how people ask for things. That is
 * enough for catalogs in the hundreds. The `Ranker` interface is the seam for a hybrid lexical plus
 * embedding ranker later, following the recall numbers in arXiv:2607.15593 for catalogs in the
 * thousands; the search tool's API does not change when the ranker does.
 */
import type { CatalogTool } from "./types.ts";

export interface RankedTool {
  tool: CatalogTool;
  score: number;
}

export interface Ranker {
  rank(query: string, tools: readonly CatalogTool[], limit: number): RankedTool[];
}

const FIELD_WEIGHTS = { name: 12, originalName: 10, server: 8, description: 5, keywords: 5 } as const;
const MIN_STEM_LENGTH = 4;

/** Common abbreviations in tool names. Extend via `settings.searchSynonyms` later if needed. */
const SYNONYMS: Record<string, string[]> = {
  db: ["database"],
  k8s: ["kubernetes"],
  mq: ["queue", "kafka", "message"],
  kmq: ["queue", "kafka", "message"],
  es: ["elasticsearch", "search"],
  cfg: ["config", "configuration"],
  config: ["configuration", "settings"],
  env: ["environment"],
  svc: ["service"],
  auth: ["authentication", "login"],
  repo: ["repository"],
  pr: ["pull", "request", "merge"],
  mr: ["merge", "request", "pull"],
  rpc: ["grpc", "remote"],
  grpc: ["rpc"],
  perm: ["permission"],
  stat: ["status", "statistics"],
  stats: ["statistics", "status"],
  fat: ["test", "staging"],
  prod: ["production"],
  log: ["logs", "logging"],
  logs: ["log", "logging"],
  monitor: ["metrics", "observe", "watch"],
  metrics: ["monitor", "metric"],
};

export function normalizeSearchText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./:\-]+/g, " ")
    .toLowerCase();
}

/** CJK text into overlapping bigrams: 告警静默 → 告警 警静 静默. Single leftovers pass through. */
function cjkBigrams(value: string): string[] {
  const runs = value.match(/[\u3400-\u9fff\u3040-\u30ff]+/g) ?? [];
  const out: string[] = [];
  for (const run of runs) {
    if (run.length <= 2) {
      out.push(run);
      continue;
    }
    for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

/**
 * Tokens from the camelCase-split form plus the plain lowercased form, so `gRPC` yields both `rpc`
 * and `grpc`. CJK text becomes bigrams — a CJK word matches CJK text by shared characters the
 * way `grafana` matches `grafana_dashboard_read`, which the ASCII-only split used to throw away
 * entirely (a query of 告警静默 against a description of 屏蔽告警 matched nothing).
 */
export function tokenize(value: string): string[] {
  const split = normalizeSearchText(value).split(/[^a-z0-9]+/).filter(Boolean);
  const plain = value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of [...split, ...plain, ...cjkBigrams(value)]) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

function expandQueryTokens(tokens: string[]): string[] {
  const out = new Set(tokens);
  for (const t of tokens) for (const s of SYNONYMS[t] ?? []) out.add(s);
  return [...out];
}

interface Prepared {
  tool: CatalogTool;
  fields: { name: string; originalName: string; server: string; description: string; keywords: string }[];
  fieldTokens: Map<string, string[]>;
  nameTokens: Set<string>;
}

function prepare(tool: CatalogTool): Prepared {
  const fields = {
    name: normalizeSearchText(tool.piToolName),
    originalName: normalizeSearchText(tool.originalName),
    server: normalizeSearchText(tool.serverName),
    description: normalizeSearchText(tool.description),
    keywords: normalizeSearchText(tool.keywords.join(" ")),
  };
  const fieldTokens = new Map<string, string[]>();
  for (const [k, v] of Object.entries(fields)) fieldTokens.set(k, tokenize(v));
  return { tool, fields: [fields], fieldTokens, nameTokens: new Set(tokenize(tool.originalName)) };
}

function stemMatch(a: string, b: string): boolean {
  if (a.length < MIN_STEM_LENGTH || b.length < MIN_STEM_LENGTH) return false;
  return a.startsWith(b) || b.startsWith(a);
}

export function scoreTool(queryRaw: string, tool: CatalogTool): number | null {
  const query = normalizeSearchText(queryRaw).trim();
  const queryTokens = tokenize(queryRaw);
  if (queryTokens.length === 0) return null;
  const expanded = expandQueryTokens(queryTokens);
  const p = prepare(tool);
  const f = p.fields[0]!;
  let score = 0;
  let phraseHit = false;
  let exactField = false;

  for (const [field, weight] of Object.entries(FIELD_WEIGHTS) as [keyof typeof FIELD_WEIGHTS, number][]) {
    const text = f[field];
    if (!text) continue;
    if (text === query) {
      score += 14 * weight;
      phraseHit = true;
      exactField = true;
    } else if (query && text.startsWith(query)) {
      score += 9 * weight;
      phraseHit = true;
    } else if (query && text.includes(query)) {
      score += 6 * weight;
      phraseHit = true;
    }
    const toks = p.fieldTokens.get(field) ?? [];
    for (const qt of expanded) {
      const isSynonym = !queryTokens.includes(qt);
      const factor = isSynonym ? 0.5 : 1;
      if (toks.includes(qt)) score += 4 * weight * factor;
      else if (toks.some((t) => stemMatch(t, qt))) score += 2 * weight * factor;
      else if (text.includes(qt)) score += 1 * weight * factor;
    }
  }

  const allTokens = new Set([...p.fieldTokens.values()].flat());
  const covered = queryTokens.filter(
    (qt) => allTokens.has(qt) || [...allTokens].some((t) => stemMatch(t, qt)) || (SYNONYMS[qt] ?? []).some((s) => allTokens.has(s)),
  ).length;
  const coverage = covered / queryTokens.length;
  // A query that names the tool itself is a strong signal: it came from someone who knows the
  // name but is stacking extra dimensions onto it (`monitor_k8s pod resources replicas utilization`).
  // The gate for such a query halves, because the real 0-hit sessions showed the right tool at
  // 38–50% coverage there, every time. A query with no name hit keeps the strict gate.
  const nameHit = queryTokens.some((qt) => p.nameTokens.has(qt) || [...p.nameTokens].some((t) => stemMatch(t, qt)));
  const gate = nameHit ? 0.3 : queryTokens.length <= 2 ? 1 : 0.6;
  if (!phraseHit && coverage < gate) return null;
  score += coverage === 1 ? 25 : Math.round(coverage * 10);
  if (queryTokens[0] && p.nameTokens.has(queryTokens[0])) score += 8;
  if (exactField) score += 20;
  return score > 0 ? score : null;
}

export class LexicalRanker implements Ranker {
  rank(query: string, tools: readonly CatalogTool[], limit: number): RankedTool[] {
    const scored: RankedTool[] = [];
    for (const tool of tools) {
      const score = scoreTool(query, tool);
      if (score !== null) scored.push({ tool, score });
    }
    scored.sort((a, b) => b.score - a.score || a.tool.piToolName.localeCompare(b.tool.piToolName));
    return scored.slice(0, limit);
  }
}
