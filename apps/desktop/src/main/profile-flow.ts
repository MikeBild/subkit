import { clipboard, dialog, shell } from "electron";
import { t } from "../shared/i18n.ts";
import type { CheckResult } from "../shared/ipc.ts";
import { completeStep } from "../shared/onboarding.ts";
import {
  activeProfile,
  findProfile,
  isSignedIn,
  type Profile,
  profileIdFor,
  removeProfile,
  upsertProfile,
} from "../shared/profiles.ts";
import type { DesktopSession, ServiceDescriptor } from "../shared/server-contract.ts";
import * as model from "../shared/shell-session.ts";
import { appLog } from "./app-log.ts";
import { type DiagnosticsContext, diagnosticsText } from "./diagnostics.ts";
import { enterWorkspace, loadOnboarding } from "./onboarding-flow.ts";
import { checkAddress, inviteLinkOf } from "./server-checks.ts";
import type { ShellCore } from "./shell-core.ts";

export class ProfileFlow {
  constructor(private readonly core: ShellCore) {}

  activate(id: string): void {
    const { core } = this;
    if (!findProfile(core.store.data, id)) return;
    const switched = core.store.data.activeProfileId !== id;
    if (switched) core.store.update((data) => ({ ...data, activeProfileId: id }));
    core.state = model.profileActivated(core.state, id, switched);
    if (switched) core.feed.start();
    core.render();
    core.open();
  }

  async signIn(address: unknown): Promise<CheckResult> {
    const check = await checkAddress(address);
    const { origin } = check.result;
    if (check.result.status === "compatible" && check.descriptor && origin)
      await this.core.login.start(origin, check.descriptor);
    return check.result;
  }

  async joinInvite(raw: unknown): Promise<CheckResult | null> {
    const link = inviteLinkOf(raw);
    if (!link) return null;
    const check = await checkAddress(link.origin);
    const { origin } = check.result;
    if (check.result.status === "compatible" && check.descriptor && origin)
      await this.core.login.start(origin, check.descriptor, link);
    return check.result;
  }

  signedIn(origin: string, descriptor: ServiceDescriptor, desktop: DesktopSession): void {
    const { core } = this;
    const id = profileIdFor(origin);
    const deviceId = core.sessions.takePendingDevice(origin);
    const patch = {
      installationId: desktop.installationId,
      cockpitPath: desktop.cockpitPath,
      serverVersion: descriptor.version,
      feedbackPath: descriptor.desktop?.feedbackPath ?? null,
    };
    core.store.update((data) => ({
      ...upsertProfile(data, origin, patch, deviceId),
      activeProfileId: id,
    }));
    const signedIn = { profileId: id, origin, serverVersion: descriptor.version };
    core.state = model.signedInTo(core.state, signedIn);
    core.windows.closeCockpit();
    core.feed.start();
    core.revealConnect();
    const api = core.sessions.workspaceApi();
    void loadOnboarding(api, core.store.data.settings, (scope, error) =>
      core.record(scope, error),
    ).then((onboarding) => {
      core.state = { ...core.state, onboarding };
      core.render();
    });
  }

  async chooseWorkspace(tenantId: string | null): Promise<void> {
    const { core } = this;
    const { onboarding } = core.state;
    if (tenantId === null) {
      core.state = { ...core.state, onboarding: completeStep(onboarding, "workspace") };
    } else {
      if (!onboarding.workspaces.some((workspace) => workspace.tenantId === tenantId)) return;
      const api = core.sessions.workspaceApi();
      if (!api) return;
      const next = await enterWorkspace(api, onboarding, tenantId, (scope, error) =>
        core.record(scope, error),
      );
      core.state = { ...core.state, onboarding: next };
    }
    core.render();
  }

  async removeServer(id: string): Promise<void> {
    const { core } = this;
    const profile = findProfile(core.store.data, id);
    if (!profile) return;
    const locale = core.locale();
    const options = {
      type: "warning" as const,
      message: t(locale, "profiles.remove.confirm", { name: profile.label }),
      detail: t(locale, "profiles.remove.detail"),
      buttons: [t(locale, "profiles.remove"), t(locale, "profiles.remove.cancel")],
      defaultId: 1,
      cancelId: 1,
    };
    const connect = core.windows.connect();
    const choice = connect
      ? await dialog.showMessageBox(connect, options)
      : await dialog.showMessageBox(options);
    if (choice.response !== 0) return;
    core.windows.closeCockpit(id);
    core.state = model.serverRemoved(core.state, id);
    await core.sessions.clear(profile.serverOrigin);
    core.store.update((data) => removeProfile(data, id));
    core.feed.start();
  }

  async diagnosticsContext(profile: Profile | null): Promise<DiagnosticsContext> {
    const { core } = this;
    const local = await core.localWorkspace.controller.diagnostics().catch(() => undefined);
    const permissions = core.device.permissions.view();
    return {
      locale: core.locale(),
      serverOrigin: profile?.serverOrigin ?? null,
      serverVersion: profile?.serverVersion ?? null,
      connection: core.state.connection,
      profileCount: core.store.data.profiles.length,
      errors: core.errors.entries,
      local,
      runner: core.device.runnerState,
      permissions: permissions.supported
        ? {
            accessibility: permissions.permissions.accessibility ? "granted" : "missing",
            screen: permissions.permissions.screen ? "granted" : "missing",
          }
        : {},
    };
  }

  async copyDiagnostics(): Promise<void> {
    const profile = activeProfile(this.core.store.data);
    clipboard.writeText(diagnosticsText(await this.diagnosticsContext(profile)));
    appLog.info("diagnostics.copied");
  }

  copyText(text: string): boolean {
    try {
      clipboard.writeText(text);
      appLog.info("clipboard.copied", { length: text.length });
      return true;
    } catch (error) {
      this.core.record("clipboard.copy", error);
      return false;
    }
  }

  async openLogs(): Promise<void> {
    const folder = appLog.directory;
    if (!folder) return;
    const failure = await shell.openPath(folder);
    if (failure) this.core.record("logs.open", new Error(failure));
  }

  async reportProblem(): Promise<void> {
    const { core } = this;
    const profile = activeProfile(core.store.data);
    if (
      isSignedIn(profile) &&
      profile.feedbackPath &&
      (await core.windows.requestFeedback(profile.id))
    )
      return;
    await core.report.open().catch((error) => core.record("report", error));
  }
}
