import { LAUNCH_SECRET_HEADER, LOCAL_WORKSPACE_PATHS } from "@shared/device/local-launch.ts";
import type { Session } from "electron";
import type { AiAccessInput } from "../shared/local/local-workspace-model.ts";
import type { LocalEngineSession } from "./local-engine.ts";

export interface LauncherSignIn {
  origin: string;
  installationId: string;
  cockpitPath: string;
}

export type AiStored = { accepted: false } | { accepted: true; tools: boolean | null };

export function launcherOrigin(session: LocalEngineSession): string {
  return `http://127.0.0.1:${session.port}`;
}

export class LocalLauncher {
  constructor(
    private readonly session: LocalEngineSession,
    private readonly sessionFor: (origin: string) => Session,
  ) {}

  get origin(): string {
    return launcherOrigin(this.session);
  }

  private send(path: string, init: RequestInit): Promise<Response> {
    return this.sessionFor(this.origin).fetch(`${this.origin}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        [LAUNCH_SECRET_HEADER]: this.session.launchSecret,
      },
      credentials: "include",
      cache: "no-store",
      signal: AbortSignal.timeout(120_000),
    });
  }

  async signIn(owner: { deviceId: string; deviceLabel: string; name: string | null }) {
    const response = await this.send(LOCAL_WORKSPACE_PATHS.session, {
      method: "POST",
      body: JSON.stringify({
        device_id: owner.deviceId,
        device_label: owner.deviceLabel.slice(0, 64),
        ...(owner.name ? { owner: { name: owner.name } } : {}),
      }),
    });
    const body = (await response.json().catch(() => null)) as {
      installation_id?: unknown;
      cockpit_path?: unknown;
    } | null;
    if (
      !response.ok ||
      typeof body?.installation_id !== "string" ||
      typeof body.cockpit_path !== "string"
    )
      throw new Error(`local sign-in answered ${response.status}`);
    return {
      origin: this.origin,
      installationId: body.installation_id,
      cockpitPath: body.cockpit_path,
    } satisfies LauncherSignIn;
  }

  async storeAi(ai: AiAccessInput): Promise<AiStored> {
    const response = await this.send(LOCAL_WORKSPACE_PATHS.ai_access, {
      method: "PUT",
      body: JSON.stringify(
        ai.kind === "provider"
          ? { kind: "provider", provider: ai.provider, api_key: ai.key }
          : { kind: "model_server", origin: ai.origin },
      ),
    });
    if (response.status === 422 || response.status === 502) return { accepted: false };
    if (!response.ok) throw new Error(`AI access answered ${response.status}`);
    const body = (await response.json().catch(() => null)) as { tools?: unknown } | null;
    return { accepted: true, tools: typeof body?.tools === "boolean" ? body.tools : null };
  }

  async exportForMove(serverOrigin: string): Promise<{ name: string; bytes: Uint8Array }> {
    const response = await this.send(LOCAL_WORKSPACE_PATHS.move_to_server, {
      method: "POST",
      body: JSON.stringify({ server_origin: serverOrigin }),
    });
    if (!response.ok) throw new Error(`move answered ${response.status}`);
    const disposition = response.headers.get("content-disposition") ?? "";
    const name = /filename="([^"/\\]+)"/.exec(disposition)?.[1] ?? "workspace.subkit-package.zip";
    return { name, bytes: new Uint8Array(await response.arrayBuffer()) };
  }

  async workers(paused: boolean): Promise<void> {
    const response = await this.send(LOCAL_WORKSPACE_PATHS.workers, {
      method: "PUT",
      body: JSON.stringify({ paused }),
    });
    if (!response.ok) throw new Error(`workers answered ${response.status}`);
  }

  async activeRuns(): Promise<number> {
    const response = await this.send(LOCAL_WORKSPACE_PATHS.activity, { method: "GET" });
    const body = (await response.json().catch(() => null)) as { active_runs?: unknown } | null;
    return response.ok && typeof body?.active_runs === "number" ? body.active_runs : 0;
  }
}
