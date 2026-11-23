import {
  type MediaAccess,
  mergeProbes,
  NO_PERMISSIONS,
  type PermissionKey,
  type PermissionProbe,
  type Permissions,
  permissionsFrom,
  SETTINGS_URLS,
  trackLost,
} from "./permission-model.ts";

export const PERMISSION_REQUEST_LIMIT_MS = 5_000;

export type PermissionLogValue = string | boolean | null;

export interface PermissionSystem {
  platform: string;
  processPath: string;
  isTrustedAccessibilityClient(prompt: boolean): boolean;
  getMediaAccessStatus(kind: "screen"): string;
  requestScreenCapture(): Promise<void>;
  probeHelper(): Promise<PermissionProbe | null>;
  openExternal(url: string): Promise<void>;
  relaunch(): void;
  log(event: string, fields: Record<string, PermissionLogValue>): void;
}

export interface PermissionView {
  supported: boolean;
  permissions: Permissions;
  lost: PermissionKey[];
}

const MEDIA: readonly MediaAccess[] = ["not-determined", "granted", "denied", "restricted"];

function media(status: string): MediaAccess {
  return (MEDIA as readonly string[]).includes(status) ? (status as MediaAccess) : "unknown";
}

function stateOf(probe: PermissionProbe, key: PermissionKey): string {
  if (key === "screen") return probe.screen;
  return probe.accessibility ? "granted" : "denied";
}

function withinLimit(work: Promise<void>, limitMs: number): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), limitMs);
    work.then(
      () => resolve("requested"),
      (error: unknown) =>
        resolve(`failed: ${error instanceof Error ? error.message : String(error)}`),
    );
    void work.finally(() => clearTimeout(timer)).catch(() => {});
  });
}

export class MacPermissions {
  private readonly launch: PermissionProbe | null;
  private current: Permissions = NO_PERMISSIONS;
  private lost: PermissionKey[] = [];
  private helper: PermissionProbe | null = null;
  private refreshing: Promise<PermissionView> | null = null;
  private readonly requested = new Set<PermissionKey>();

  constructor(
    private readonly system: PermissionSystem,
    private readonly requestLimitMs = PERMISSION_REQUEST_LIMIT_MS,
  ) {
    this.launch = this.ownProbe();
    if (this.launch) this.current = permissionsFrom(this.launch, this.launch);
  }

  view(): PermissionView {
    return { supported: this.launch !== null, permissions: this.current, lost: this.lost };
  }

  check(): PermissionView {
    const own = this.ownProbe();
    if (!own || !this.launch) return this.view();
    const next = permissionsFrom(mergeProbes(own, this.helper), this.launch);
    this.lost = trackLost(this.lost, this.current, next);
    this.current = next;
    return this.view();
  }

  refresh(): Promise<PermissionView> {
    if (!this.launch) return Promise.resolve(this.view());
    this.refreshing ??= this.system
      .probeHelper()
      .catch(() => null)
      .then((helper) => {
        this.helper = helper;
        const view = this.check();
        this.system.log("permissions.checked", {
          process: this.system.processPath,
          accessibility: view.permissions.accessibility,
          screen: view.permissions.screen,
          helper_screen: helper?.screen ?? null,
          restart_pending: view.permissions.restartPending,
        });
        return view;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  async request(key: PermissionKey): Promise<boolean> {
    const before = this.ownProbe();
    if (!before) return false;
    if (stateOf(before, key) === "granted") return false;
    this.requested.add(key);
    const result =
      key === "accessibility"
        ? String(this.system.isTrustedAccessibilityClient(true))
        : await withinLimit(this.system.requestScreenCapture(), this.requestLimitMs);
    const after = this.ownProbe() ?? before;
    this.system.log("permissions.requested", {
      permission: key,
      process: this.system.processPath,
      before: stateOf(before, key),
      result,
      after: stateOf(after, key),
    });
    return true;
  }

  async requestMissingOnce(): Promise<PermissionKey[]> {
    const asked: PermissionKey[] = [];
    for (const key of ["accessibility", "screen"] as const) {
      if (this.requested.has(key)) continue;
      if (await this.request(key)) asked.push(key);
    }
    return asked;
  }

  async open(key: PermissionKey): Promise<boolean> {
    if (!this.launch) return false;
    await this.request(key);
    return this.system.openExternal(SETTINGS_URLS[key]).then(
      () => true,
      () => false,
    );
  }

  relaunch(): boolean {
    if (!this.launch) return false;
    this.system.relaunch();
    return true;
  }

  private ownProbe(): PermissionProbe | null {
    if (this.system.platform !== "darwin") return null;
    return {
      accessibility: this.system.isTrustedAccessibilityClient(false),
      screen: media(this.system.getMediaAccessStatus("screen")),
    };
  }
}
