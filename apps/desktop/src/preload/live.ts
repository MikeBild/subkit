import { contextBridge, ipcRenderer } from "electron";
import {
  isLiveUrl,
  LIVE_CHANNELS,
  type LiveBridge,
  type LiveWindowState,
} from "../shared/live-ipc.ts";

const bridge: LiveBridge = {
  getState: () => ipcRenderer.invoke(LIVE_CHANNELS.getState),
  onState: (listener) => {
    ipcRenderer.on(LIVE_CHANNELS.state, (_event, state: LiveWindowState) => listener(state));
  },
  stop: () => ipcRenderer.invoke(LIVE_CHANNELS.stop),
  decide: (allow) => ipcRenderer.invoke(LIVE_CHANNELS.decide, allow === true),
  handBack: () => ipcRenderer.invoke(LIVE_CHANNELS.handBack),
  close: () => ipcRenderer.invoke(LIVE_CHANNELS.close),
};

if (isLiveUrl(location.href)) contextBridge.exposeInMainWorld("subkitLive", bridge);
