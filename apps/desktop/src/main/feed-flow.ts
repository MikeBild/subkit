import { app } from "electron";
import { type AttentionItem, toNotifications } from "../shared/attention.ts";
import { signInFinished } from "../shared/browser-sheet-model.ts";
import { loginCallback } from "../shared/channel.ts";
import {
  activeProfile,
  findProfile,
  isSignedIn,
  signOutProfile,
  upsertProfile,
} from "../shared/profiles.ts";
import type { AuthFailure } from "../shared/server-contract.ts";
import { tooOldAsk } from "../shared/server-too-old.ts";
import * as model from "../shared/shell-session.ts";
import {
  connectionLog,
  type StatusNotification,
  statusNotification,
} from "../shared/status-model.ts";
import type { Connection } from "../shared/tray-model.ts";
import { appLog } from "./app-log.ts";
import { CHANNEL } from "./channel.ts";
import { AttentionFeed } from "./feed.ts";
import { showNotification } from "./notify.ts";
import { checkServer } from "./server-client.ts";
import type { ShellCore } from "./shell-core.ts";

export class FeedFlow {
  private feed: AttentionFeed | null = null;
  private cause: string | null = null;

  constructor(private readonly core: ShellCore) {}

  start(): void {
    const { core } = this;
    this.stop();
    const profile = activeProfile(core.store.data);
    if (!isSignedIn(profile)) {
      core.device.refresh();
      core.state = model.feedStopped(core.state);
      core.render();
      return;
    }
    const id = profile.id;
    core.state = model.feedStarted(core.state);
    this.feed = new AttentionFeed({
      session: core.sessions.sessionFor(profile.serverOrigin),
      profile: () => {
        const live = findProfile(core.store.data, id);
        return isSignedIn(live) && core.store.data.activeProfileId === id ? live : null;
      },
      muted: () => core.pause.muted(),
      saveProgress: (patch) =>
        core.store.update((data) => upsertProfile(data, profile.serverOrigin, patch), false),
      onItems: (items, notify, summary) => this.onItems(id, items, notify, summary),
      onStatus: (status) => {
        this.setConnection(status);
        if (status === "online") core.state = model.backOnline(core.state, id);
        core.render();
      },
      onAuthFailure: (failure) => this.onAuthFailure(id, failure),
      onEvent: (name, data) => this.onEvent(name, data),
      onError: (scope, error) => {
        if (scope === "events.stream")
          this.cause = error instanceof Error ? error.message : String(error);
        core.record(scope, error);
      },
    });
    this.feed.start();
    core.device.refresh();
    core.render();
  }

  stop(): void {
    this.feed?.stop();
    this.feed = null;
  }

  refresh(): void {
    this.feed?.refresh();
  }

  announce({ notification, target }: StatusNotification): void {
    const { core } = this;
    if (core.pause.muted() || !core.store.data.settings.notifications) return;
    showNotification(notification, () =>
      target === "cockpit" ? core.open() : core.showConnect(target),
    );
  }

  async checkCompatibility(): Promise<void> {
    const { core } = this;
    const profile = activeProfile(core.store.data);
    if (!isSignedIn(profile)) return;
    const check = await checkServer(
      profile.serverOrigin,
      app.getVersion(),
      loginCallback(CHANNEL.scheme),
    );
    if (activeProfile(core.store.data)?.id !== profile.id) return;
    if (check.result.status === "unreachable") return;
    core.state = { ...core.state, tooOld: tooOldAsk(check.result) };
    core.render();
  }

  private setConnection(next: Connection): void {
    const log = connectionLog(this.core.state.connection, next);
    const cause = this.cause ?? "stream_ended";
    if (log === "connection.offline") appLog.warn(log, { cause });
    if (log === "connection.recovered") appLog.info(log, { cause });
    if (next === "online") this.cause = null;
    const change = model.connectionChanged(this.core.state, next);
    if (change.cameOnline) {
      void this.core.pause.load();
      void this.checkCompatibility();
    }
    this.core.state = change.session;
    if (change.notice) this.announce(statusNotification(change.notice, this.core.locale()));
  }

  private onEvent(name: string, data: string): void {
    this.core.device.onStreamEvent(name, data);
    const finished = signInFinished(name, data);
    if (finished) this.core.shellUi.signInFinished(finished);
    this.core.pause.onStreamEvent(name, data);
  }

  private onItems(
    profileId: string,
    items: AttentionItem[],
    notify: AttentionItem[],
    summary: boolean,
  ): void {
    const { core } = this;
    core.state = model.needsYou(core.state, items.length);
    const notifications = core.store.data.settings.notifications
      ? toNotifications(notify, core.locale(), summary)
      : [];
    for (const notification of notifications) {
      showNotification(notification, (href) => {
        if (notification.onDevice === "permissions") return core.showConnect("permissions");
        if (notification.onDevice === "handover") return core.device.live.show();
        const profile = findProfile(core.store.data, profileId);
        if (isSignedIn(profile) && core.store.data.activeProfileId === profileId)
          core.openCockpit(profile, href ?? undefined);
        else core.open();
      });
    }
    core.render();
  }

  private onAuthFailure(profileId: string, failure: AuthFailure): void {
    const { core } = this;
    const profile = findProfile(core.store.data, profileId);
    if (!profile || !isSignedIn(profile)) return;
    const visible = core.windows.cockpitVisible();
    this.stop();
    this.setConnection(failure);
    core.state = model.authFailed(core.state, profileId, failure);
    if (failure === "revoked") {
      core.store.update((data) => signOutProfile(data, profileId));
      void core.sessions.clear(profile.serverOrigin);
    } else {
      core.store.update((data) =>
        upsertProfile(data, profile.serverOrigin, { installationId: null, cockpitPath: null }),
      );
    }
    core.windows.closeCockpit();
    core.device.refresh();
    if (visible) core.showConnect("connect");
    else core.render();
  }
}
