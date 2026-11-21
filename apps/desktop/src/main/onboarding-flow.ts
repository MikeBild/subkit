import {
  type Asked,
  chooseWorkspace,
  MEMBERSHIPS_PATH,
  type Onboarding,
  parseMemberships,
  startOnboarding,
  TENANT_SESSION_PATH,
  tenantSessionBody,
  type WorkspaceOption,
  workspaceFailed,
} from "../shared/onboarding.ts";
import type { WorkspaceApi } from "./workspace-api.ts";

type OnError = (scope: string, error: unknown) => void;

const ok = (status: number) => status >= 200 && status < 300;

export async function loadOnboarding(
  api: WorkspaceApi | null,
  asked: Asked,
  onError: OnError,
): Promise<Onboarding> {
  let workspaces: WorkspaceOption[] = [];
  if (api) {
    try {
      const { status, json } = await api.send("GET", MEMBERSHIPS_PATH);
      if (ok(status)) workspaces = parseMemberships(json);
    } catch (error) {
      onError("onboarding.memberships", error);
    }
  }
  return startOnboarding(workspaces, asked);
}

export async function enterWorkspace(
  api: WorkspaceApi,
  onboarding: Onboarding,
  tenantId: string,
  onError: OnError,
): Promise<Onboarding> {
  try {
    const { status } = await api.send("POST", TENANT_SESSION_PATH, tenantSessionBody(tenantId));
    return ok(status) ? chooseWorkspace(onboarding, tenantId) : workspaceFailed(onboarding);
  } catch (error) {
    onError("onboarding.workspace", error);
    return workspaceFailed(onboarding);
  }
}
