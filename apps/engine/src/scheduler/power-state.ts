export interface BackgroundWork {
  deferred(): boolean;
}

export interface PowerState extends BackgroundWork {
  defer(value: boolean): void;
}

export const ALWAYS_RUNNING: BackgroundWork = { deferred: () => false };

export function createPowerState(): PowerState {
  let deferred = false;
  return {
    deferred: () => deferred,
    defer(value) {
      deferred = value;
    },
  };
}
