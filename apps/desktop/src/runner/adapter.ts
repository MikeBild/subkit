import type { DeviceCommand, DeviceCommandKind, DeviceResult } from "@shared/device/protocol.ts";

export interface DeviceAdapter {
  readonly name: string;
  readonly version: string;
  readonly kinds: readonly DeviceCommandKind[];
  execute(command: DeviceCommand, signal: AbortSignal): Promise<DeviceResult>;
}

export function routeCommands(
  adapters: readonly DeviceAdapter[],
): (command: DeviceCommand, signal: AbortSignal) => Promise<DeviceResult> {
  const byKind = new Map<DeviceCommandKind, DeviceAdapter>();
  for (const adapter of adapters) {
    for (const kind of adapter.kinds) {
      if (byKind.has(kind)) throw new Error(`Two device adapters claim ${kind}`);
      byKind.set(kind, adapter);
    }
  }
  return async (command, signal) => {
    const adapter = byKind.get(command.kind);
    if (!adapter)
      return {
        status: "failed",
        code: "kind_not_ready",
        detail: `${command.kind} is not available on this device yet.`,
      };
    if (signal.aborted) return { status: "stopped" };
    return adapter.execute(command, signal);
  };
}
