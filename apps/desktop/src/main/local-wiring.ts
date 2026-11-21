import { join } from "node:path";
import { backoffDelay } from "@shared/backoff.ts";
import { LocalAllowances, type SyncOutcome } from "./local-allowances.ts";
import type { WorkspaceApi } from "./workspace-api.ts";

export const SYNC_RETRY_MAX_MS = 15 * 60_000;

export interface LocalTarget {
  readonly api: WorkspaceApi;
  readonly origin: string;
}

export interface LocalWiringOptions {
  readonly userData: string;
  readonly home: string;
  readonly target: () => LocalTarget | null;
  readonly onChange: () => void;
  readonly onError: (scope: string, error: unknown) => void;
}

export class LocalWiring {
  readonly allowances: LocalAllowances;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private again = false;

  constructor(private readonly options: LocalWiringOptions) {
    this.allowances = new LocalAllowances({
      path: join(options.userData, "local-allowances.json"),
      env: { home: options.home, data_dir: options.userData },
      now: Date.now,
      onChange: () => {
        options.onChange();
        this.sync();
      },
      onError: (error) => options.onError("local.allowances", error),
    });
  }

  load(): void {
    this.allowances.load();
  }

  sync(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.attempt = 0;
    if (this.running) {
      this.again = true;
      return;
    }
    void this.run();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async run(): Promise<void> {
    this.running = true;
    const target = this.options.target();
    let outcome: SyncOutcome = "not_enrolled";
    if (target) {
      outcome = await this.allowances.sync(target.api, target.origin).catch((error) => {
        this.options.onError("local.sync", error);
        return "failed" as const;
      });
    }
    this.running = false;
    if (this.again) {
      this.again = false;
      void this.run();
      return;
    }
    if (outcome !== "failed") {
      this.attempt = 0;
      return;
    }
    const delay = backoffDelay(this.attempt++, Math.random(), { maxMs: SYNC_RETRY_MAX_MS });
    this.timer = setTimeout(() => void this.run(), delay);
  }
}
