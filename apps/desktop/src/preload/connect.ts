import { contextBridge, ipcRenderer } from "electron";
import { isConnectUrl } from "../shared/app-url.ts";
import { CONNECT_CHANNELS, type ConnectBridge, type ConnectState } from "../shared/ipc.ts";

const bridge: ConnectBridge = {
  getState: () => ipcRenderer.invoke(CONNECT_CHANNELS.getState),
  checkServer: (address) => ipcRenderer.invoke(CONNECT_CHANNELS.checkServer, String(address)),
  login: (origin) => ipcRenderer.invoke(CONNECT_CHANNELS.login, String(origin)),
  cancelLogin: () => ipcRenderer.invoke(CONNECT_CHANNELS.cancelLogin),
  openProfile: (id) => ipcRenderer.invoke(CONNECT_CHANNELS.openProfile, String(id)),
  removeProfile: (id) => ipcRenderer.invoke(CONNECT_CHANNELS.removeProfile, String(id)),
  updateSettings: (patch) => ipcRenderer.invoke(CONNECT_CHANNELS.updateSettings, patch),
  showView: (view) => ipcRenderer.invoke(CONNECT_CHANNELS.showView, view),
  updateAction: () => ipcRenderer.invoke(CONNECT_CHANNELS.updateAction),
  reportProblem: () => ipcRenderer.invoke(CONNECT_CHANNELS.reportProblem),
  local: {
    pickFolder: (options) =>
      ipcRenderer.invoke(CONNECT_CHANNELS.localPickFolder, {
        access: options?.access === "write" ? "write" : "read",
        keepOut: options?.keepOut === true,
      }),
    listAllowances: () => ipcRenderer.invoke(CONNECT_CHANNELS.localListAllowances),
    removeAllowance: (id) => ipcRenderer.invoke(CONNECT_CHANNELS.localRemoveAllowance, String(id)),
    setAccess: (id, access) =>
      ipcRenderer.invoke(
        CONNECT_CHANNELS.localSetAccess,
        String(id),
        access === "write" ? "write" : "read",
      ),
    setPersonalEnabled: (enabled) =>
      ipcRenderer.invoke(CONNECT_CHANNELS.localSetPersonalEnabled, enabled === true),
    addSite: (origin) => ipcRenderer.invoke(CONNECT_CHANNELS.localAddSite, String(origin)),
    addApp: () => ipcRenderer.invoke(CONNECT_CHANNELS.localAddApp),
  },
  checkPermissions: () => ipcRenderer.invoke(CONNECT_CHANNELS.checkPermissions),
  openPermissionSettings: (key) =>
    ipcRenderer.invoke(CONNECT_CHANNELS.openPermissionSettings, String(key)),
  restartApp: () => ipcRenderer.invoke(CONNECT_CHANNELS.restartApp),
  localPickDataFolder: () => ipcRenderer.invoke(CONNECT_CHANNELS.localPickDataFolder),
  localBegin: () => ipcRenderer.invoke(CONNECT_CHANNELS.localBegin),
  localFinish: (input) => ipcRenderer.invoke(CONNECT_CHANNELS.localFinish, input),
  localCancel: () => ipcRenderer.invoke(CONNECT_CHANNELS.localCancel),
  localOpen: () => ipcRenderer.invoke(CONNECT_CHANNELS.localOpen),
  localBackup: () => ipcRenderer.invoke(CONNECT_CHANNELS.localBackup),
  localRestore: (name) => ipcRenderer.invoke(CONNECT_CHANNELS.localRestore, String(name)),
  localMove: (origin) => ipcRenderer.invoke(CONNECT_CHANNELS.localMove, String(origin)),
  localRemoveAll: () => ipcRenderer.invoke(CONNECT_CHANNELS.localRemoveAll),
  chooseWorkspace: (tenantId) =>
    ipcRenderer.invoke(CONNECT_CHANNELS.chooseWorkspace, String(tenantId)),
  answerNotifications: (allow) =>
    ipcRenderer.invoke(CONNECT_CHANNELS.answerNotifications, allow === true),
  answerDiagnostics: (share) =>
    ipcRenderer.invoke(CONNECT_CHANNELS.answerDiagnostics, share === true),
  checkInvite: (link) => ipcRenderer.invoke(CONNECT_CHANNELS.checkInvite, String(link)),
  joinInvite: (link) => ipcRenderer.invoke(CONNECT_CHANNELS.joinInvite, String(link)),
  onState: (listener) => {
    ipcRenderer.on(CONNECT_CHANNELS.state, (_event, state: ConnectState) => listener(state));
  },
};

if (isConnectUrl(location.href)) contextBridge.exposeInMainWorld("subkitConnect", bridge);
