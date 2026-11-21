import { contextBridge, ipcRenderer } from "electron";
import {
  isShellUrl,
  SHELL_CHANNELS,
  type ShellBridge,
  type ShellState,
} from "../shared/shell-ipc.ts";

const bridge: ShellBridge = {
  getState: () => ipcRenderer.invoke(SHELL_CHANNELS.getState),
  onState: (listener) => {
    ipcRenderer.on(SHELL_CHANNELS.state, (_event, state: ShellState) => listener(state));
  },
  sendNote: (text) => ipcRenderer.invoke(SHELL_CHANNELS.sendNote, String(text)),
  place: (choice) => ipcRenderer.invoke(SHELL_CHANNELS.place, String(choice)),
  close: () => ipcRenderer.invoke(SHELL_CHANNELS.close),
  reopenBrowser: () => ipcRenderer.invoke(SHELL_CHANNELS.reopenBrowser),
};

if (isShellUrl(location.href)) contextBridge.exposeInMainWorld("subkitShell", bridge);
