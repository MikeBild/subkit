import type { NotificationPauseBody } from "@shared/notification-pause.ts";
import {
  type Held,
  heldHint,
  PAUSE_PATH,
  type PauseSupport,
  parsePause,
  pauseSupportOf,
  pauseToggle,
  trayMute,
} from "../shared/pause-model.ts";
import type { QuietHours } from "../shared/quiet-hours.ts";
import type { WorkspaceApi } from "./workspace-api.ts";

export const PAUSE_MS = 60 * 60_000;

export interface PauseHost {
  settings(): { quietHours: QuietHours; pauseUntil: number | null };
  setLocalPause(until: number | null): void;
  api(): WorkspaceApi | null;
  render(): void;
  onError(scope: string, error: unknown): void;
}

export class PauseFlow {
  private support: PauseSupport = "unknown";
  private server: NotificationPauseBody | null = null;
  private held: Held | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: PauseHost) {}

  mute() {
    const settings = this.host.settings();
    return trayMute({
      support: this.support,
      server: this.server,
      held: this.held,
      quietHours: settings.quietHours,
      localPauseUntil: settings.pauseUntil,
      now: Date.now(),
    });
  }

  muted(): boolean {
    return this.mute() !== null;
  }

  async load(): Promise<void> {
    const api = this.host.api();
    if (!api) return;
    try {
      const { status, json } = await api.send("GET", PAUSE_PATH);
      this.support = pauseSupportOf(status) ?? this.support;
      if (this.support === "server") this.server = parsePause(json) ?? this.server;
    } catch (error) {
      this.host.onError("pause.read", error);
    }
    this.scheduleEnd();
    this.host.render();
  }

  onStreamEvent(name: string, data: string): void {
    const held = heldHint(data, Date.now());
    if (!held && name !== "hello" && name !== "ping" && !data.includes('"delivery"')) return;
    const changed = held?.by !== this.held?.by || held?.until !== this.held?.until;
    this.held = held;
    if (changed) void this.load();
  }

  async toggle(): Promise<void> {
    const paused = this.mute()?.reason === "paused";
    const api = this.host.api();
    if (this.support === "server" && api) {
      const request = pauseToggle(paused);
      try {
        const { status, json } =
          request.method === "PUT"
            ? await api.send("PUT", PAUSE_PATH, JSON.stringify(request.body))
            : await api.send("DELETE", PAUSE_PATH);
        if (status >= 200 && status < 300) this.server = parsePause(json) ?? this.server;
        else this.host.onError("pause.write", new Error(`pause ${status}`));
      } catch (error) {
        this.host.onError("pause.write", error);
      }
      this.scheduleEnd();
      this.host.render();
      return;
    }
    this.host.setLocalPause(paused ? null : Date.now() + PAUSE_MS);
    this.scheduleEnd();
    this.host.render();
  }

  scheduleEnd(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const until = this.mute()?.until?.getTime() ?? null;
    if (until === null || until <= Date.now() || until - Date.now() > 2 ** 31 - 1) return;
    this.timer = setTimeout(
      () => {
        this.scheduleEnd();
        this.host.render();
      },
      until - Date.now() + 500,
    );
  }
}
