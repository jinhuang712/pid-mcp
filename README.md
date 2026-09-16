# pid-mcp

MCP capability loader for [Pi](https://github.com/earendil-works/pi). Every MCP tool becomes a
native Pi tool with its own name and schema. The model starts each session seeing one extra tool,
`mcp_search`; a search activates the matching MCP tools for the rest of the session and the model
then calls them directly, the same way it calls `read` or `bash`.

```
turn 1   tools: read, bash, edit, …, mcp_search
         model: mcp_search({ query: "search github issues" })
         → Activated 2 new tool(s): github_search_issues, github_get_issue

turn 2   tools: read, bash, edit, …, mcp_search, github_search_issues, github_get_issue
         model: github_search_issues({ owner: "…", repo: "…", query: "MCP" })
```

No gateway tool, no `mcp({ tool, args })` indirection. Execution runs through the official
[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) inside the Pi
process that owns the session.

pid-mcp is a plain Pi extension. It runs in the terminal, and in [PID](../pid) — Pi's desktop
frontend — because PID hosts Pi's own runtime and loads whatever Pi resolves. Nothing bundles it and
no host installs it for you; one install serves both.

In a window it also draws its own page, from `src/ui.tsx`:

```text
MCP
1/5 connected · 17 of 156 tools active · 1 off      [ Meegle, klook-grafana ]
┌ Search servers and active tools…                                          ┐
  ( ● ) › ● klook-grafana   failed                                   5 tools
  ( ● ) › ● Meegle          needs-auth                47 tools     [Sign in]
  ( ● ) › ● serena                                             17/17 active
```

One line per server: the switch, a status dot, the name, and how much of it the model can reach.
Open a row for the transport, the cache age, Reconnect, sign-in, and the active tool names — each of
which can be deactivated from there. Type in the box and a server whose name or tools match opens
itself with only the matches showing.

## Install

```bash
pi install /path/to/pid-mcp        # or, once published: pi install npm:pid-mcp
```

or for one run:

```bash
pi -e /path/to/pid-mcp/src/index.ts
```

Do not run pid-mcp and pi-mcp-adapter in the same Pi: pid-mcp stands down with a warning when it
sees the other one, so the servers are not started twice.

## Configure

pid-mcp reads the files Pi users already have, lowest precedence first:

| File | Scope |
| --- | --- |
| `~/.config/mcp/mcp.json` | shared across MCP hosts |
| `~/.agents/mcp.json`, `~/.agents/mcp/mcp.json` | shared |
| `~/.pi/agent/mcp.json` | Pi, global |
| `<project>/.mcp.json` | project, shared |
| `<project>/.pi/mcp.json` | project, Pi only |

```json
{
  "settings": { "toolPrefix": "server" },
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    },
    "serena": {
      "command": "serena",
      "args": ["start-mcp-server"],
      "directTools": true
    },
    "meegle": {
      "url": "https://project.larksuite.com/mcp_server/v1",
      "auth": "oauth"
    }
  }
}
```

Server fields:

| Field | Meaning |
| --- | --- |
| `command`, `args`, `env`, `cwd` | stdio server. `${VAR}`, `$env:VAR`, `{env:VAR}` interpolate; `~` expands in `cwd` |
| `url`, `headers`, `httpTransport` | HTTP server; Streamable HTTP by default, `"sse"` for legacy servers |
| `auth`: `"bearer"` + `bearerToken` / `bearerTokenEnv` | static bearer token |
| `auth`: `"oauth"` + optional `oauth.{clientId,clientSecret,scope,clientName}` | browser OAuth; `/mcp auth <server>` starts it |
| `directTools` | `true`: all tools visible from session start. `["a","b"]`: only those. Absent, `false`, or `"search"`: wait for `mcp_search` |
| `includeTools`, `excludeTools` | glob filters on original tool names |
| `toolPrefix` | `"server"` (default) → `github_search_issues`; `"none"` → `search_issues`; `"short"`, `"mcp"` |
| `searchKeywords` | `{ "tool": ["extra", "words"] }` to help search |
| `lifecycle`, `idleTimeout`, `requestTimeoutMs` | `"lazy"` (default, closes after `idleTimeout` minutes), `"keep-alive"` |
| `disabled` | `true` keeps the entry but never starts it |

Settings: `toolPrefix`, `directTools` (default for every server), `idleTimeout`, `requestTimeoutMs`,
`searchDefaultLimit` (5), `searchActivationLimit` (15).

### Registering a server from another extension

An extension can hand pid-mcp a server at session start without writing any file. The event is
the same one pi-mcp-adapter answers, so existing extensions work unchanged:

```ts
const request = { version: 1, name: "my-server", definition: { command: "node", args: ["server.js"] } };
pi.events.emit("pid-mcp:runtime-register:v1", request); // or "pi-mcp-adapter:runtime-register:v1"
if (request.result?.ok) registrations.push(request.result.registration); // .dispose() on shutdown
```

Unlike the adapter, pid-mcp honours `directTools` on a runtime definition; by default the server's
tools are searchable like any other.

## Use

The model does the work. For people, `/mcp` in Pi:

```
/mcp                      status of every server
/mcp tools <server>       tools and which are active (● active, ○ waiting, pinned)
/mcp search <query>       run mcp_search by hand
/mcp connect|reconnect <server>
/mcp refresh              refresh every enabled server's tool list
/mcp auth <server>        sign in to an OAuth server (also /mcp-auth <server>)
/mcp logout <server>
/mcp enable|disable <server>
/mcp reset-tools          deactivate search-activated tools; pins stay
```

The status bar shows `MCP 2/3 · 5/140 tools`: connected servers over enabled servers, and tools
the model can see over tools known.

## How it stays cheap

Registration is not visibility. pid-mcp registers every cached tool with Pi at startup, then
removes its own unpinned tools from the active set before the first model request. Activation is
additive inside a session; Pi detects additive changes and, on providers that support it, anchors
the new definitions after the search result so the cached prompt prefix survives.

The tool list comes from a metadata cache at `~/.pi/agent/mcp-cache.json`, the same file
pi-mcp-adapter writes. A server with a valid cache entry is never started until one of its tools
is called. Servers without a cache entry are connected once in the background at session start to
fetch their tool list, then released.

The numbers behind this design come from *Scalable LLM Agent Tool Access in the Cloud*
([arXiv:2607.15593](https://arxiv.org/abs/2607.15593)): frontier models saturate somewhere
between 98 and 774 mounted tools, 120 tools cost 56k to 166k tokens per request, and a Top-15
retrieval step reached 98% recall while cutting tool-selection time 8.9× and tokens 23.8×.
pid-mcp's defaults (5 results, at most 15 activated per search, lexical ranking with abbreviation
synonyms) follow those findings at desktop scale. See [REFERENCE.md](REFERENCE.md).

## Documents

- [PHILOSOPHY.md](PHILOSOPHY.md) — what pid-mcp believes
- [GOALS.md](GOALS.md) — goals, non-goals, constraints
- [DESIGN.md](DESIGN.md) — modules, data flow, events, compatibility
- [FEATURES.md](FEATURES.md) — what is implemented, tagged by layer
- [REFERENCE.md](REFERENCE.md) — prior art and sources

## Develop

```bash
pnpm install
pnpm typecheck
pnpm test                       # unit + end-to-end against a stdio fixture server
node test/smoke-rpc.mjs         # drives a real `pi --mode rpc` with slash commands
```

A graphical host needs no separate install here: it loads this extension the same way the terminal
does, through Pi's own resolver. `pnpm typecheck` covers `src/ui.tsx` against `src/pid-ui.d.ts`, a
local mirror of the host's primitives — the host stays the source of truth, and the mirror only
catches a typo in a name or a prop.

## License

MIT.
