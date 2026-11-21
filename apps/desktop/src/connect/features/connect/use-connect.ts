import { useSignIn } from "../../adapter/index.ts";
import type { Screen } from "../../domain/index.ts";
import { type ConnectActions, connectActions } from "./connect-model.ts";

export type ConnectScreen = Extract<Screen, { kind: "connect" }>;

export function useConnect(): { s: ConnectScreen; a: ConnectActions } {
  const { view, dispatch } = useSignIn();
  if (view?.screen.kind !== "connect") throw new Error("Connect needs the connect step");
  return { s: view.screen, a: connectActions(view.screen, dispatch) };
}
