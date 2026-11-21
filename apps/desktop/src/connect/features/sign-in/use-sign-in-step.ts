import { useSignIn } from "../../adapter/index.ts";
import type { Screen } from "../../domain/index.ts";

type Kind = "signin" | "signed-in" | "relogin";

export interface SignInActions {
  open: (origin: string) => void;
  cancel: () => void;
  back: () => void;
  enter: () => void;
  other: () => void;
}

export function useSignInStep<K extends Kind>(
  kind: K,
): { s: Extract<Screen, { kind: K }>; a: SignInActions } {
  const { view, dispatch } = useSignIn();
  const screen = view?.screen;
  if (screen?.kind !== kind) throw new Error(`The ${kind} screen is not shown`);
  return {
    s: screen as Extract<Screen, { kind: K }>,
    a: {
      open: (origin) => dispatch({ type: "StartSignIn", origin }),
      cancel: () => dispatch({ type: "CancelSignIn" }),
      back: () => dispatch({ type: "GoBack" }),
      enter: () => dispatch({ type: "OpenSubKit" }),
      other: () => dispatch({ type: "ConnectAnotherServer" }),
    },
  };
}
