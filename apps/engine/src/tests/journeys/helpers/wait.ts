import { type WaitForOpts, waitForJson } from "../../../test-helpers/determinism/wait.ts";
import type { JourneyCtx } from "../setup.ts";

export async function waitForJourneyJson<T>(
  ctx: JourneyCtx,
  path: string,
  predicate: (body: T) => boolean,
  opts?: WaitForOpts,
): Promise<T> {
  const doFetch = () =>
    fetch(`${ctx.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
  return waitForJson<T>(doFetch, predicate, { label: `GET ${path}`, ...opts });
}

export interface RunStatusEnvelope {
  run: { id: string; status: string; [k: string]: unknown };
}

export async function waitForRunStatus(
  ctx: JourneyCtx,
  runId: string,
  predicate: (status: string) => boolean,
  opts?: WaitForOpts,
): Promise<RunStatusEnvelope["run"]> {
  const body = await waitForJourneyJson<RunStatusEnvelope>(
    ctx,
    `/v1/runs/${runId}`,
    (b) => predicate(b.run.status),
    { label: `run ${runId} status`, ...opts },
  );
  return body.run;
}

export function waitForRunTerminal(
  ctx: JourneyCtx,
  runId: string,
  opts?: WaitForOpts,
): Promise<RunStatusEnvelope["run"]> {
  return waitForRunStatus(
    ctx,
    runId,
    (s) => s === "succeeded" || s === "failed" || s === "aborted" || s === "timed_out",
    opts,
  );
}
