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
  copyDiagnostics: async () => {},
  saveDiagnostics: async () => {},
  submitReport: async () => {},
  openLogs: async () => {},
  local: {
    pickFolder: async () => ({ status: "cancelled" }),
    listAllowances: async () => ({ personal_enabled: false, items: [] }),
    removeAllowance: async () => ({ personal_enabled: false, items: [] }),
    setAccess: async () => ({ personal_enabled: false, items: [] }),
    setPersonalEnabled: async (enabled) => ({ personal_enabled: enabled, items: [] }),
    addSite: async () => ({ personal_enabled: false, items: [] }),
    addApp: async () => ({ status: "cancelled" }),
  },
  checkPermissions: async () => {},
  openPermissionSettings: async () => {},
  restartApp: async () => {},
  localPickDataFolder: async () => {},
  localBegin: async () => {},
  localFinish: async () => {},
  localCancel: async () => {},
  localOpen: async () => {},
  localBackup: async () => {},
  localRestore: async () => {},
  localMove: async () => {},
  localRemoveAll: async () => {},
  chooseWorkspace: async () => {},
  answerNotifications: async () => {},
  answerDiagnostics: async () => {},
  checkInvite: () => ipcRenderer.invoke("preview:connect-invite"),
  joinInvite: async () => null,
  onState: () => {},
};

contextBridge.exposeInMainWorld("subkitConnect", connect);
