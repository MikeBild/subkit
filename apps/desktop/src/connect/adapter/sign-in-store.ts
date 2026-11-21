import type { ConnectBridge } from "../../shared/ipc.ts";
import {
  type Command,
  decide,
  type Effect,
  type Event,
  evolveAll,
  INITIAL_STATE,
  type SignInState,
  signInAnswered,
  viewOf,
  type WindowView,
} from "../domain/index.ts";

export interface SignInStore {
  getState(): SignInState;
  getView(): WindowView | null;
  dispatch(command: Command): void;
  subscribe(listener: () => void): () => void;
}

export interface StoreOptions {
  nextId?: () => number;
}

export function createSignInStore(bridge: ConnectBridge, options: StoreOptions = {}): SignInStore {
  let counter = 0;
  const nextId = options.nextId ?? (() => ++counter);
  let state = INITIAL_STATE;
  let view: WindowView | null = null;
  const listeners = new Set<() => void>();

  function apply(events: Event[]): void {
    if (events.length === 0) return;
    state = evolveAll(state, events);
    view = viewOf(state);
    for (const listener of listeners) listener();
  }

  function run(effect: Effect): void {
    switch (effect.kind) {
      case "checkServer": {
        const { requestId } = effect;
        bridge.checkServer(effect.address).then(
          (result) => apply([{ type: "VersionChecked", requestId, result }]),
          () => apply([{ type: "VersionCheckFailed", requestId }]),
        );
        return;
      }
      case "login":
        bridge.login(effect.origin).then(
          (result) => apply(signInAnswered(result)),
          () => apply(signInAnswered(null)),
        );
        return;
      case "cancelLogin":
        void bridge.cancelLogin();
        return;
      case "openProfile":
        void bridge.openProfile(effect.profileId);
        return;
      case "removeProfile":
        void bridge.removeProfile(effect.profileId);
        return;
      case "showView":
        void bridge.showView(effect.view);
        return;
      case "updateSettings":
        void bridge.updateSettings(effect.patch);
        return;
      case "updateAction":
        void bridge.updateAction();
        return;
      case "reportProblem":
        void bridge.reportProblem();
        return;
      case "chooseWorkspace":
        void bridge.chooseWorkspace(effect.tenantId);
        return;
      case "answerNotifications":
        void bridge.answerNotifications(effect.allow);
        return;
      case "answerDiagnostics":
        void bridge.answerDiagnostics(effect.share);
        return;
      case "checkInvite": {
        const { requestId, link } = effect;
        bridge.checkInvite(link).then(
          (check) => apply([{ type: "InviteChecked", requestId, link, check }]),
          () => apply([{ type: "InviteCheckFailed", requestId, link }]),
        );
        return;
      }
      case "joinInvite":
        void bridge.joinInvite(effect.link);
        return;
    }
  }

  const received = (main: Parameters<Parameters<ConnectBridge["onState"]>[0]>[0]) =>
    apply([{ type: "MainStateReceived", state: main }]);
  bridge.onState(received);
  void bridge.getState().then(received);

  return {
    getState: () => state,
    getView: () => view,
    dispatch(command) {
      const decision = decide(state, command, { requestId: nextId() });
      apply(decision.events);
      for (const effect of decision.effects) run(effect);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
