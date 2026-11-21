import { contextBridge, ipcRenderer } from "electron";
import {
  BRIDGE_CAPABILITIES,
  BRIDGE_PROTOCOL_VERSION,
  COCKPIT_CHANNELS,
  type CockpitBridge,
  type DesktopSettingsView,
  desktopSettingsPatch,
} from "../shared/ipc.ts";
import type { ShellStatus } from "../shared/status-model.ts";

const bridge: CockpitBridge = {
  protocolVersion: BRIDGE_PROTOCOL_VERSION,
  platform: process.platform,
  capabilities: BRIDGE_CAPABILITIES,
  sessionEnded: () => ipcRenderer.send(COCKPIT_CHANNELS.sessionEnded),
  setLocale: (locale) => {
    if (locale === "de" || locale === "en") ipcRenderer.send(COCKPIT_CHANNELS.setLocale, locale);
  },
  diagnostics: () => ipcRenderer.invoke(COCKPIT_CHANNELS.diagnostics),
  captureWindow: () => ipcRenderer.invoke(COCKPIT_CHANNELS.captureWindow),
  status: () => ipcRenderer.invoke(COCKPIT_CHANNELS.status),
  onStatus: (listener) => {
    if (typeof listener !== "function") return () => {};
    const handler = (_event: unknown, status: ShellStatus) => listener(status);
    ipcRenderer.on(COCKPIT_CHANNELS.statusChanged, handler);
    return () => ipcRenderer.removeListener(COCKPIT_CHANNELS.statusChanged, handler);
  },
  desktopSettings: () => ipcRenderer.invoke(COCKPIT_CHANNELS.desktopSettings),
  updateDesktopSettings: (patch) =>
    ipcRenderer.invoke(COCKPIT_CHANNELS.updateDesktopSettings, desktopSettingsPatch(patch)),
  runUpdateAction: () => ipcRenderer.invoke(COCKPIT_CHANNELS.runUpdateAction),
  recheckServer: () => ipcRenderer.invoke(COCKPIT_CHANNELS.recheckServer),
  openLocalCapabilities: () => ipcRenderer.invoke(COCKPIT_CHANNELS.openLocalCapabilities),
  onDesktopSettings: (listener) => {
    if (typeof listener !== "function") return () => {};
    const handler = (_event: unknown, settings: DesktopSettingsView) => listener(settings);
    ipcRenderer.on(COCKPIT_CHANNELS.desktopSettingsChanged, handler);
    return () => ipcRenderer.removeListener(COCKPIT_CHANNELS.desktopSettingsChanged, handler);
  },
  onFeedbackRequested: (listener) => {
    if (typeof listener !== "function") return () => {};
    const handler = () => listener();
    ipcRenderer.on(COCKPIT_CHANNELS.feedbackRequested, handler);
    ipcRenderer.send(COCKPIT_CHANNELS.feedbackListening, true);
    return () => {
      ipcRenderer.removeListener(COCKPIT_CHANNELS.feedbackRequested, handler);
      ipcRenderer.send(COCKPIT_CHANNELS.feedbackListening, false);
    };
  },
};

contextBridge.exposeInMainWorld("subkitDesktop", bridge);
