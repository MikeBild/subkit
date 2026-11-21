import { randomUUID } from "node:crypto";
import { type Session, session } from "electron";
import {
  activeProfile,
  findProfile,
  isSignedIn,
  profileIdFor,
  type StoreData,
} from "../shared/profiles.ts";
import { deviceIdFor } from "../shared/shell-session.ts";
import { hardenSession } from "./hardening.ts";
import { partitionFor } from "./windows.ts";
import { WorkspaceApi } from "./workspace-api.ts";

export interface ProfileSessionsOptions {
  data: () => StoreData;
  onError: (scope: string, error: unknown) => void;
}

export class ProfileSessions {
  private readonly hardened = new Set<string>();
  private pending: ReadonlyMap<string, string> = new Map();
  private workspace: WorkspaceApi | null = null;

  constructor(private readonly options: ProfileSessionsOptions) {}

  sessionFor(origin: string): Session {
    const partition = partitionFor(profileIdFor(origin));
    const scoped = session.fromPartition(partition);
    if (!this.hardened.has(partition)) {
      this.hardened.add(partition);
      hardenSession(scoped, origin);
    }
    return scoped;
  }

  deviceIdFor(origin: string): string {
    const id = profileIdFor(origin);
    const known = findProfile(this.options.data(), id)?.deviceId;
    const next = deviceIdFor(known, this.pending, id, randomUUID());
    this.pending = next.pending;
    return next.id;
  }

  takePendingDevice(origin: string): string | undefined {
    const id = profileIdFor(origin);
    const device = this.pending.get(id);
    const rest = new Map(this.pending);
    rest.delete(id);
    this.pending = rest;
    return device;
  }

  forgetUnused(origin: string): void {
    const id = profileIdFor(origin);
    if (findProfile(this.options.data(), id) || !this.hardened.has(partitionFor(id))) return;
    void this.clear(origin);
  }

  clear(origin: string): Promise<void> {
    return this.sessionFor(origin)
      .clearStorageData()
      .catch((error) => this.options.onError("session.clear", error));
  }

  workspaceApi(): WorkspaceApi | null {
    const profile = activeProfile(this.options.data());
    if (!isSignedIn(profile)) return null;
    const target = { serverOrigin: profile.serverOrigin, cockpitPath: profile.cockpitPath };
    if (!this.workspace?.matches(target))
      this.workspace = new WorkspaceApi(this.sessionFor(profile.serverOrigin), target);
    return this.workspace;
  }
}
