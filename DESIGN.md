# Design

## Shape

```
                     mcp.json layers · runtime-register events
                                     │
                                  config.ts
                                     │
                    ┌────────────────┴────────────────┐
                 cache.ts                          servers.ts
        ~/.pi/agent/mcp-cache.json          SDK Client per server
                    │                        stdio · http · oauth.ts
                    └───────────► core.ts ◄──────────┘
                                 PidMcp
                     catalog.ts · ranking.ts · activation.ts
                                     │
                                  index.ts
                    Pi tools · mcp_search · /mcp · status events
                                     │
                    ┌────────────────┴────────────────┐
                 Pi TUI                        a graphical host
              status line, /mcp            a page this extension
                                            publishes, same commands
```

`core.ts` holds every decision and knows nothing about Pi's API beyond two callbacks: register a
tool, publish a snapshot. `index.ts` is the only file that imports the Pi extension types. The
end-to-end tests drive `PidMcp` with a fake registry and a real stdio server.

## Session start

1. `load(cwd)`: read config layers, read the cache, build a `ServerState` per configured server.
2. For every server with a cache entry whose hash matches the current identity fields, build
   catalog entries and register each as a Pi tool. Nothing connects.
3. `applyBaseline()`: take Pi's active set, drop every pid-mcp tool that is neither pinned nor
   search-activated, add pins and `mcp_search`. Tools from built-ins and other extensions are
   untouched.
4. Publish a snapshot, set the status bar.
5. In the background, connect once to each enabled server without a valid cache entry, list its
   tools, write the cache, register the tools, re-apply the baseline, and close the connection if
   the server is lazy.

Runtime registrations arriving during or after step 1 go through steps 2 to 5 for that server.

## Search and activation

`mcp_search({ query, limit?, server? })`:

1. `LexicalRanker.rank` scores every catalog tool. Fields and weights: Pi name 12, original name
   10, server 8, description 5, keywords 5. Phrase matches (exact, prefix, substring) score high;
   token matches use exact, stem (4+ character prefix either way), and substring tiers. Query
   tokens expand through a small abbreviation table at half weight. A tool with no phrase hit
   must cover all tokens of a one- or two-word query, or 60% of a longer one.
2. `ToolActivator.activate(names)` adds the matches to Pi's active set and remembers them as
   search-activated. It never removes anything.
3. The result text lists what was activated and what was already active, with one sentence per
   tool, and ends with "Call the activated tools directly by name."

Pi sees the active set grow between the tool result and the next request and delivers the new
definitions to the model.

`/mcp reset-tools` is the only subtraction inside a session. A new session starts from the
baseline again; search activations do not persist.

## Execution

A registered tool's `execute` looks the catalog entry up by Pi name at call time. If the entry is
gone (the server dropped the tool during a refresh), the result says so and suggests searching
again. Otherwise `ServerManager.callTool` connects if needed, calls, and converts the result:

- content blocks → Pi text and image blocks;
- `structuredContent` → text when `content` is empty, always copied into `details`;
- `isError` → the first text block prefixed with `Error:` and `details.error = "tool_error"`;
- thrown errors → a text result with `details.error = "call_failed"` or `"aborted"`, plus a hint
  to run `/mcp auth` when the failure was authentication.

Output over 50 KiB or 2,000 lines is truncated in place and the full text written to
`$TMPDIR/pid-mcp/<server>-<tool>-<time>.txt`.

## Connections

`ServerManager` keeps one `Client` per server. `connect` is idempotent and coalesces concurrent
callers onto one attempt. After each successful call the idle timer restarts; when it fires the
connection closes. `keep-alive` servers never idle out. A failed connect records `lastError`,
`failedAt`, and whether the failure looked like an authentication problem.

Transports: `StdioClientTransport` with the parent environment plus the configured `env`;
`StreamableHTTPClientTransport` with headers and an optional `OAuthClientProvider`;
`SSEClientTransport` when `httpTransport` is `"sse"`.

## OAuth

`OAuthStore` implements the SDK's `OAuthClientProvider`. Per-server state (client registration,
tokens, PKCE verifier, state) lives in `~/.pi/agent/pid-mcp/oauth/<server>.json` with mode 0600.
`/mcp auth <server>` opens a loopback listener on 127.0.0.1, attempts a connection so the SDK runs
discovery and redirects, opens the browser, waits for the callback, exchanges the code with
`finishAuth`, then connects normally. Tokens refresh through the SDK on later connects.

Outside `/mcp auth` the flow is never started: a connect to an OAuth server with no stored tokens
fails immediately with `needs-auth` and the hint to run `/mcp auth`, and the provider refuses to
register a client or open a browser. Letting the SDK register a client with no redirect URI is what
produced opaque validation errors from authorization servers that reject such requests.

## Cache

`mcp-cache.json` version 1, the shape pi-mcp-adapter writes. Each server entry carries
`configHash` (SHA-256 over command, args, env, cwd, url, headers, auth fields, include/exclude
lists after interpolation), the tool list with input schemas, resources, instructions, and
`cachedAt`. An entry is valid when the hash matches and it is under seven days old. Writes merge
into the file so other servers' entries survive.

## Status

`snapshot()` produces one object per publish:

```
version 1 · servers[] · totalTools · totalResources · connectedCount · disabledCount   (adapter-shaped)
source "pid-mcp" · pidMcpVersion · activeToolCount                                     (pid-mcp)
```

Per server the adapter-shaped block is `name`, `status`, `toolCount`, `directToolCount`,
`resourceCount`, `failedAgoSeconds`, `disabled`, `listenState`; pid-mcp adds `activeToolCount`,
`pinnedToolCount`, `activeToolNames`, `lastError`, `runtimeRegistered`, `transport`, `cachedAt`.

Publishing is debounced by 20 ms and goes to both `pid-mcp/status/v1` and
`pi-mcp-adapter/status/v1`, so anything already listening for the adapter keeps working.

The same choke point draws the interface. A terminal gets one status line and `/mcp`. A graphical
host gets the snapshot itself, published under this extension's own name, and **this extension draws
the page** — `src/ui.tsx`, declared as `"pid": { "ui": … }`, composing the host's primitives. The
host reads none of the payload; it routes the lines back by name and mounts what comes out. So
nothing here is capped by what a host author thought an MCP server looks like.

Every affordance on the page is a `/mcp …` command handed straight back, the same command a terminal
user would type, which is why the page needs no privileged channel of its own. A host that never
heard of `src/ui.tsx` loads the other half alone and shows no entry at all.

What the page is for decides its shape. Five servers and a hundred and fifty tools, and the reader
wants one of three things: is anything broken, where is the tool I am looking for, and turn that off.
So the collapsed row carries a status dot, the name, and one count — and nothing else. The transport,
the cache age, reconnecting, signing out, and the active tool names all live inside the row, because
a detail repeated on every row is not a detail, it is wallpaper. Two exceptions earn a place on the
collapsed line: a status that is not `connected` or `cached` says itself, and a server nobody signed
into shows its Sign in, because a row that states a problem and hides its answer is worse than one
that says nothing. The search box is the host's, at the top of the page; a query that matches inside
a server opens that server, since a row answering "3 match" and staying shut makes the reader click
to find what they already asked for.

## Compatibility with pi-mcp-adapter

| Contract | pid-mcp behaviour |
| --- | --- |
| config paths, merge order, `disabled` | identical |
| `directTools: true / [...] / "search" / false` | identical meaning; absent means search |
| `mcp-cache.json` v1 | read and written |
| `pi-mcp-adapter:runtime-register:v1` | answered; `directTools` honoured instead of forced off |
| `pi-mcp-adapter:runtime-snapshot:v1` | answered |
| `pi-mcp-adapter/status/v1` | published (mirror) |
| `mcp-oauth-status` custom message | sent |
| `mcp` / `mcpScript` tools | not registered; their presence means another MCP extension is loaded and pid-mcp stands down |

## What is deliberately absent

No proxy tool: the only way to reach an MCP tool is by its name. No unregister: Pi has none, so
stale tools answer with a stale message. No automatic demotion: the active set only grows inside a
session. No embeddings: the `Ranker` interface exists so one can be added when a catalog outgrows
lexical ranking, following the numbers in REFERENCE.md.
