# Philosophy

pid-mcp is an MCP capability loader for Pi. It exists so that MCP tools can be
first-class Pi tools without every tool definition living in the model's context
on every turn.

## MCP is a source of tools, not a runtime

The Model Context Protocol describes where tools come from and how to call them.
It says nothing about how an agent should reason. pid-mcp keeps that separation:
the protocol layer connects, lists, and calls; Pi's tool registry decides what the
model sees. Nothing in pid-mcp runs an agent loop, keeps conversation state, or
routes model requests.

## The model calls tools by their real names

A tool that can only be reached through a gateway tool is a second-class tool. The
model has to learn a calling convention that differs from every other tool it has,
and the transcript records `mcp({ tool: "x" })` instead of `x(...)`. pid-mcp
registers each MCP tool as an ordinary Pi tool with its own name and its own
schema. There is no proxy tool.

## Discovery is a tool; execution is not

The one meta-tool pid-mcp adds is `mcp_search`. It finds tools and makes them
visible. It never executes them. Once a tool is visible, the model calls it the
way it calls `read` or `bash`.

## Visible tools grow, never shrink, inside a session

Provider prompt caches reward stable tool lists. pid-mcp activates tools
additively: a search adds tools to the visible set and removes nothing. Cleanup
happens at natural boundaries, a new session or an explicit reset, never behind
the model's back.

## Context cost tracks what is active, not what is installed

A user with two thousand cataloged tools should pay the context cost of the five
they are using. Registration is cheap; visibility is what costs tokens. pid-mcp
keeps the two separate.

## The frontend is optional

pid-mcp is a Pi extension. It works in the terminal with `pi -e`, and it works
when PID loads it into a `pi --mode rpc` child. PID adds a GUI on top by reading
the same status events the terminal status bar reads. Closing PID changes
nothing about what Pi can do.

## Configuration belongs to the user

pid-mcp reads the MCP config files Pi users already have. It does not create a
parallel config, does not copy credentials, and does not edit Pi's settings. When
PID wants to add a server, it writes to the same `mcp.json` a user would edit by
hand.

## Compatibility is a courtesy, not a constraint

pid-mcp answers the runtime registration event other extensions already send to
pi-mcp-adapter, publishes status on the same event name, and reads the same
config layers. That keeps existing extensions and PID working on day one. It
does not mean pid-mcp mirrors every adapter feature. Batching scripts, a
terminal setup panel, and MCP UI windows are out of scope.

## Small on purpose

If a change adds an orchestrator, a capability graph, a platform, or a runtime,
it is the wrong change. The whole extension should stay readable in an
afternoon.
