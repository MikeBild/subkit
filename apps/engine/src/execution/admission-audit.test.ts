import { expect, test } from "bun:test";
import type { Executor } from "../db/client.ts";
import { auditAdmissionRefusal } from "./admission-audit.ts";

const brokenDb = {
  insert() {
    throw new Error("remaining connection slots are reserved");
  },
} as unknown as Executor;

test("a failed audit write does not become the caller's error", async () => {
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
      try {
        return [JSON.parse(raw.slice(raw.indexOf("{"))) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  const line = lines.find((entry) => entry.action === "execution.boundary_refused.unrecorded");
  expect(line).toBeDefined();
  expect(line?.refusal_reason).toBe("execution_authority_unavailable");
  expect(line?.workflow_id).toBe("00000000-0000-4000-8000-000000000003");
});
