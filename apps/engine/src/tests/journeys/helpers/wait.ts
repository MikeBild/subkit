// Journey-scoped wait helpers.
//
// These wrap the generic determinism/waitForJson helper with journey
// context (baseUrl + bearer auth). Journey tests should *never* call
// `new Promise(r => setTimeout(r, N))` directly — use the helpers here
// instead. A Biome rule enforces this.

import { type WaitForOpts, waitForJson } from "../../../test-helpers/determinism/wait.ts";
import type { JourneyCtx } from "../setup.ts";

/** Poll a GET endpoint (bearer-authed) until the predicate accepts. */
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

/** Poll the run-by-id endpoint until its `status` field satisfies `pred`. */
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

/** Common shorthand for "wait until run is in a terminal state." */
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
