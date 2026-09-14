# Goals

## Goals

- Make every MCP tool a native Pi tool with its own name and schema.
- Keep the model's initial tool surface small regardless of how many MCP tools
  are configured.
- Provide one search tool that activates matching tools additively for the rest
  of the session.
- Let the model call activated tools directly, with no gateway or proxy tool in
  the path.
- Make registering a server easy: a config file entry, a package manifest, or a
  runtime event from another extension all work, and all can produce direct
  tools.
- Publish machine-readable status so Pi's status bar and PID's MCP page show the
  same thing.
- Work in the Pi terminal and inside PID with identical behaviour.
- Run without pi-mcp-adapter installed. PID bundles pid-mcp and needs nothing
  else for MCP.
- Stay wire-compatible with the runtime registration and status events that
  existing extensions and PID's bridge already use.

## Non-goals

- Implementing the MCP protocol. The official TypeScript SDK owns transports,
  framing, and OAuth client flows.
- A gateway or proxy tool for calling MCP tools indirectly.
- A scripting tool for batching multiple MCP calls.
- Automatic demotion or LRU eviction of active tools.
- Embedding search, vector databases, or learned rankers.
- A terminal configuration panel or an MCP marketplace.
- MCP UI windows.
- Sharing MCP server processes across Pi sessions.
- A second agent runtime, session store, or auth store.

## Constraints

- pid-mcp is a Pi extension loadable with `pi -e` and installable as a Pi
  package.
- All MCP execution happens inside the Pi process that owns the session.
- Config is read from the files Pi users already maintain. Nothing is written
  unless the user asks through a command or PID's GUI.
- Active tool changes inside a session are additive.
- The extension must remain small enough to read in one sitting.
