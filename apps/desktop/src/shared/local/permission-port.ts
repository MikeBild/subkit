import {
  type MediaAccess,
  NO_PERMISSIONS,
  type PermissionKey,
  type PermissionProbe,
  type Permissions,
  permissionsFrom,
  SETTINGS_URLS,
  trackLost,
} from "./permission-model.ts";

export interface PermissionSystem {
  platform: string;
  isTrustedAccessibilityClient(prompt: false): boolean;
  getMediaAccessStatus(kind: "screen"): string;
  openExternal(url: string): Promise<void>;
  relaunch(): void;
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

export class MacPermissions {
  private readonly launch: PermissionProbe | null;
  private current: Permissions = NO_PERMISSIONS;
  private lost: PermissionKey[] = [];

  constructor(private readonly system: PermissionSystem) {
    this.launch = this.probe();
    if (this.launch) this.current = permissionsFrom(this.launch, this.launch);
  }

  view(): PermissionView {
    return { supported: this.launch !== null, permissions: this.current, lost: this.lost };
  }

  check(): PermissionView {
    const probe = this.probe();
    if (!probe || !this.launch) return this.view();
    const next = permissionsFrom(probe, this.launch);
    this.lost = trackLost(this.lost, this.current, next);
    this.current = next;
    return this.view();
  }

  async open(key: PermissionKey): Promise<boolean> {
    if (!this.launch) return false;
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

  private probe(): PermissionProbe | null {
    if (this.system.platform !== "darwin") return null;
    return {
      accessibility: this.system.isTrustedAccessibilityClient(false),
      screen: media(this.system.getMediaAccessStatus("screen")),
    };
  }
}
