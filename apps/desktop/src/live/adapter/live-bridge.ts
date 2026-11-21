import type { LiveBridge, LiveWindowState } from "../../shared/live-ipc.ts";

export interface LiveActions {
  stop(): void;
  decide(allow: boolean): void;
  handBack(): void;
  close(): void;
}

export function liveActions(bridge: LiveBridge): LiveActions {
  return {
    stop: () => void bridge.stop(),
    decide: (allow) => void bridge.decide(allow),
    handBack: () => void bridge.handBack(),
    close: () => void bridge.close(),
  };
}

export function watchLive(bridge: LiveBridge, render: (state: LiveWindowState) => void): void {
  bridge.onState(render);
  void bridge.getState().then((state) => {
    if (state) render(state);
  });
}
