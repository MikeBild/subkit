import type { FolderAccess } from "@shared/device/boundary.ts";
import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useReducer,
} from "react";
import {
  INITIAL_LOCAL,
  type LocalAllowancesView,
  type LocalState,
  localReducer,
  siteEntry,
} from "../../shared/local/capabilities-model.ts";
import type { LocalCapabilitiesPort, PickResult } from "./local-capabilities.ts";

const PortContext = createContext<LocalCapabilitiesPort | null>(null);

export function LocalCapabilitiesProvider({
  port,
  children,
}: {
  port: LocalCapabilitiesPort;
  children: ReactNode;
}) {
  return createElement(PortContext.Provider, { value: port }, children);
}

export interface LocalCapabilitiesSession {
  state: LocalState;
  canAddSite: boolean;
  canSetAccess: boolean;
  canAddApp: boolean;
  reload(): void;
  setPersonalEnabled(enabled: boolean): void;
  remove(id: string): void;
  setAccess(id: string, access: FolderAccess): void;
  pickFolder(access: FolderAccess, keepOut: boolean): void;
  addSite(input: string): boolean;
  addApp(): void;
}

export function useLocalCapabilities(): LocalCapabilitiesSession {
  const port = useContext(PortContext);
  if (!port) throw new Error("Local capabilities need a LocalCapabilitiesProvider");
  const [state, send] = useReducer(localReducer, INITIAL_LOCAL);
  const run = useCallback((work: () => Promise<LocalAllowancesView>) => {
    send({ type: "Requested" });
    work().then(
      (view) => send({ type: "Loaded", view }),
      () => send({ type: "Failed" }),
    );
  }, []);
  const picked = useCallback((work: () => Promise<PickResult>) => {
    send({ type: "Requested" });
    work().then(
      (result) => {
        if (result.status === "added") send({ type: "Loaded", view: result.view });
        else if (result.status === "refused") send({ type: "PickRefused", code: result.code });
        else send({ type: "PickCancelled" });
      },
      () => send({ type: "Failed" }),
    );
  }, []);
  useEffect(() => run(() => port.listAllowances()), [port, run]);
  const { addSite, addApp, setAccess } = port;
  return {
    state,
    canAddSite: addSite !== null,
    canSetAccess: setAccess !== null,
    canAddApp: addApp !== null,
    reload: () => run(() => port.listAllowances()),
    setPersonalEnabled: (enabled) => run(() => port.setPersonalEnabled(enabled)),
    remove: (id) => run(() => port.removeAllowance(id)),
    setAccess: (id, access) => {
      if (setAccess) run(() => setAccess(id, access));
    },
    pickFolder: (access, keepOut) => picked(() => port.pickFolder({ access, keepOut })),
    addSite(input) {
      const entry = siteEntry(input);
      if (!entry.ok || !addSite) return false;
      run(() => addSite(entry.origin));
      return true;
    },
    addApp: () => {
      if (addApp) picked(addApp);
    },
  };
}
