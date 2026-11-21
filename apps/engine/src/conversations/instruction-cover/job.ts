import type { DeviceCapability } from "@shared/device/protocol.ts";
import { originAllowedPersonal, type PersonalSiteOptions } from "@shared/local-policy/addresses.ts";
import type { AlwaysAskClass, BrowserActionClass } from "@shared/local-policy/commit-classifier.ts";
import { type PersonalPathOptions, pathAllowedPersonal } from "@shared/local-policy/paths.ts";
import { localAgenticRefusal, taskRunSource } from "../../devices/core/run-source.ts";
import { ownerWroteGoal } from "../../tasks/core/goal-editor.ts";
import { contentHash } from "../approval-rules/scope.ts";
import type { ActionHints, BoundAction } from "./bound-action.ts";
import { checkContent } from "./content.ts";
import {
  type Because,
  type CoverRefusal,
  decideInstructionCover,
  INSTRUCTION_WINDOW,
  type UserSegment,
} from "./decide.ts";
import { checkQuote, normalizeForQuote } from "./normalize.ts";
import { ownWords, requestWords } from "./own-words.ts";
import { asksForWork, checkRequest, holdsBack } from "./request.ts";
import { spokenFacts } from "./spoken.ts";

export const CHAT_JOB_LIFETIME_MS = 2 * 60 * 60 * 1000;

export type StepPhase = BrowserActionClass;
export type { AlwaysAskClass };

export interface JobRequest {
  readonly source: "own_words" | "task_goal";
  readonly by_person: boolean;
  readonly segments: readonly UserSegment[];
  readonly shown: readonly string[];
  readonly timezone: string;
}

export interface JobState {
  readonly id: string;
  readonly origin: "chat" | "task";
  readonly started_at: Date;
  readonly expires_at: Date;
  readonly outputs: readonly unknown[];
  readonly used_signatures: ReadonlySet<string>;
  readonly device?: PersonalBoundary;
}

export interface PersonalBoundary {
  readonly sites: PersonalSiteOptions;
  readonly paths: PersonalPathOptions | null;
}

export interface ToolStep {
  readonly kind: "tool";
  readonly job_id: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly quote: string | null;
  readonly hints?: ActionHints;
}

export interface DeviceStep {
  readonly kind: "device";
  readonly job_id: string;
  readonly capability: DeviceCapability;
  readonly phase: StepPhase;
  readonly always_ask: AlwaysAskClass | null;
  readonly name: string | null;
  readonly target: string | null;
  readonly values: readonly string[];
  readonly quote: string | null;
  readonly url?: string | null;
  readonly path?: { readonly lexical: string; readonly real: string } | null;
  readonly submits_to?: string | null;
}

export type JobStep = ToolStep | DeviceStep;

export type JobAskReason =
  | CoverRefusal
  | "always_ask"
  | "no_request"
  | "value_not_given"
  | "commit_not_requested"
  | "not_started_by_person";

export type JobRefusal =
  | "other_job"
  | "job_expired"
  | "not_started_by_person"
  | "outside_device_boundary";

export type JobDecision =
  | {
      readonly decision: "covered";
      readonly by: "routine" | "request";
      readonly job_id: string;
      readonly because: Because | null;
      readonly signature: string | null;
      readonly action: BoundAction | null;
    }
  | { readonly decision: "ask"; readonly reason: JobAskReason; readonly detail?: string }
  | { readonly decision: "refuse"; readonly reason: JobRefusal; readonly detail?: string };

export function chatJob(p: {
  readonly anchor_id: string;
  readonly anchor_at: Date;
  readonly outputs?: readonly unknown[];
  readonly used_signatures?: ReadonlySet<string>;
}): JobState {
  return {
    id: p.anchor_id,
    origin: "chat",
    started_at: p.anchor_at,
    expires_at: new Date(p.anchor_at.getTime() + CHAT_JOB_LIFETIME_MS),
    outputs: p.outputs ?? [],
    used_signatures: p.used_signatures ?? new Set(),
  };
}

export function chatRequest(
  segments: readonly UserSegment[],
  shown: readonly string[],
  timezone: string,
): JobRequest {
  return { source: "own_words", by_person: true, segments, shown, timezone };
}

export interface TaskRunFacts {
  readonly task_id: string;
  readonly task_run_id: string;
  readonly owner_id: string;
  readonly goal: string;
  readonly done_when: string;
  readonly goal_edited_by: string | null;
  readonly started_by: string | null;
  readonly created_at: Date;
  readonly deadline_at: Date;
}

export function taskRequest(task: TaskRunFacts, timezone: string): JobRequest {
  const goal = ownerWroteGoal(task.owner_id, task.goal_edited_by)
    ? [task.goal.trim(), task.done_when.trim()].filter((part) => part.length > 0)
    : [];
  return {
    source: "task_goal",
    by_person: localAgenticRefusal(taskRunSource(task, task.owner_id)) === null,
    segments: goal.length === 0 ? [] : [{ id: null, kind: "message", text: goal.join("\n") }],
    shown: [],
    timezone,
  };
}

export function taskJob(
  task: TaskRunFacts,
  p: { readonly outputs?: readonly unknown[]; readonly used_signatures?: ReadonlySet<string> } = {},
): JobState {
  return {
    id: task.task_run_id,
    origin: "task",
    started_at: task.created_at,
    expires_at: task.deadline_at,
    outputs: p.outputs ?? [],
    used_signatures: p.used_signatures ?? new Set(),
  };
}

function ask(reason: JobAskReason, detail?: string): JobDecision {
  return { decision: "ask", reason, ...(detail ? { detail } : {}) };
}

function refuse(reason: JobRefusal, detail?: string): JobDecision {
  return { decision: "refuse", reason, ...(detail ? { detail } : {}) };
}

function latestMessage(request: JobRequest): UserSegment | null {
  return request.segments.findLast((segment) => segment.kind === "message") ?? null;
}

function window(request: JobRequest): UserSegment[] {
  let seen = 0;
  for (let i = request.segments.length - 1; i >= 0; i--) {
    if (request.segments[i]?.kind !== "message") continue;
    seen += 1;
    if (seen === INSTRUCTION_WINDOW) return request.segments.slice(i);
  }
  return [...request.segments];
}

function personFacts(request: JobRequest, now: Date) {
  return spokenFacts(
    window(request).map((segment) =>
      segment.kind === "message" ? ownWords(segment.text) : segment.text,
    ),
    now,
    request.timezone,
  );
}

function stems(terms: readonly string[]): RegExp {
  return new RegExp(`(?:^|[^\\p{L}])(?:${terms.join("|")})`, "u");
}

const RESULT_GROUPS: ReadonlyArray<readonly [string, RegExp]> = [
  ["book", stems(["book", "reserv", "buch", "termin", "appointment"])],
  ["order", stems(["order", "bestell", "buy", "kauf", "purchase", "checkout", "kasse"])],
  ["save", stems(["save", "speicher", "sicher", "write", "schreib"])],
  [
    "send",
    stems([
      "send",
      "senden",
      "absend",
      "schick",
      "versend",
      "reply",
      "antwort",
      "forward",
      "weiterleit",
    ]),
  ],
  [
    "update",
    stems(["update", "apply", "aktualisier", "ubernehm", "anwend", "andern", "anderung", "change"]),
  ],
  ["create", stems(["create", "erstell", "anleg", "eintrag", "trag", "new ", "neu"])],
  ["fill", stems(["fill", "ausfull", "full", "enter", "eingeb"])],
  [
    "organize",
    stems([
      "sort",
      "aufraum",
      "organi",
      "tidy",
      "clean up",
      "move",
      "verschieb",
      "ordne",
      "rename",
      "umbenenn",
      "folder",
      "ordner",
    ]),
  ],
];

const SAVES_OWN_WORK = new Set(["update", "create", "fill", "organize", "save"]);

export function resultGroups(text: string | null): Set<string> {
  const folded = normalizeForQuote(text ?? "");
  return new Set(RESULT_GROUPS.filter(([, pattern]) => pattern.test(folded)).map(([g]) => g));
}

export function coversResult(quote: string, name: string | null): boolean {
  const wanted = resultGroups(quote);
  if ([...wanted].some((group) => SAVES_OWN_WORK.has(group))) wanted.add("save");
  return [...resultGroups(name)].some((group) => wanted.has(group));
}

const EXTRA_ALWAYS_ASK: ReadonlyArray<readonly [ExtraAlwaysAsk, RegExp]> = [
  [
    "account_creation",
    stems([
      "sign up",
      "signup",
      "register",
      "create (?:an |your )?account",
      "registrier",
      "konto erstell",
    ]),
  ],
  [
    "permission_or_settings",
    stems([
      "settings",
      "permission",
      "change password",
      "reset password",
      "einstellung",
      "berechtigung",
      "passwort",
      "password",
    ]),
  ],
];

export type ExtraAlwaysAsk = "account_creation" | "permission_or_settings";

export function extraAlwaysAsk(name: string | null): ExtraAlwaysAsk | null {
  const folded = normalizeForQuote(name ?? "");
  return EXTRA_ALWAYS_ASK.find(([, pattern]) => pattern.test(folded))?.[0] ?? null;
}

const HOST =
  /(?<![\p{L}\p{N}@.-])(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?![\p{L}\p{N}@-])/giu;

export function namedHosts(text: string): string[] {
  return [...text.matchAll(HOST)].map((match) => (match[1] ?? "").toLowerCase());
}

function hostOf(target: string | null): string | null {
  if (!target) return null;
  try {
    return new URL(target).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function siteNamed(target: string | null, hosts: readonly string[]): boolean {
  if (hosts.length === 0) return true;
  const host = hostOf(target);
  if (!host) return false;
  const bare = host.replace(/^www\./u, "");
  return hosts.some((named) => {
    const plain = named.replace(/^www\./u, "");
    return bare === plain || bare.endsWith(`.${plain}`);
  });
}

export function deviceSignature(step: DeviceStep): string {
  return [
    "device",
    step.capability,
    step.target ?? "",
    normalizeForQuote(step.name ?? ""),
    contentHash(step.values) ?? "",
  ].join("|");
}

function decideToolStep(
  request: JobRequest,
  job: JobState,
  step: ToolStep,
  now: Date,
): JobDecision {
  if (!request.by_person) return ask("not_started_by_person");
  const decision = decideInstructionCover({
    tool: step.tool,
    args: step.args,
    quote: step.quote,
    segments: request.segments,
    outputs: job.outputs,
    shown: request.shown,
    ...(step.hints ? { hints: step.hints } : {}),
    used_signatures: job.used_signatures,
    now,
    timezone: request.timezone,
  });
  if (!decision.covered) return ask(decision.reason, decision.detail);
  return {
    decision: "covered",
    by: "request",
    job_id: job.id,
    because: decision.because,
    signature: decision.signature,
    action: decision.action,
  };
}

export function boundaryRefusal(
  boundary: PersonalBoundary | undefined,
  step: DeviceStep,
): string | null {
  if (!boundary) return null;
  if (step.capability === "browser" && step.url) {
    const site = originAllowedPersonal(step.url, boundary.sites);
    if (!site.ok) return site.code;
  }
  if (step.capability === "files" && step.path) {
    if (!boundary.paths) return "outside_allowance";
    const path = pathAllowedPersonal(step.path.lexical, step.path.real, boundary.paths);
    if (!path.ok) return path.code;
  }
  return null;
}

const PAYING_SUBMIT =
  /(?:^|[/_\-.?=&])(pay|payment|payments|zahlung|bezahlen|purchase|kaufen|place-order|placeorder|submit-order|complete-order|order\/(?:place|submit|complete|confirm)|checkout\/(?:pay|complete|confirm|submit|place))(?:$|[/_\-.?=&])/iu;

export function paysOnSubmit(submits_to: string | null | undefined): boolean {
  if (!submits_to) return false;
  try {
    const parsed = new URL(submits_to, "https://page.invalid/");
    return PAYING_SUBMIT.test(`${parsed.pathname}${parsed.search}`);
  } catch {
    return true;
  }
}

function decideDeviceStep(
  request: JobRequest,
  job: JobState,
  step: DeviceStep,
  now: Date,
): JobDecision {
  if (!request.by_person) return refuse("not_started_by_person");
  const outside = boundaryRefusal(job.device, step);
  if (outside !== null) return refuse("outside_device_boundary", outside);
  if (step.always_ask !== null) return ask("always_ask", step.always_ask);
  if (step.phase === "commit" && paysOnSubmit(step.submits_to)) {
    return ask("always_ask", "payment");
  }
  const extra = step.phase === "commit" ? extraAlwaysAsk(step.name) : null;
  if (extra !== null) return ask("always_ask", extra);
  const routine: JobDecision = {
    decision: "covered",
    by: "routine",
    job_id: job.id,
    because: null,
    signature: null,
    action: null,
  };
  if (step.phase === "read") return routine;
  const latest = latestMessage(request);
  const asked = latest ? requestWords(latest.text) : "";
  const said = normalizeForQuote(asked);
  if (!latest || said.length === 0) return ask("no_request");
  if (holdsBack(said)) return ask("conditional_or_negated", "the person held the work back");
  if (step.values.length > 0) {
    const given = checkContent(step.values, personFacts(request, now), request.shown);
    if (!given.ok) return ask("value_not_given", given.detail);
  }
  if (step.phase === "prepare") return routine;
  const quote = step.quote?.trim() ?? "";
  if (quote.length === 0) return ask("no_quote");
  const checked = checkQuote(quote, asked);
  if (!checked.ok) return ask(checked.reason);
  const requested = checkRequest(normalizeForQuote(asked), checked.normalized, []);
  if (!requested.ok && requested.reason === "conditional_or_negated") {
    return ask(requested.reason, requested.detail);
  }
  if (!requested.ok && requested.detail === "information question") return ask("not_a_request");
  if (!asksForWork(checked.normalized)) return ask("not_a_request");
  if (!coversResult(checked.normalized, step.name)) {
    return ask("commit_not_requested", step.name ?? undefined);
  }
  if (step.capability === "browser") {
    const hosts = window(request).flatMap((segment) =>
      segment.kind === "message" ? namedHosts(ownWords(segment.text)) : [],
    );
    if (!siteNamed(step.target, hosts)) return ask("target_not_named", step.target ?? undefined);
  }
  const offered = resultGroups(step.name);
  const savesOnly = offered.size === 1 && offered.has("save");
  const signature = savesOnly ? null : deviceSignature(step);
  if (signature !== null && job.used_signatures.has(signature)) return ask("already_used");
  return {
    decision: "covered",
    by: "request",
    job_id: job.id,
    because: { quote, message_id: latest.id },
    signature,
    action: null,
  };
}

export function decideJobStep(
  request: JobRequest,
  job: JobState,
  step: JobStep,
  now: Date,
): JobDecision {
  if (step.job_id !== job.id) return refuse("other_job");
  if (now.getTime() >= job.expires_at.getTime()) return refuse("job_expired");
  return step.kind === "tool"
    ? decideToolStep(request, job, step, now)
    : decideDeviceStep(request, job, step, now);
}
