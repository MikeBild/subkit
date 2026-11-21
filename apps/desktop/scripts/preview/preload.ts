import { contextBridge, ipcRenderer } from "electron";
import type { ConnectBridge } from "../../src/shared/ipc.ts";
import type { ShellBridge } from "../../src/shared/shell-ipc.ts";

const bridge: ShellBridge = {
  getState: () => ipcRenderer.invoke("preview:state"),
  onState: () => {},
  sendNote: async () => {},
  place: async () => {},
  close: async () => {},
  reopenBrowser: async () => {},
};

contextBridge.exposeInMainWorld("subkitShell", bridge);

const connect: ConnectBridge = {
  getState: () => ipcRenderer.invoke("preview:connect-state"),
  checkServer: () => ipcRenderer.invoke("preview:connect-check"),
  login: () => ipcRenderer.invoke("preview:connect-check"),
  cancelLogin: async () => {},
  openProfile: async () => {},
  removeProfile: async () => {},
  updateSettings: async () => {},
  showView: async () => {},
  updateAction: async () => {},
  reportProblem: async () => {},
  chooseWorkspace: async () => {},
  answerNotifications: async () => {},
  answerDiagnostics: async () => {},
  checkInvite: () => ipcRenderer.invoke("preview:connect-invite"),
  joinInvite: async () => {},
  onState: () => {},
};

contextBridge.exposeInMainWorld("subkitConnect", connect);
