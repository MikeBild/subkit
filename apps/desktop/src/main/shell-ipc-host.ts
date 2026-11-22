import { desktopSettingsPatch } from "../shared/ipc.ts";
import { findProfile } from "../shared/profiles.ts";
import { connectShown } from "../shared/shell-session.ts";
import { diagnosticsBundle } from "./diagnostics.ts";
import { checkAddress, checkInvite } from "./server-checks.ts";
import type { ShellCore } from "./shell-core.ts";
import type { ShellIpcHost } from "./shell-ipc.ts";

export function shellIpcHost(core: ShellCore): ShellIpcHost {
  const { device, presenter, profiles, settings, windows } = core;
  return {
    connectWindow: () => windows.connect(),
    cockpit: () => {
      const window = windows.cockpitWindow();
      const id = windows.cockpitProfileId();
      return window && id ? { window, profile: findProfile(core.store.data, id) } : null;
    },
    connectState: () => presenter.connectState(),
    checkServer: async (address) => (await checkAddress(address)).result,
    signIn: (address) => profiles.signIn(address),
    cancelLogin: () => core.login.cancel(),
    openProfile: (id) => {
      core.state = connectShown(core.state, core.state.view);
      profiles.activate(id);
    },
    removeServer: (id) => profiles.removeServer(id),
    checkPermissions: () => {
      device.permissionsChecked();
      core.render();
    },
    openPermissionSettings: async (key) => {
      await device.permissions.open(key);
    },
    restartApp: () => {
      if (device.permissions.relaunch()) core.quit();
    },
    showView: (view) => {
      core.state = { ...core.state, view };
      core.render();
    },
    checkUpdates: () => core.updates.check(),
    reportProblem: () => profiles.reportProblem(),
    updateSettings: (input) => settings.change(input),
    chooseWorkspace: (tenantId) => profiles.chooseWorkspace(tenantId),
    answerNotifications: (allow) => settings.answerNotifications(allow),
    answerDiagnostics: (share) => settings.answerDiagnostics(share),
    checkInvite: (link) => checkInvite(link),
    joinInvite: (link) => profiles.joinInvite(link),
    recheckServer: () => core.feed.checkCompatibility(),
    desktopSettings: () => settings.view(),
    updateDesktopSettings: (patch) => settings.change({ ...desktopSettingsPatch(patch) }),
    runUpdateAction: () => core.updates.runAction(),
    diagnostics: async (profile) => diagnosticsBundle(await profiles.diagnosticsContext(profile)),
    copyDiagnostics: () => profiles.copyDiagnostics(),
    openLogs: () => profiles.openLogs(),
    cockpitStatus: () => presenter.cockpitStatus(),
    captureForCockpit: () => windows.captureForCockpit(),
    feedbackListening: (senderId, listening) => windows.feedbackListening(senderId, listening),
    sessionEnded: () => core.feed.refresh(),
    setLocale: (locale) => settings.setLocale(locale),
    allowances: device.local.allowances,
    registerWorkspaceIpc: (handle) => core.localWorkspace.registerIpc(handle),
  };
}
