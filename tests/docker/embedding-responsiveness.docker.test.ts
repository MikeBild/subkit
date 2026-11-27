import { afterAll, beforeAll, expect, test } from "bun:test";
import pg from "pg";
import { pollUntil } from "../e2e/_helpers/poll.ts";
import { observeTransactions } from "./_db-observer.ts";
import {
  composeDown,
  containerDatabaseUrl,
  type DockerEnv,
  dockerApi,
  dockerBoot,
} from "./_harness.ts";

let env: DockerEnv;
beforeAll(async () => {
  env = await dockerBoot();
}, 600_000);
afterAll(() => {
  composeDown();
});

interface Progress {
  embedded: number;
  pending: number;
  total: number;
}

interface WorkflowWrite {
  status: number | null;
  duration_ms: number;
  error: string | null;
  started_ms?: number;
  finished_ms?: number;
}

const WRITE_LATENCY_BUDGET_MS = 2_000;
const WRITE_TRANSPORT_TIMEOUT_MS = 10_000;

function inferenceDocument(): string {
  return Array.from({ length: 48 }, (_, section) => {
    const words = Array.from({ length: 3500 }, (_, word) => `record${section}value${word}`);
    return `# Section ${section}\n\n${words.join(" ").slice(0, 33 * 1024)}`;
  }).join("\n\n");
}

function responseError(body: unknown): string {
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code : null;
    const message = typeof record.message === "string" ? record.message : null;
    if (code !== null || message !== null) return [code, message].filter(Boolean).join(": ");
  }
  if (typeof body === "string") return body;
  return JSON.stringify(body) ?? String(body);
}

test("workflow writes remain available while real local inference is in progress", async () => {
  const db = new pg.Client({ connectionString: containerDatabaseUrl() });
  await db.connect();
  let stopObserving: Awaited<ReturnType<typeof observeTransactions>> | undefined;
  try {
    const progress = async (sourceId: string): Promise<Progress> => {
      const result = await db.query<{ embedded: string; pending: string; total: string }>(
        `SELECT count(*) FILTER (WHERE embedding IS NOT NULL) AS embedded,
                count(*) FILTER (WHERE embedding IS NULL) AS pending, count(*) AS total
         FROM subkit.knowledge_chunks WHERE tenant_id=$1 AND knowledge_source_id=$2`,
        [env.tenantId, sourceId],
      );
      const row = result.rows[0]!;
      return {
        embedded: Number(row.embedded),
        pending: Number(row.pending),
        total: Number(row.total),
      };
    };
    const ingest = async (name: string, content: string): Promise<string> => {
      const response = await dockerApi<{ id: string }>(
        env,
        "POST",
        "/v1/knowledge-sources/inline",
        { name, content },
      );
      expect(response.status).toBe(201);
      return response.body.id;
    };
    const workflowDefinition = (name: string) => ({
      name,
      steps: [{ id: "wait", kind: "wait" as const, duration_ms: 0 }],
    });
    const preflight = await dockerApi<{ id?: string; error?: unknown }>(
      env,
      "POST",
      "/v1/workflows",
      workflowDefinition("Inference workflow preflight"),
    );
    expect(preflight.status).toBe(201);
    const warmup = await ingest(
      "Inference regression warmup",
      "The invoice was paid and the customer needs a receipt.",
    );
    await pollUntil(
      async () => {
        const value = await progress(warmup);
        return value.embedded > 0 && value.pending === 0 ? value : null;
      },
      { timeoutMs: 120_000, label: "real embedding model warmup" },
    );

    if (process.env.SUBKIT_DIAGNOSTICS === "1")
      stopObserving = await observeTransactions(containerDatabaseUrl());
    const source = await ingest("Inference regression workload", inferenceDocument());
    const before = await pollUntil(
      async () => {
        const value = await progress(source);
        return value.embedded > 0 && value.pending >= 16 ? value : null;
      },
      {
        timeoutMs: 120_000,
        intervalMs: 50,
        maxIntervalMs: 100,
        label: "inference started with work remaining",
      },
    );
    const writes = await Promise.allSettled(
      Array.from({ length: 8 }, async (_, index): Promise<WorkflowWrite> => {
        const started = performance.now();
        // allow-wall-clock: aligns writes with external PostgreSQL observations and CPU profiles.
        const started_ms = Date.now();
        try {
          const response = await dockerApi<{ id?: string; error?: unknown }>(
            env,
            "POST",
            "/v1/workflows",
            workflowDefinition(`Inference concurrent workflow ${index}`),
            AbortSignal.timeout(WRITE_TRANSPORT_TIMEOUT_MS),
          );
          return {
            status: response.status,
            duration_ms: Math.round(performance.now() - started),
            error: response.status === 201 ? null : responseError(response.body),
            started_ms,
            // allow-wall-clock: records the real response time for external diagnostic correlation.
            finished_ms: Date.now(),
          };
        } catch (error) {
          return {
            status: null,
            duration_ms: Math.round(performance.now() - started),
            error: error instanceof Error ? error.message : String(error),
            started_ms,
            // allow-wall-clock: records the real transport-failure time for diagnostic correlation.
            finished_ms: Date.now(),
          };
        }
      }),
    );
    const settledWrites = writes.map(
      (result): WorkflowWrite =>
        result.status === "fulfilled"
          ? result.value
          : { status: null, duration_ms: 0, error: String(result.reason) },
    );
    const after = await progress(source);
    if (stopObserving) {
      const observations = await stopObserving();
      stopObserving = undefined;
      process.stdout.write(`[embedding-db-observations] ${JSON.stringify(observations)}\n`);
    }
    process.stdout.write(
      `[embedding-concurrency] ${JSON.stringify({ before, after, writes: settledWrites })}\n`,
    );

    await pollUntil(
      async () => {
        const value = await progress(source);
        return value.total === before.total && value.pending === 0 ? value : null;
      },
      { timeoutMs: 360_000, label: "all workload chunks embedded" },
    );
    expect(after.pending).toBeGreaterThan(0);
    expect(settledWrites.map((write) => write.status)).toEqual(Array(8).fill(201));
    for (const write of settledWrites) {
      expect(write.error).toBeNull();
      expect(write.duration_ms).toBeLessThan(WRITE_LATENCY_BUDGET_MS);
    }
  } finally {
    try {
      if (stopObserving) {
        const observations = await stopObserving();
        process.stdout.write(`[embedding-db-observations] ${JSON.stringify(observations)}\n`);
      }
    } finally {
      await db.end();
    }
  }
}, 720_000);
