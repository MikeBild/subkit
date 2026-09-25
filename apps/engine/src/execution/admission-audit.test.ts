// The recording must never become the answer.
//
// Every caller of `auditAdmissionRefusal` stands between a refusal and what the
// caller of THAT is told. `writeAudit` propagates an insert failure, so an
// unguarded audit call would turn a clean 409 into a 500, and in the queue
// handler it would finalize the execution row with the audit error's message —
// corrupting the trail at the one moment it matters. The conditions that break
// the write (pool exhaustion) are exactly the conditions under which a refusal
// is most worth recording, so this is not a rare path.

import { expect, test } from "bun:test";
import type { Executor } from "../db/client.ts";
import { auditAdmissionRefusal } from "./admission-audit.ts";

/** An executor whose insert always fails — the pool-exhaustion shape. */
const brokenDb = {
  insert() {
    throw new Error("remaining connection slots are reserved");
  },
} as unknown as Executor;

test("a failed audit write does not become the caller's error", async () => {
  // No rejects-assertion: the point is that awaiting it resolves at all.
  await auditAdmissionRefusal(
    {
      tenant_id: "00000000-0000-4000-8000-000000000001",
      reason: "execution_authority_required",
      request_source: "api",
    },
    brokenDb,
  );
});

test("a refusal it could not record still reaches the journal", async () => {
  // Captured at the sink, not by patching `logger` — that object is `as const`
  // and its methods cannot be reassigned. Reading the NDJSON the process
  // actually emits is also the stricter check: it proves the line reaches the
  // journal an operator greps, not merely that a function was called.
  const captured: string[] = [];
  const streams = [process.stdout, process.stderr] as const;
  const originals = streams.map((stream) => stream.write.bind(stream));
  for (const stream of streams) {
    stream.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof stream.write;
  }
  try {
    await auditAdmissionRefusal(
      {
        tenant_id: "00000000-0000-4000-8000-000000000002",
        reason: "execution_authority_unavailable",
        workflow_id: "00000000-0000-4000-8000-000000000003",
        request_source: "scheduler",
      },
      brokenDb,
    );
  } finally {
    streams.forEach((stream, index) => {
      stream.write = originals[index] as typeof stream.write;
    });
  }
  const lines = captured
    .join("")
    .split("\n")
    .flatMap((raw) => {
      // The sd-daemon prefix is absent outside systemd, but a line that is not
      // JSON must be skipped rather than fail the parse for every other line.
      try {
        return [JSON.parse(raw.slice(raw.indexOf("{"))) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  const line = lines.find((entry) => entry.action === "execution.boundary_refused.unrecorded");
  // Swallowing the failure silently would trade one blind spot for another:
  // the row is missing AND nobody knows it is missing.
  expect(line).toBeDefined();
  expect(line?.refusal_reason).toBe("execution_authority_unavailable");
  expect(line?.workflow_id).toBe("00000000-0000-4000-8000-000000000003");
});
