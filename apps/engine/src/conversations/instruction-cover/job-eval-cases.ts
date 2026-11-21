import type { DeviceCapability } from "@shared/device/protocol.ts";
import {
  alwaysAskClass,
  type BrowserActionTarget,
  classifyBrowserAction,
} from "@shared/local-policy/commit-classifier.ts";
import type { UserSegment } from "./decide.ts";
import { type EvalSession, sessionRefusalOf } from "./eval-cases.ts";
import {
  type AlwaysAskClass,
  chatJob,
  chatRequest,
  type DeviceStep,
  decideJobStep,
  type JobDecision,
  type JobState,
  type JobStep,
  type PersonalBoundary,
  type StepPhase,
  type TaskRunFacts,
  taskJob,
  taskRequest,
} from "./job.ts";

export interface DeviceTarget {
  readonly action: string;
  readonly page_url?: string;
  readonly app?: string;
  readonly role?: string | null;
  readonly name?: string | null;
  readonly input_type?: string | null;
  readonly [key: string]: unknown;
}

export interface JobEvalDevice {
  readonly capability: DeviceCapability;
  readonly target: DeviceTarget;
  readonly class: StepPhase;
  readonly always_ask: AlwaysAskClass | null;
  readonly values?: readonly string[];
  readonly quote?: string | null;
}

export type JobEvalExpect = "run" | "ask" | "refuse";

export interface JobEvalStep {
  readonly expect: JobEvalExpect;
  readonly note?: string;
  readonly minutes_later?: number;
  readonly other_job?: boolean;
  readonly tool?: string;
  readonly args?: Record<string, unknown>;
  readonly quote?: string | null;
  readonly template?: string;
  readonly device?: JobEvalDevice;
}

export interface JobEvalTask {
  readonly goal: string;
  readonly done_when?: string;
  readonly started_by: "owner" | "other" | "schedule";
  readonly deadline_minutes?: number;
}

export interface JobEvalCase {
  readonly id: string;
  readonly lang: "de" | "en";
  readonly origin: "chat" | "task";
  readonly messages?: readonly string[];
  readonly answers?: readonly string[];
  readonly shown?: readonly string[];
  readonly evidence?: readonly unknown[];
  readonly task?: JobEvalTask;
  readonly session?: EvalSession;
  readonly steps: readonly JobEvalStep[];
  readonly boundary?: {
    readonly entered_by_person?: readonly string[];
    readonly keep_out_paths?: readonly string[];
  };
}

export interface JobEvalInput {
  readonly now: string;
  readonly timezone: string;
  readonly cases: readonly JobEvalCase[];
}

export type JobEvalFailure = "needless_ask" | "ran_without_asking" | "wrong_stop";

export interface JobEvalStepOutcome {
  readonly index: number;
  readonly expect: JobEvalExpect;
  readonly got: JobEvalExpect;
  readonly failure: JobEvalFailure | null;
  readonly reason: string | null;
}

export interface JobEvalOutcome {
  readonly id: string;
  readonly lang: "de" | "en";
  readonly steps: readonly JobEvalStepOutcome[];
  readonly failure: JobEvalFailure | null;
}

export type DeviceClassifier = (
  capability: DeviceCapability,
  target: DeviceTarget,
) => { readonly phase: StepPhase; readonly always_ask: AlwaysAskClass | null } | null;

export const RECORDED_CLASSES: DeviceClassifier = () => null;

export const C1_CLASSES: DeviceClassifier = (capability, target) => {
  if (capability !== "browser" || typeof target.page_url !== "string") return null;
  const shaped = { ...target, page_url: target.page_url } as unknown as BrowserActionTarget;
  return { phase: classifyBrowserAction(shaped), always_ask: alwaysAskClass(shaped) };
};

const MINUTE = 60_000;
export const OWNER = "00000000-0000-4000-8000-000000000001";
const SOMEONE_ELSE = "00000000-0000-4000-8000-000000000002";
export const JOB_ID = "job-under-test";

function deviceTargetOf(device: JobEvalDevice): string | null {
  if (device.capability === "browser" && device.target.page_url) {
    try {
      return new URL(device.target.page_url).origin;
    } catch {
      return device.target.page_url;
    }
  }
  return device.target.app ?? null;
}

function deviceStep(device: JobEvalDevice, job_id: string, classify: DeviceClassifier): DeviceStep {
  const classified = classify(device.capability, device.target);
  return {
    kind: "device",
    job_id,
    capability: device.capability,
    phase: classified?.phase ?? device.class,
    always_ask: classified ? classified.always_ask : device.always_ask,
    name: typeof device.target.name === "string" ? device.target.name : null,
    target: deviceTargetOf(device),
    values: device.values ?? [],
    quote: device.quote ?? null,
    url: typeof device.target.page_url === "string" ? device.target.page_url : null,
    path:
      typeof device.target.path === "string"
        ? {
            lexical: device.target.path,
            real:
              typeof device.target.real_path === "string"
                ? device.target.real_path
                : device.target.path,
          }
        : null,
    submits_to: typeof device.target.form_action === "string" ? device.target.form_action : null,
  };
}

function boundaryOf(item: JobEvalCase): PersonalBoundary {
  return {
    sites: {
      entered_by_person: item.boundary?.entered_by_person ?? [],
    },
    paths: { os: "darwin", data_dir: null, keep_out: item.boundary?.keep_out_paths ?? [] },
  };
}

function stepOf(item: JobEvalStep, job_id: string, classify: DeviceClassifier): JobStep {
  if (item.device) return deviceStep(item.device, job_id, classify);
  return {
    kind: "tool",
    job_id,
    tool: item.tool ?? "call_connector",
    args: item.args ?? {},
    quote: item.quote ?? null,
    ...(item.template ? { hints: { template: item.template } } : {}),
  };
}

export function taskFacts(task: JobEvalTask, start: Date): TaskRunFacts {
  return {
    task_id: "task-under-test",
    task_run_id: JOB_ID,
    owner_id: OWNER,
    goal: task.goal,
    done_when: task.done_when ?? "",
    goal_edited_by: OWNER,
    started_by:
      task.started_by === "owner" ? OWNER : task.started_by === "other" ? SOMEONE_ELSE : null,
    created_at: start,
    deadline_at: new Date(start.getTime() + (task.deadline_minutes ?? 60) * MINUTE),
  };
}

function gotOf(decision: JobDecision): JobEvalExpect {
  return decision.decision === "covered" ? "run" : decision.decision;
}

export function failureOf(expect: JobEvalExpect, got: JobEvalExpect): JobEvalFailure | null {
  if (expect === got) return null;
  if (got === "run") return "ran_without_asking";
  if (expect === "run") return "needless_ask";
  return "wrong_stop";
}

function reasonOf(decision: JobDecision): string | null {
  if (decision.decision === "covered") return null;
  return `${decision.reason}${decision.detail ? `: ${decision.detail}` : ""}`;
}

export function gradeJobCase(
  input: JobEvalInput,
  item: JobEvalCase,
  classify: DeviceClassifier = C1_CLASSES,
): JobEvalOutcome {
  const now = new Date(input.now);
  const segments: UserSegment[] = [
    ...(item.messages ?? []).map((text, index) => ({
      id: `message-${index}`,
      kind: "message" as const,
      text,
    })),
    ...(item.answers ?? []).map((text) => ({ id: null, kind: "answer" as const, text })),
  ];
  const anchor = segments.findLast((segment) => segment.kind === "message")?.id ?? JOB_ID;
  const request =
    item.origin === "task" && item.task
      ? taskRequest(taskFacts(item.task, now), input.timezone)
      : chatRequest(segments, item.shown ?? [], input.timezone);
  const started: JobState =
    item.origin === "task" && item.task
      ? taskJob(taskFacts(item.task, now), { outputs: item.evidence ?? [] })
      : chatJob({ anchor_id: anchor, anchor_at: now, outputs: item.evidence ?? [] });
  let job: JobState = { ...started, device: boundaryOf(item) };
  const session = item.origin === "chat" ? sessionRefusalOf(item.session) : null;
  const steps: JobEvalStepOutcome[] = [];
  let elapsed = 0;
  item.steps.forEach((entry, index) => {
    elapsed += entry.minutes_later ?? 0;
    const at = new Date(now.getTime() + elapsed * MINUTE);
    const step = stepOf(entry, entry.other_job ? `${job.id}-other` : job.id, classify);
    const decision: JobDecision =
      session !== null
        ? { decision: "ask", reason: "not_started_by_person", detail: session }
        : decideJobStep(request, job, step, at);
    if (decision.decision === "covered" && decision.signature !== null) {
      job = { ...job, used_signatures: new Set([...job.used_signatures, decision.signature]) };
    }
    const got = gotOf(decision);
    steps.push({
      index,
      expect: entry.expect,
      got,
      failure: failureOf(entry.expect, got),
      reason: reasonOf(decision),
    });
  });
  const failed = steps.find((step) => step.failure !== null);
  return { id: item.id, lang: item.lang, steps, failure: failed?.failure ?? null };
}
