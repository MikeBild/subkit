import { ownWords } from "@shared/own-words.ts";
import { localAgenticRefusal } from "../../devices/core/run-source.ts";
import { deviceToolSpec } from "../core/device-tools/catalog.ts";
import {
  type DeviceStepRecord,
  filledBy,
  resolveRef,
  stepRecord,
} from "../core/device-tools/history.ts";
import {
  type AllowanceFacts,
  personalBoundary,
  type TurnFacts,
  turnRunSource,
} from "../core/device-tools/palette.ts";
import { assembleDeviceStep } from "../core/device-tools/step.ts";
import type { UserSegment } from "./decide.ts";
import { type DeviceToolDecision, decideDeviceTool } from "./device-decision.ts";
import { chatJob, chatRequest, type JobState, taskJob, taskRequest } from "./job.ts";
import {
  failureOf,
  JOB_ID,
  type JobEvalExpect,
  type JobEvalOutcome,
  type JobEvalStepOutcome,
  type JobEvalTask,
  OWNER,
  taskFacts,
} from "./job-eval-cases.ts";
import { spokenFacts } from "./spoken.ts";

export interface DeviceToolEvalStep {
  readonly expect: JobEvalExpect;
  readonly note?: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly device_output?: unknown;
}

export interface DeviceToolEvalCase {
  readonly id: string;
  readonly lang: "de" | "en";
  readonly origin: "chat" | "task";
  readonly messages?: readonly string[];
  readonly shown?: readonly string[];
  readonly task?: JobEvalTask;
  readonly ask_before_writing?: boolean;
  readonly boundary?: {
    readonly keep_out_paths?: readonly string[];
    readonly entered_by_person?: readonly string[];
  };
  readonly steps: readonly DeviceToolEvalStep[];
}

export interface DeviceToolEvalInput {
  readonly now: string;
  readonly timezone: string;
  readonly cases: readonly DeviceToolEvalCase[];
}

const SOMEONE_ELSE = "00000000-0000-4000-8000-000000000002";

function allowances(item: DeviceToolEvalCase): AllowanceFacts[] {
  return [
    ...(item.boundary?.entered_by_person ?? []).map((display) => ({
      kind: "site" as const,
      display,
      entered_by: "person" as const,
      keep_out_target: null,
    })),
    ...(item.boundary?.keep_out_paths ?? []).map((display) => ({
      kind: "keep_out" as const,
      display,
      entered_by: "person" as const,
      keep_out_target: "folder" as const,
    })),
  ];
}

function turnOf(item: DeviceToolEvalCase): TurnFacts {
  if (item.origin === "chat" || !item.task)
    return { person_id: OWNER, interactive: true, task: null };
  const started_by =
    item.task.started_by === "owner"
      ? OWNER
      : item.task.started_by === "other"
        ? SOMEONE_ELSE
        : null;
  return {
    person_id: started_by,
    interactive: false,
    task: { owner_id: OWNER, started_by, sealed: false },
  };
}

function reasonOf(decision: DeviceToolDecision): string | null {
  if (decision.decision === "covered") return null;
  const detail = "detail" in decision && decision.detail ? `: ${decision.detail}` : "";
  return `${decision.reason}${detail}`;
}

export function gradeDeviceToolCase(
  input: DeviceToolEvalInput,
  item: DeviceToolEvalCase,
): JobEvalOutcome {
  const now = new Date(input.now);
  const segments: UserSegment[] = (item.messages ?? []).map((text, index) => ({
    id: `message-${index}`,
    kind: "message" as const,
    text,
  }));
  const task = item.origin === "task" && item.task ? taskFacts(item.task, now) : null;
  const request = task
    ? taskRequest(task, input.timezone)
    : chatRequest(segments, item.shown ?? [], input.timezone);
  const started: JobState = task
    ? taskJob(task)
    : chatJob({ anchor_id: segments.at(-1)?.id ?? JOB_ID, anchor_at: now });
  let job: JobState = { ...started, device: personalBoundary(allowances(item)) };
  const facts = spokenFacts(
    request.segments.map((segment) =>
      segment.kind === "message" ? ownWords(segment.text) : segment.text,
    ),
    now,
    input.timezone,
  );
  const source = localAgenticRefusal(turnRunSource(turnOf(item), OWNER));
  const history: DeviceStepRecord[] = [];
  const steps: JobEvalStepOutcome[] = item.steps.map((entry, index) => {
    const spec = deviceToolSpec(entry.tool);
    if (!spec) throw new Error(`unknown device tool ${entry.tool} in ${item.id}`);
    const parsed = spec.input.parse(entry.input) as Record<string, unknown>;
    const mine = history.filter((step) => step.tool.startsWith(`${spec.capability}_`));
    const resolved = resolveRef(spec, parsed, mine);
    let got: JobEvalExpect;
    let reason: string | null;
    if (source !== null) {
      got = "refuse";
      reason = `not_started_by_person: ${source}`;
    } else if ("ok" in resolved) {
      got = "refuse";
      reason = resolved.error_code;
    } else {
      const decision = decideDeviceTool({
        request,
        job,
        assembled: assembleDeviceStep({
          tool: spec,
          input: parsed,
          job_id: job.id,
          element: resolved.element,
          page_origin: resolved.page_origin,
          app: resolved.app,
          filled: mine.flatMap((step) => step.filled),
          named_urls: facts.urls,
        }),
        ask_before_writing: item.ask_before_writing === true,
        now,
      });
      got = decision.decision === "covered" ? "run" : decision.decision;
      reason = reasonOf(decision);
      if (decision.decision === "covered") {
        if (decision.signature !== null)
          job = { ...job, used_signatures: new Set([...job.used_signatures, decision.signature]) };
        history.unshift(
          stepRecord(
            {
              tool: spec.name,
              device_id: "device",
              filled: filledBy(spec, parsed, resolved.element),
            },
            entry.device_output ?? null,
            `call-${index}`,
          ),
        );
      }
    }
    return { index, expect: entry.expect, got, failure: failureOf(entry.expect, got), reason };
  });
  const failed = steps.find((step) => step.failure !== null);
  return { id: item.id, lang: item.lang, steps, failure: failed?.failure ?? null };
}
