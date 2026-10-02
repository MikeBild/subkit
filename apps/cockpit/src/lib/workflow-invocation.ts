import type { components } from "@/api/schema";
import type { TranslationKey } from "@/lib/i18n";

export type WorkflowInvocation = components["schemas"]["WorkflowInvocation"];
export type InvocationHook = NonNullable<WorkflowInvocation["hooks"]>[number];
export type InvocationSchedule = NonNullable<WorkflowInvocation["schedules"]>[number];

/** A way to call a workflow, in the order the tabs stand. */
export const INVOCATION_MODES = ["http", "webhook", "mcp", "schedule", "cli"] as const;
export type InvocationMode = (typeof INVOCATION_MODES)[number];

export const SNIPPET_LANGUAGES = ["curl", "node", "python"] as const;
export type SnippetLanguage = (typeof SNIPPET_LANGUAGES)[number];

/**
 * The ways this workflow can really be called. A request, a tool call and the
 * command line always exist; a hook or a schedule only when one is bound —
 * a tab that could only say "none" is not a way to call anything.
 */
export function invocationModes(
  invocation: Pick<WorkflowInvocation, "hooks" | "schedules">,
): InvocationMode[] {
  return INVOCATION_MODES.filter((mode) => {
    if (mode === "webhook") return (invocation.hooks?.length ?? 0) > 0;
    if (mode === "schedule") return (invocation.schedules?.length ?? 0) > 0;
    return true;
  });
}

/**
 * The tab a reader lands on: the way the workflow is actually started — its
 * effective trigger — when that way is among the tabs, else the request.
 */
export function initialInvocationMode(
  modes: readonly InvocationMode[],
  effectiveTrigger: string | null | undefined,
): InvocationMode {
  if (effectiveTrigger === "schedule" && modes.includes("schedule")) return "schedule";
  if (effectiveTrigger === "webhook" && modes.includes("webhook")) return "webhook";
  return "http";
}

/** The name a signing scheme goes by. Proper names, the same in every language. */
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

/** A fixed input worth showing: an object with at least one key, or any other value. */
export function hasFixedInput(input: unknown): boolean {
  if (input === null || input === undefined) return false;
  if (typeof input === "object" && !Array.isArray(input)) return Object.keys(input).length > 0;
  return true;
}
