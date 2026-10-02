import type { components } from "@/api/schema";
import type { TranslationKey } from "@/lib/i18n";

export type WorkflowInvocation = components["schemas"]["WorkflowInvocation"];
export type InvocationHook = NonNullable<WorkflowInvocation["hooks"]>[number];
export type InvocationSchedule = NonNullable<WorkflowInvocation["schedules"]>[number];

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether an answer is an invocation at all. A 200 that carries something
 * else is a failed read, the same as a 500 — the page then says so instead of
 * reading fields off an object that does not have them.
 */
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

/**
 * The lists this reader may not see. An absent list is not an empty one: the
 * workflow may well have hooks or schedules, so the block says that it cannot
 * show them — never, by leaving the tab out, that there are none.
 */
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

/**
 * What a call in one environment will be, as far as the page may say it.
 *
 *   refused      the running version is stored in an earlier format: the
 *                engine refuses the call.
 *   live         the automation panel shows this environment as approved, and
 *                the engine lists an approval for it.
 *   preview      no approval exists: the call runs as a trial without effect.
 *   unconfirmed  an approval exists, but the panel does not show this
 *                environment as approved — the engine's `live_run_allowed`
 *                only says that one is stored, not that the next run is
 *                admitted. The line never promises a live run the panel does
 *                not show.
 */
export type CallVerdict = "refused" | "live" | "preview" | "unconfirmed";

export function callVerdict(
  invocation: Pick<WorkflowInvocation, "authority" | "legacy">,
  environment: "dev" | "prod",
  /** The environment the automation panel shows as approved, or null. */
  approvedEnvironment: "dev" | "prod" | null,
): CallVerdict {
  if (invocation.legacy) return "refused";
  if (invocation.authority[environment] !== "live_run_allowed") return "preview";
  return approvedEnvironment === environment ? "live" : "unconfirmed";
}

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
/**
 * A key per schedule row. Two schedules of one workflow may share cron and
 * time zone and differ only in where they run — a development and a production
 * schedule at 07:00 — so neither of those can be the key alone; the row's
 * place in the engine's list makes it unique.
 */
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
