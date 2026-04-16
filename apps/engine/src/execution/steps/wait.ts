// Wait step. Sleeps the configured duration honoring abort.
import type { WaitStep } from "../../workflows/types.ts";
import type { StepResult, StepRunContext } from "../types.ts";

export async function runWaitStep(p: { ctx: StepRunContext; step: WaitStep }): Promise<StepResult> {
  const start = Date.now();
  try {
    await new Promise<void>((resolve, reject) => {
      if (p.ctx.signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      const t = setTimeout(() => {
        p.ctx.signal.removeEventListener("abort", onAbort);
        resolve();
      }, p.step.duration_ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      };
      p.ctx.signal.addEventListener("abort", onAbort, { once: true });
    });
    return {
      status: "succeeded",
      output: { waited_ms: p.step.duration_ms },
      retry_count: 0,
      duration_ms: Date.now() - start,
    };
  } catch {
    return {
      status: "aborted",
      retry_count: 0,
      duration_ms: Date.now() - start,
      error: { code: "aborted", message: "wait aborted" },
    };
  }
}
