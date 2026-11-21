import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { backoffDelay } from "@shared/backoff.ts";
import type { DeviceCapability } from "@shared/device/protocol.ts";
import type { Locale } from "../shared/i18n.ts";
import {
  type ComputerSnapshot,
  computerOffered,
  computerPermissions,
} from "../shared/local/computer-allowances.ts";
import {
  ENROLL_PATH,
  enrollOutcome,
  runnerDirName,
  runnerKeyName,
} from "../shared/local/enrollment-model.ts";
import type { LiveEvent } from "../shared/local/live-view-model.ts";
import type { Permissions } from "../shared/local/permission-model.ts";
import type { RunnerBrowserConfig, RunnerState } from "../shared/local/runner-port.ts";
import type { LocalAllowances } from "./local-allowances.ts";
import { markQuarantine } from "./quarantine.ts";
import { createRunnerHost, type RunnerHost } from "./runner-host.ts";
import type { SecretVault } from "./vault.ts";
import { volumeIdOf } from "./volume-id.ts";
import type { WorkspaceApi } from "./workspace-api.ts";

export const ENROLL_RETRY_MAX_MS = 30 * 60_000;

export interface RunnerTarget {
  readonly api: WorkspaceApi;
  readonly origin: string;
  readonly profileId: string;
}

export interface RunnerWiringOptions {
  readonly script: string;
  readonly userData: string;
  readonly version: string;
  readonly locale: () => Locale;
  readonly vault: SecretVault;
  readonly allowances: LocalAllowances;
  readonly computer: () => Omit<ComputerSnapshot, "permissions">;
  readonly browser: (runnerId: string) => RunnerBrowserConfig | null;
  readonly browserHost: { killAll(): Promise<unknown> };
  readonly permissions: () => Permissions;
  readonly onLive: (event: LiveEvent, screenshot?: Uint8Array) => void;
  readonly idleSeconds: () => number | null;
  readonly target: () => RunnerTarget | null;
  readonly onEnrolled: () => void;
  readonly onState: (state: RunnerState | "crashed" | "given_up") => void;
  readonly onError: (scope: string, error: unknown) => void;
}

interface Running {
  readonly key: string;
  readonly host: RunnerHost;
}

export class RunnerWiring {
  private running: Running | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private revoked = new Set<string>();

  constructor(private readonly options: RunnerWiringOptions) {}

  refresh(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.attempt = 0;
    void this.run();
  }

  allowancesChanged(): void {
    this.running?.host.allowancesChanged();
  }

  computerChanged(): void {
    this.running?.host.computerChanged();
  }

  handBack(commandId: string): void {
    this.running?.host.handBack(commandId);
  }

  stop(): void {
    this.running?.host.stop();
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const current = this.running;
    this.running = null;
    await current?.host.shutdown();
  }

  private retryLater(): void {
    const delay = backoffDelay(this.attempt++, Math.random(), { maxMs: ENROLL_RETRY_MAX_MS });
    this.timer = setTimeout(() => void this.run(), delay);
  }

  private async run(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.ensure();
    } catch (error) {
      this.options.onError("runner.wiring", error);
      this.retryLater();
    } finally {
      this.busy = false;
    }
  }

  private async ensure(): Promise<void> {
    const target = this.options.target();
    if (!target) {
      await this.shutdown();
      return;
    }
    const runnerId = await this.enrolled(target);
    if (!runnerId) return;
    const device = `${target.origin}\u0000${runnerId}`;
    if (this.revoked.has(device)) return;
    const browser = this.options.browser(runnerId);
    const capabilities = this.capabilities(browser);
    const key = `${device}\u0000${capabilities.join(",")}\u0000${browser?.sites.length ?? 0}`;
    if (this.running?.key === key) return;
    await this.shutdown();
    this.running = { key, host: this.hostFor(target, runnerId, device, capabilities, browser) };
    this.running.host.start();
  }

  private async enrolled(target: RunnerTarget): Promise<string | null> {
    const { allowances, vault } = this.options;
    const known = allowances.runnerIdFor(target.origin);
    if (known && vault.get(runnerKeyName(target.origin))) return known;
    if (!vault.available()) return null;
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const response = await target.api.send(
      "POST",
      ENROLL_PATH,
      JSON.stringify({ public_key: publicKey, runner_version: this.options.version }),
    );
    const outcome = enrollOutcome(response.status, response.json);
    if (outcome.kind === "retry") {
      this.retryLater();
      return null;
    }
    if (outcome.kind === "refused") return null;
    vault.set(runnerKeyName(target.origin), privateKey);
    allowances.rememberRunner(target.origin, outcome.device_runner_id);
    this.attempt = 0;
    this.options.onEnrolled();
    return outcome.device_runner_id;
  }

  private capabilities(browser: RunnerBrowserConfig | null): DeviceCapability[] {
    return [
      "files",
      ...(browser ? (["browser"] as const) : []),
      ...(computerOffered({
        ...this.options.computer(),
        permissions: computerPermissions(this.options.permissions()),
      })
        ? (["computer"] as const)
        : []),
    ];
  }

  private hostFor(
    target: RunnerTarget,
    runnerId: string,
    key: string,
    capabilities: DeviceCapability[],
    browser: RunnerBrowserConfig | null,
  ): RunnerHost {
    const { allowances, vault } = this.options;
    const dir = join(this.options.userData, "runner", runnerDirName(target.profileId));
    return createRunnerHost({
      script: this.options.script,
      config: {
        server_origin: target.origin,
        device_runner_id: runnerId,
        ledger_path: join(dir, "ledger.json"),
        runner_version: this.options.version,
        locale: this.options.locale(),
        os: "darwin",
        capabilities,
        browser,
      },
      stopStatePath: join(dir, "stop.json"),
      computer: this.options.computer,
      permissions: this.options.permissions,
      onLive: this.options.onLive,
      idleSeconds: this.options.idleSeconds,
      files: () => allowances.snapshot(),
      mayTouch: (path) => allowances.mayTouch(path),
      mark: (path) => markQuarantine(path, Date.now()),
      volumeId: (path) => volumeIdOf(path),
      privateKey: () => vault.get(runnerKeyName(target.origin)),
      browser: this.options.browserHost,
      onState: (state) => {
        if (state === "revoked") {
          this.revoked.add(key);
          void this.shutdown();
        }
        this.options.onState(state);
      },
      now: Date.now,
    });
  }
}
