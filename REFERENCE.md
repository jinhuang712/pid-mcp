# Reference

Sources pid-mcp's design draws on, and what was taken from each.

## Scalable LLM Agent Tool Access in the Cloud

Li, Song, Zuo, et al. arXiv:2607.15593, July 2026. <https://arxiv.org/abs/2607.15593>

A cloud MCP gateway serving 3,616 tools compiled from Alibaba Cloud OpenAPI specs. Four findings
shaped pid-mcp:

- **Tool count is the cost, not catalog size.** Frontier models saturate between 98 and 774
  mounted tools despite 128k to 1M contexts. Mounting 120 tools cost 56k to 166k tokens per
  request; at 180 tools inference latency passed 200 seconds. pid-mcp therefore treats
  "registered" and "visible" as different states and defaults every server to search mode.
- **Top-15 is a good operating point.** Retrieval with Top-15 reached 98.2% recall and cut tool
  selection time 8.9× and token use 23.8× against mounting everything. `mcp_search` returns 5 by
  default and caps activation at 15 per call.
- **Lexical alone is not enough at scale, but it carries the weight.** BM25 reached 67.7% recall,
  dense embeddings 83.1%, the hybrid 98.2%, on a catalog of 3,616. The paper notes that tool names
  encode function, which is why the lexical path stays. pid-mcp ships lexical ranking for catalogs
  in the hundreds and keeps the `Ranker` interface as the seam for a hybrid ranker later.
- **Weak-semantic queries need normalisation.** Rule-based query rewriting lifted recall on ID and
  abbreviation queries from 80.8% to 99.7%. pid-mcp splits snake_case, kebab-case and camelCase,
  and expands a small abbreviation table (`db`, `k8s`, `rpc`, `mq`, …) when ranking.

Not adopted: the gateway deployment model, session-affinity routing, the prerequisite-chain
knowledge cache, and the LRU query cache. Those solve multi-tenant cloud problems a single-user
desktop does not have.

## Pi extension API

`@earendil-works/pi-coding-agent` 0.85.1, `docs/extensions.md`, section "Deferred tool loading",
and `examples/extensions/kimi-deferred-tools.ts`.

- `pi.registerTool` registers a tool active; `pi.setActiveTools` narrows or widens the set for the
  next model request, including the next request inside the same agent run.
- Pi diffs the active set around every extension tool call. When the change is purely additive it
  reports the new names as `addedToolNames` on the tool result, and on providers with native
  deferred loading anchors the definitions after that result without changing the cached prefix.
- There is no `unregisterTool`. A tool that disappears from a server stays registered, leaves the
  catalog, and reports itself stale if called.
- `promptSnippet` and `promptGuidelines` rebuild the system prompt on activation. pid-mcp sets
  them only on `mcp_search`, never on the MCP tools themselves.

## pi-mcp-adapter

<https://github.com/nicobailon/pi-mcp-adapter>, 2.33.0. The MCP extension many Pi users already
have installed. pid-mcp keeps three of its contracts so switching costs nothing:

- config file layering and the `disabled` flag;
- the metadata cache at `~/.pi/agent/mcp-cache.json`, version 1;
- the event bus channels `pi-mcp-adapter:runtime-register:v1`,
  `pi-mcp-adapter:runtime-snapshot:v1`, and `pi-mcp-adapter/status/v1`, all answered or mirrored
  under pid-mcp's own names as well.

Its `directTools: "search"` mode (registered inactive, activated by `mcp({ search })`) is the
closest prior implementation of pid-mcp's core idea; pid-mcp differs in having no gateway tool, in
defaulting every server to search mode, and in letting runtime-registered servers expose direct
tools.

## Model Context Protocol

TypeScript SDK 1.30.0, <https://github.com/modelcontextprotocol/typescript-sdk>. pid-mcp uses
`Client`, `StdioClientTransport`, `StreamableHTTPClientTransport`, `SSEClientTransport`, the
`OAuthClientProvider` interface with the SDK's `auth()` flow (discovery, PKCE, dynamic client
registration, refresh), and `ToolListChangedNotificationSchema`.
