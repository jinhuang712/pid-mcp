/**
 * Status events.
 *
 * Published on two channels with the same payload: `pid-mcp/status/v1` (canonical) and
 * `pi-mcp-adapter/status/v1` (so PID's bridge and any other listener written against the adapter
 * keep working). The first block of each server entry matches the adapter's snapshot field for
 * field; pid-mcp's own fields follow.
 */
export const STATUS_EVENT = "pid-mcp/status/v1";
export const COMPAT_STATUS_EVENT = "pi-mcp-adapter/status/v1";

export const RUNTIME_REGISTER_EVENT = "pid-mcp:runtime-register:v1";
export const COMPAT_RUNTIME_REGISTER_EVENT = "pi-mcp-adapter:runtime-register:v1";
export const RUNTIME_SNAPSHOT_EVENT = "pid-mcp:runtime-snapshot:v1";
export const COMPAT_RUNTIME_SNAPSHOT_EVENT = "pi-mcp-adapter:runtime-snapshot:v1";
export const RUNTIME_PROTOCOL_VERSION = 1;

/** Custom message type used to report OAuth outcomes into the conversation. */
export const OAUTH_STATUS_MESSAGE = "mcp-oauth-status";

export interface StatusBus {
  emit(channel: string, data: unknown): void;
}

export function publishStatus(bus: StatusBus, snapshot: unknown): void {
  for (const channel of [STATUS_EVENT, COMPAT_STATUS_EVENT]) {
    try {
      bus.emit(channel, snapshot);
    } catch (error) {
      console.error(`pid-mcp: a status listener on ${channel} threw: ${(error as Error).message}`);
    }
  }
}
