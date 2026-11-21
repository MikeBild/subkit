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
