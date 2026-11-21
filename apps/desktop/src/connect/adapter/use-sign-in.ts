import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { ConnectState } from "../../shared/ipc.ts";
import type { Command, WindowView } from "../domain/index.ts";
import { type Translate, translator } from "../lib/text.ts";
import type { SignInStore } from "./sign-in-store.ts";

const StoreContext = createContext<SignInStore | null>(null);

export function SignInStoreProvider({
  store,
  children,
}: {
  store: SignInStore;
  children: ReactNode;
}) {
  return createElement(StoreContext.Provider, { value: store }, children);
}

function useStore(): SignInStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error("The sign-in window needs a SignInStoreProvider");
  return store;
}

export interface SignInSession {
  view: WindowView | null;
  main: ConnectState | null;
  t: Translate;
  dispatch: (command: Command) => void;
}

export function useSignIn(): SignInSession {
  const store = useStore();
  const view = useSyncExternalStore(store.subscribe, store.getView, store.getView);
  const main = store.getState().main;
  const messages = main?.messages;
  const t = useMemo(() => translator(messages ?? {}), [messages]);
  return { view, main, t, dispatch: store.dispatch };
}
