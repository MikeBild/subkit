import type { components } from "@/api/schema";
import type { TranslationKey } from "@/lib/i18n";

export type WorkflowInvocation = components["schemas"]["WorkflowInvocation"];
export type InvocationHook = NonNullable<WorkflowInvocation["hooks"]>[number];
export type InvocationSchedule = NonNullable<WorkflowInvocation["schedules"]>[number];

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isWorkflowInvocation(value: unknown): value is WorkflowInvocation {
  return (
    record(value) &&
    record(value.http) &&
    typeof value.http.path === "string" &&
    record(value.http.body) &&
    record(value.mcp) &&
    record(value.cli) &&
    record(value.input) &&
    record(value.input.sample) &&
    record(value.output) &&
    record(value.authority) &&
    record(value.visibility) &&
    record(value.webhook_input_shape)
  );
}

export function hiddenInvocationLists(
  invocation: Pick<WorkflowInvocation, "visibility">,
): Array<"hooks" | "schedules"> {
  return (["hooks", "schedules"] as const).filter((list) => !invocation.visibility[list]);
}

export function hiddenInvocationKey(
  hidden: ReadonlyArray<"hooks" | "schedules">,
): TranslationKey | null {
  if (hidden.length === 2) return "invocation.hidden.both";
  if (hidden[0] === "hooks") return "invocation.hidden.hooks";
  if (hidden[0] === "schedules") return "invocation.hidden.schedules";
  return null;
}

export type CallVerdict = "refused" | "live" | "preview" | "unconfirmed";

export function callVerdict(
  invocation: Pick<WorkflowInvocation, "authority" | "invalid">,
  environment: "dev" | "prod",
  approvedEnvironment: "dev" | "prod" | null,
): CallVerdict {
  if (invocation.invalid) return "refused";
  if (invocation.authority[environment] !== "live_run_allowed") return "preview";
  return approvedEnvironment === environment ? "live" : "unconfirmed";
}

export const INVOCATION_MODES = ["http", "webhook", "mcp", "schedule", "cli"] as const;
export type InvocationMode = (typeof INVOCATION_MODES)[number];

export const SNIPPET_LANGUAGES = ["curl", "node", "python"] as const;
export type SnippetLanguage = (typeof SNIPPET_LANGUAGES)[number];

export function invocationModes(
  invocation: Pick<WorkflowInvocation, "hooks" | "schedules">,
): InvocationMode[] {
  return INVOCATION_MODES.filter((mode) => {
    if (mode === "webhook") return (invocation.hooks?.length ?? 0) > 0;
    if (mode === "schedule") return (invocation.schedules?.length ?? 0) > 0;
    return true;
  });
}

export function scheduleRowKey(
  schedule: { cron: string; timezone: string; environment: string },
  index: number,
): string {
  return `${index}:${schedule.environment}:${schedule.cron}:${schedule.timezone}`;
}

export function initialInvocationMode(
  modes: readonly InvocationMode[],
  effectiveTrigger: string | null | undefined,
): InvocationMode {
  if (effectiveTrigger === "schedule" && modes.includes("schedule")) return "schedule";
  if (effectiveTrigger === "webhook" && modes.includes("webhook")) return "webhook";
  return "http";
}

const VERIFIER_NAMES: Record<string, string> = {
  standard: "Standard Webhooks",
  github: "GitHub",
  stripe: "Stripe",
  hmac: "HMAC",
};

export function verifierName(verifier: string): string {
  return VERIFIER_NAMES[verifier] ?? verifier;
}

export const HOOK_STATE_KEYS = {
  active: "invocation.hook.state.active",
  held: "invocation.hook.state.held",
  inactive: "invocation.hook.state.inactive",
} satisfies Record<InvocationHook["state"], TranslationKey>;

export const SCHEDULE_STATE_KEYS = {
  active: "invocation.schedule.state.active",
  paused: "invocation.schedule.state.paused",
  held: "invocation.schedule.state.held",
  activation_required: "invocation.schedule.state.activationRequired",
} satisfies Record<InvocationSchedule["state"], TranslationKey>;

export function hasFixedInput(input: unknown): boolean {
  if (input === null || input === undefined) return false;
  if (typeof input === "object" && !Array.isArray(input)) return Object.keys(input).length > 0;
  return true;
}
