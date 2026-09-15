# Features

Tags say where a behaviour lives: `[SDK]` the MCP TypeScript SDK, `[Pi]` Pi's tool registry and
extension API, `[pid-mcp]` this extension.

## Tool surface

- every cached MCP tool registered as a Pi tool named `<server>_<tool>` `[pid-mcp]` `[Pi]`
- unpinned tools removed from the model's view before the first request `[pid-mcp]`
- `mcp_search` finds tools by name, server, description and keywords; activates matches additively `[pid-mcp]`
- activated definitions reach the next model request in the same run `[Pi]`
- `directTools: true` or a list pins tools visible from session start `[pid-mcp]`
- `includeTools` / `excludeTools` globs `[pid-mcp]`
- `toolPrefix`: `server`, `none`, `short`, `mcp` `[pid-mcp]`
- tool names capped at 64 characters with a stable hash suffix `[pid-mcp]`
- built-in name collisions skipped, duplicates skipped, both reported in status `[pid-mcp]`
- no gateway or proxy tool `[pid-mcp]`

## Servers

- stdio transport `[SDK]`
- Streamable HTTP with SSE fallback by config `[SDK]`
- bearer tokens from config or environment `[pid-mcp]`
- OAuth with browser sign-in, loopback redirect, PKCE, dynamic registration, refresh `[SDK]` `[pid-mcp]`
- lazy connect on first call, idle close, `keep-alive` `[pid-mcp]`
- `tools/list_changed` notifications refresh the catalog `[SDK]` `[pid-mcp]`
- runtime registration from other extensions, honouring `directTools` `[pid-mcp]`
- configured server wins a name clash with a runtime registration `[pid-mcp]`

## Config

- six config layers, per-field merge, project wins `[pid-mcp]`
- credentials dropped when a higher layer changes transport or URL `[pid-mcp]`
- `${VAR}`, `$env:VAR`, `{env:VAR}` interpolation; `~` in `cwd` `[pid-mcp]`
- `disabled: true` keeps the entry without starting it `[pid-mcp]`
- `/mcp enable|disable` writes the global mcp.json `[pid-mcp]`

## Cache

- `~/.pi/agent/mcp-cache.json`, version 1, shared with pi-mcp-adapter `[pid-mcp]`
- entries keyed by a hash of identity fields; lifecycle and timeouts excluded `[pid-mcp]`
- servers without a valid entry indexed once in the background at session start `[pid-mcp]`

## Results

- text, image, embedded resource, resource link, audio content blocks `[pid-mcp]`
- `structuredContent` used when `content` is empty; always kept in details `[pid-mcp]`
- MCP `isError` surfaced as an error result, never a thrown exception `[pid-mcp]`
- output over 50 KiB or 2,000 lines truncated and spilled to a file the model can read `[pid-mcp]`
- abort distinguished from failure `[pid-mcp]`

## Status

- `pid-mcp/status/v1` snapshots, mirrored on `pi-mcp-adapter/status/v1` `[pid-mcp]`
- per server: status, tool count, active tool names, pinned count, last error, transport, cache time `[pid-mcp]`
- status bar `MCP connected/enabled · active/known tools` `[pid-mcp]` `[Pi]`
- `/mcp`, `/mcp tools`, `/mcp search`, `/mcp connect`, `/mcp reconnect`, `/mcp refresh`, `/mcp auth`, `/mcp logout`, `/mcp reset-tools` `[pid-mcp]`
- OAuth outcomes as a custom message and an event `[pid-mcp]`

## Graphical host

- a page this extension publishes from the same snapshot: one row per server with status,
  transport, runtime and active-tool badges `[pid-mcp]`
- a switch per server and Reconnect / Sign-in / Sign-out buttons, each one a `/mcp …` command the
  host hands back — the same command a terminal user types `[pid-mcp]`
- active tools nested under their server, each with Deactivate `[pid-mcp]`
- rendered by whatever host can draw the shape; nothing here assumes a particular one `[pid-mcp]`

## Not implemented

- MCP resources as tools, MCP prompts as slash commands
- sampling and elicitation
- MCP UI windows
- a scripting tool for batching calls
- `!command` secrets in config values
- Unix-socket transport
- OS keychain token storage
- embedding search or a learned ranker
- automatic demotion or LRU of active tools
