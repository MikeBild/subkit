export const ONBOARDING_STEPS = ["workspace", "notifications", "diagnostics"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export interface WorkspaceOption {
  tenantId: string;
  name: string;
  role: string;
  owner: boolean;
}

export interface Onboarding {
  steps: OnboardingStep[];
  done: OnboardingStep[];
  workspaces: WorkspaceOption[];
  chosen: string | null;
  failed: boolean;
  loading: boolean;
}

export const NO_ONBOARDING: Onboarding = {
  steps: [],
  done: [],
  workspaces: [],
  chosen: null,
  failed: false,
  loading: false,
};

export const LOADING_ONBOARDING: Onboarding = { ...NO_ONBOARDING, loading: true };

export interface Asked {
  notificationsAsked: boolean;
  diagnosticsAsked: boolean;
}

export function onboardingSteps(workspaces: number, asked: Asked): OnboardingStep[] {
  return ONBOARDING_STEPS.filter((step) => {
    if (step === "workspace") return workspaces > 1;
    if (step === "notifications") return !asked.notificationsAsked;
    return !asked.diagnosticsAsked;
  });
}

export function startOnboarding(workspaces: WorkspaceOption[], asked: Asked): Onboarding {
  return { ...NO_ONBOARDING, steps: onboardingSteps(workspaces.length, asked), workspaces };
}

export function currentStep(onboarding: Onboarding): OnboardingStep | null {
  return onboarding.steps.find((step) => !onboarding.done.includes(step)) ?? null;
}

export function completeStep(onboarding: Onboarding, step: OnboardingStep): Onboarding {
  if (!onboarding.steps.includes(step) || onboarding.done.includes(step)) return onboarding;
  return { ...onboarding, done: [...onboarding.done, step], failed: false };
}

export function chooseWorkspace(onboarding: Onboarding, tenantId: string): Onboarding {
  if (!onboarding.workspaces.some((workspace) => workspace.tenantId === tenantId))
    return onboarding;
  return { ...completeStep(onboarding, "workspace"), chosen: tenantId };
}

export function workspaceFailed(onboarding: Onboarding): Onboarding {
  return { ...onboarding, failed: true };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseMemberships(json: unknown): WorkspaceOption[] {
  const items = record(json)?.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((raw) => {
    const item = record(raw);
    const tenantId = item?.tenant_id;
    const name = item?.display_name;
    if (typeof tenantId !== "string" || !tenantId || typeof name !== "string") return [];
    return [
      {
        tenantId,
        name: name.slice(0, 120),
        role: typeof item?.role === "string" ? item.role.slice(0, 60) : "",
        owner: item?.is_owner === true,
      },
    ];
  });
}

export const MEMBERSHIPS_PATH = "/v1/identity/memberships";
export const TENANT_SESSION_PATH = "/v1/identity/tenant-session";

export function tenantSessionBody(tenantId: string): string {
  return JSON.stringify({ tenant_id: tenantId });
}
