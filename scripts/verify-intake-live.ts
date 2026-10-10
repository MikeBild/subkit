#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

const REQUEST_TIMEOUT_MS = 15_000;
const RUN_TIMEOUT_MS = 90_000;
const RUN_ID_RE = /^[a-z0-9][a-z0-9-]{7,63}$/;
const TEST_TENANT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type CheckStatus = "PASS" | "FAIL" | "SKIP";

export interface IntakeLiveArgs {
  engineUrl: string;
  apiKey: string;
  allowWrites: boolean;
  runId: string | null;
  testTenantId: string | null;
  jsonPath: string | null;
}

export interface IntakeLiveCheck {
  id: string;
  status: CheckStatus;
  ms: number;
  assertion: string;
  resource_ids?: string[];
  error?: string;
}

export interface IntakeLiveReport {
  run_id: string | null;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  host_origin: string;
  checks: IntakeLiveCheck[];
  retained_resource_ids: string[];
  cleanup: {
    attempted: false;
    status: "not_attempted";
    resource_ids: string[];
    reason: string;
  };
  summary: { passed: number; failed: number; skipped: number };
}

export class IntakeLiveUsageError extends Error {}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value) throw new IntakeLiveUsageError(`${flag} needs a value`);
  return value;
}

export function parseIntakeLiveArgs(
  argv: string[],
  env: Record<string, string | undefined>,
): IntakeLiveArgs {
  let engineUrl = env.SK_ENGINE_URL ?? "";
  const apiKey = env.SK_INTAKE_TEST_KEY ?? "";
  let allowWrites = false;
  let runId: string | null = null;
  let testTenantId: string | null = null;
  let jsonPath: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--engine-url":
        engineUrl = requiredValue(argv, index, arg);
        index += 1;
        break;
      case "--allow-writes":
        allowWrites = true;
        break;
      case "--run-id":
        runId = requiredValue(argv, index, arg);
        index += 1;
        break;
      case "--test-tenant-id":
        testTenantId = requiredValue(argv, index, arg);
        index += 1;
        break;
      case "--json":
        jsonPath = requiredValue(argv, index, arg);
        index += 1;
        break;
      default:
        throw new IntakeLiveUsageError(`unknown argument: ${arg}`);
    }
  }
  if (!engineUrl) throw new IntakeLiveUsageError("no engine URL (--engine-url or SK_ENGINE_URL)");
  let origin: URL;
  try {
    origin = new URL(engineUrl);
  } catch {
    throw new IntakeLiveUsageError("--engine-url must be an absolute URL");
  }
  if (origin.pathname !== "/" || origin.search || origin.hash)
    throw new IntakeLiveUsageError(
      "--engine-url must be an origin without a path, query, or fragment",
    );
  if (!apiKey) throw new IntakeLiveUsageError("no API key (set SK_INTAKE_TEST_KEY)");
  if (origin.protocol !== "https:" && origin.protocol !== "http:")
    throw new IntakeLiveUsageError("--engine-url must use http or https");
  if (origin.username || origin.password)
    throw new IntakeLiveUsageError("--engine-url must not contain credentials");
  if (allowWrites) {
    if (!runId || !RUN_ID_RE.test(runId))
      throw new IntakeLiveUsageError(
        "--allow-writes requires --run-id (8-64 lowercase letters, digits, hyphens)",
      );
    if (!testTenantId || !TEST_TENANT_ID_RE.test(testTenantId))
      throw new IntakeLiveUsageError("--allow-writes requires --test-tenant-id (UUID)");
    if (!jsonPath) throw new IntakeLiveUsageError("--allow-writes requires --json <report-path>");
  } else if (runId || testTenantId) {
    throw new IntakeLiveUsageError("--run-id and --test-tenant-id require --allow-writes");
  }
  return {
    engineUrl: origin.origin,
    apiKey,
    allowWrites,
    runId,
    testTenantId,
    jsonPath,
  };
}

function errorText(error: unknown, apiKey = ""): string {
  const text = error instanceof Error ? error.message : String(error);
  return (apiKey ? text.replaceAll(apiKey, "***") : text)
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .replace(/wf_live_[A-Za-z0-9_-]+/g, "wf_live_***")
    .slice(0, 500);
}

function requestId(runId: string): string {
  const hex = createHash("sha256").update(`subkit-intake-smoke:${runId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function endpoint(origin: string, path: string): string {
  return new URL(path, `${origin}/`).toString();
}

export function openApiHasIntakeContract(document: unknown): boolean {
  if (!document || typeof document !== "object") return false;
  const paths = (document as { paths?: Record<string, unknown> }).paths;
  return Boolean(
    paths?.["/v1/categories"] &&
      paths?.["/v1/intake/default-category"] &&
      paths?.["/v1/intake/items"] &&
      paths?.["/v1/intake/proposals"] &&
      paths?.["/v1/intake/proposals/{id}/confirm"] &&
      paths?.["/v1/agent/briefing"],
  );
}

export function isBodyFreeIntakeSummary(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const expected = ["collected", "reviewing", "proposals"];
  return (
    Object.keys(record).length === expected.length &&
    expected.every(
      (key) =>
        typeof record[key] === "number" &&
        Number.isInteger(record[key]) &&
        (record[key] as number) >= 0,
    )
  );
}

class IntakeLiveRunner {
  readonly checks: IntakeLiveCheck[] = [];
  readonly retained = new Set<string>();
  readonly started = performance.now();

  constructor(
    readonly args: IntakeLiveArgs,
    readonly fetcher: typeof fetch,
  ) {}

  async check(
    id: string,
    assertion: string,
    run: () => Promise<string[] | undefined>,
  ): Promise<boolean> {
    if (performance.now() - this.started >= RUN_TIMEOUT_MS) {
      this.checks.push({
        id,
        status: "FAIL",
        ms: 0,
        assertion,
        error: "total run timeout exceeded",
      });
      return false;
    }
    const started = performance.now();
    try {
      const resourceIds = await run();
      const ids = resourceIds?.filter(Boolean) ?? [];
      for (const resourceId of ids) this.retained.add(resourceId);
      this.checks.push({
        id,
        status: "PASS",
        ms: Math.round(performance.now() - started),
        assertion,
        ...(ids.length ? { resource_ids: ids } : {}),
      });
      return true;
    } catch (error) {
      this.checks.push({
        id,
        status: "FAIL",
        ms: Math.round(performance.now() - started),
        assertion,
        error: errorText(error, this.args.apiKey),
      });
      return false;
    }
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetcher(endpoint(this.args.engineUrl, path), {
      ...init,
      headers: {
        authorization: `Bearer ${this.args.apiKey}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(
        Math.max(
          1,
          Math.min(REQUEST_TIMEOUT_MS, RUN_TIMEOUT_MS - (performance.now() - this.started)),
        ),
      ),
    });
  }

  async json(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.request(path, init);
    if (!response.ok)
      throw new Error(`${init.method ?? "GET"} ${path} returned HTTP ${response.status}`);
    return response.json();
  }

  async runReadOnly(): Promise<void> {
    await this.check("health.contract", "health reports an available SubKit service", async () => {
      const response = await this.fetcher(endpoint(this.args.engineUrl, "/health"), {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = (await response.json()) as { status?: string; service?: string };
      if (!response.ok || body.status !== "ok" || body.service !== "subkit")
        throw new Error("health contract mismatch");
    });
    await this.check(
      "ready.contract",
      "ready reports database and lifecycle readiness",
      async () => {
        const response = await this.fetcher(endpoint(this.args.engineUrl, "/ready"), {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const body = (await response.json()) as {
          status?: string;
          checks?: { database?: string; lifecycle?: string };
        };
        if (
          !response.ok ||
          body.status !== "ready" ||
          body.checks?.database !== "pass" ||
          body.checks?.lifecycle !== "pass"
        )
          throw new Error("ready contract mismatch");
      },
    );
    await this.check(
      "openapi.intake_contract",
      "OpenAPI declares intake categories, proposal confirmation, and briefing routes",
      async () => {
        const response = await this.fetcher(endpoint(this.args.engineUrl, "/openapi.json"), {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const body = await response.json();
        if (!response.ok || !openApiHasIntakeContract(body))
          throw new Error("required public contract paths are absent");
      },
    );
    await this.check(
      "llms.intake_contract",
      "llms-full.txt documents the collection, review, confirmation, and MCP handoff process",
      async () => {
        const response = await this.fetcher(endpoint(this.args.engineUrl, "/llms-full.txt"), {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const text = await response.text();
        if (
          !response.ok ||
          !/collect\s*→\s*review in chat\s*→\s*confirm\s*→\s*knowledge/i.test(text) ||
          !/MCP clients start[\s\S]{0,200}conversation_start/i.test(text)
        )
          throw new Error("llms-full intake and MCP handoff contract mismatch");
      },
    );
    await this.check(
      "clipper.archive",
      "the installable Clipper archive is available",
      async () => {
        const response = await this.fetcher(endpoint(this.args.engineUrl, "/install/clipper.zip"), {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const bytes = await response.arrayBuffer();
        const archive = new Uint8Array(bytes);
        const sha256 = createHash("sha256").update(archive).digest("hex");
        const zipSignature =
          archive[0] === 0x50 && archive[1] === 0x4b && archive[2] === 0x03 && archive[3] === 0x04;
        if (
          !response.ok ||
          !zipSignature ||
          sha256.length !== 64 ||
          response.headers.get("content-type") !== "application/zip"
        )
          throw new Error("clipper archive contract mismatch");
      },
    );
    await this.check(
      "briefing.contract",
      "the authenticated briefing endpoint returns a body-free intake summary field",
      async () => {
        const body = (await this.json("/v1/agent/briefing?domains=intake-smoke")) as {
          intake?: unknown;
          markdown?: unknown;
        };
        if (
          !("intake" in body) ||
          typeof body.markdown !== "string" ||
          !isBodyFreeIntakeSummary(body.intake)
        )
          throw new Error("briefing intake contract mismatch");
      },
    );
  }

  async runWrites(): Promise<void> {
    if (!this.args.runId || !this.args.testTenantId) return;
    const identityVerified = await this.check(
      "write.identity",
      "authenticated user matches the explicit dedicated test tenant",
      async () => {
        const identity = (await this.json("/v1/status")) as {
          user?: { kind?: string };
          tenant?: { id?: string };
        };
        if (identity.user?.kind !== "user")
          throw new Error("write smoke requires a human user identity");
        if (identity.tenant?.id !== this.args.testTenantId)
          throw new Error("authenticated tenant does not match --test-tenant-id");
      },
    );
    if (!identityVerified) return;

    const run = this.args.runId;
    const category = `smoke-${createHash("sha256").update(run).digest("hex").slice(0, 20)}`;
    let itemId = "";
    let proposalId = "";
    let digest = "";
    let revision = 0;
    let sourceId = "";
    let sourceSlug = "";
    const sourceName = `Intake smoke ${run}`;
    const marker = `intake smoke ${run}`;

    if (
      !(await this.check(
        "write.collect",
        "collects one run-labelled clip into the dedicated category",
        async () => {
          const body = (await this.json("/v1/intake/items", {
            method: "POST",
            body: JSON.stringify({
              client_request_id: requestId(run),
              category,
              title: `Smoke clip ${run}`,
              source_url: `https://example.invalid/intake-smoke/${encodeURIComponent(run)}`,
              captured_at: new Date().toISOString(),
              body: marker,
              note: "Production smoke fixture retained for audit.",
            }),
          })) as { id?: string; category?: string };
          if (!body.id || body.category !== category) throw new Error("clip response mismatch");
          itemId = body.id;
          return [itemId];
        },
      ))
    )
      return;
    if (
      !(await this.check(
        "write.preconfirm_exclusion",
        "unconfirmed clip content has zero normal knowledge-search hits",
        async () => {
          const body = (await this.json(
            `/v1/knowledge-sources/search?q=${encodeURIComponent(marker)}`,
          )) as { hits?: Array<{ source_name?: string; snippet?: string }> };
          if (!Array.isArray(body.hits)) throw new Error("invalid knowledge search response");
          if (body.hits.some((hit) => hit.source_name?.includes(run) || hit.snippet?.includes(run)))
            throw new Error("unconfirmed clip appeared in normal knowledge search");
        },
      ))
    )
      return;
    if (
      !(await this.check(
        "write.propose",
        "creates the exact run-labelled proposal and reviewed destination",
        async () => {
          const body = (await this.json("/v1/intake/proposals", {
            method: "POST",
            body: JSON.stringify({
              item_ids: [itemId],
              title: sourceName,
              body: `${marker} confirmed knowledge fixture.`,
              target: { name: sourceName, category: "intake-smoke", tags: ["domain:intake-smoke"] },
            }),
          })) as {
            id?: string;
            current_revision?: number;
            revision?: {
              digest?: string;
              title?: string;
              body?: string;
              target?: { name?: string; category?: string; tags?: string[] };
            };
          };
          if (
            !body.id ||
            !body.current_revision ||
            !body.revision?.digest ||
            body.revision.title !== sourceName ||
            body.revision.body !== `${marker} confirmed knowledge fixture.` ||
            body.revision.target?.name !== sourceName ||
            body.revision.target.category !== "intake-smoke" ||
            body.revision.target.tags?.join(",") !== "domain:intake-smoke"
          )
            throw new Error("proposal response mismatch");
          proposalId = body.id;
          revision = body.current_revision;
          digest = body.revision.digest;
          return [proposalId];
        },
      ))
    )
      return;
    if (
      !(await this.check(
        "write.review_exact",
        "retrieved proposal still matches the reviewed revision and digest",
        async () => {
          const body = (await this.json(`/v1/intake/proposals/${proposalId}`)) as {
            current_revision?: number;
            revision?: {
              digest?: string;
              title?: string;
              body?: string;
              target?: { name?: string; category?: string; tags?: string[] };
            };
          };
          if (
            body.current_revision !== revision ||
            body.revision?.digest !== digest ||
            body.revision.title !== sourceName ||
            body.revision.body !== `${marker} confirmed knowledge fixture.` ||
            body.revision.target?.name !== sourceName ||
            body.revision.target.category !== "intake-smoke" ||
            body.revision.target.tags?.join(",") !== "domain:intake-smoke"
          )
            throw new Error("proposal changed before confirmation");
        },
      ))
    )
      return;
    if (
      !(await this.check(
        "write.confirm",
        "human-scoped confirmation admits the reviewed proposal once",
        async () => {
          const body = (await this.json(`/v1/intake/proposals/${proposalId}/confirm`, {
            method: "POST",
            body: JSON.stringify({ expected_revision: revision, digest }),
          })) as { status?: string; confirmed_knowledge_source_id?: string };
          if (body.status !== "confirmed" || !body.confirmed_knowledge_source_id)
            throw new Error("confirmation response mismatch");
          sourceId = body.confirmed_knowledge_source_id;
          return [sourceId];
        },
      ))
    )
      return;
    await this.check(
      "write.confirm_idempotent",
      "repeating the exact confirmation returns the same single admission",
      async () => {
        const body = (await this.json(`/v1/intake/proposals/${proposalId}/confirm`, {
          method: "POST",
          body: JSON.stringify({ expected_revision: revision, digest }),
        })) as { status?: string; confirmed_knowledge_source_id?: string };
        if (body.status !== "confirmed" || body.confirmed_knowledge_source_id !== sourceId)
          throw new Error("repeat confirmation did not return the original admission");
        return [sourceId];
      },
    );
    await this.check(
      "write.single_admission",
      "the run-labelled knowledge source exists exactly once after repeated confirmation",
      async () => {
        const body = (await this.json(
          `/v1/knowledge-sources?q=${encodeURIComponent(sourceName)}&limit=500`,
        )) as { items?: Array<{ id?: string; name?: string }>; total?: number };
        if (!Array.isArray(body.items) || body.total !== body.items.length)
          throw new Error("source listing is incomplete; cannot prove a single admission");
        const matches = body.items.filter((source) => source.name === sourceName);
        if (matches.length !== 1 || matches[0]?.id !== sourceId)
          throw new Error("repeated confirmation did not yield exactly one source");
        return [sourceId];
      },
    );
    await this.check(
      "write.provenance",
      "admitted clip preserves its source snapshot and points to the confirmed source",
      async () => {
        const item = (await this.json(`/v1/intake/items/${itemId}`)) as {
          state?: string;
          admitted_knowledge_source_id?: string;
          original_snapshot?: { source_url?: string };
        };
        if (
          item.state !== "admitted" ||
          item.admitted_knowledge_source_id !== sourceId ||
          item.original_snapshot?.source_url !==
            `https://example.invalid/intake-smoke/${encodeURIComponent(run)}`
        )
          throw new Error("admitted clip provenance mismatch");
        const source = (await this.json(`/v1/knowledge-sources/${sourceId}`)) as { slug?: string };
        if (!source.slug) throw new Error("confirmed knowledge source is unavailable");
        sourceSlug = source.slug;
        return [sourceId];
      },
    );
    await this.check(
      "write.search",
      "confirmed knowledge is searchable and linked to the admitted source",
      async () => {
        const body = (await this.json(
          `/v1/knowledge-sources/search?q=${encodeURIComponent(marker)}`,
        )) as {
          hits?: Array<{ knowledge_source_id?: string }>;
        };
        if (!body.hits?.some((hit) => hit.knowledge_source_id === sourceId))
          throw new Error("confirmed source was not searchable");
      },
    );
    await this.check(
      "write.briefing",
      "confirmed domain-tagged source appears in the intended briefing",
      async () => {
        const body = (await this.json("/v1/agent/briefing?domains=intake-smoke")) as {
          knowledge_sources?: string[];
        };
        if (!body.knowledge_sources?.includes(sourceSlug))
          throw new Error("confirmed source was not in the domain briefing");
        return [sourceId];
      },
    );
  }
}

export async function runIntakeLiveSmoke(
  args: IntakeLiveArgs,
  fetcher: typeof fetch = fetch,
): Promise<IntakeLiveReport> {
  const started = new Date();
  const runner = new IntakeLiveRunner(args, fetcher);
  await runner.runReadOnly();
  if (args.allowWrites) {
    if (runner.checks.some((check) => check.status === "FAIL"))
      runner.checks.push({
        id: "write.flow",
        status: "SKIP",
        ms: 0,
        assertion: "write flow is blocked because the read-only compatibility checks failed",
      });
    else await runner.runWrites();
  } else {
    runner.checks.push({
      id: "write.flow",
      status: "SKIP",
      ms: 0,
      assertion:
        "write flow requires --allow-writes, a dedicated test tenant ID, run ID, and JSON report path",
    });
  }
  const ended = new Date();
  const failed = runner.checks.filter((check) => check.status === "FAIL").length;
  const skipped = runner.checks.filter((check) => check.status === "SKIP").length;
  return {
    run_id: args.runId,
    started_at: started.toISOString(),
    ended_at: ended.toISOString(),
    duration_ms: ended.getTime() - started.getTime(),
    host_origin: new URL(args.engineUrl).origin,
    checks: runner.checks,
    retained_resource_ids: [...runner.retained],
    cleanup: {
      attempted: false,
      status: "not_attempted",
      resource_ids: [...runner.retained],
      reason:
        "the public intake and knowledge APIs do not provide a deletion endpoint for retained smoke fixtures",
    },
    summary: { passed: runner.checks.length - failed - skipped, failed, skipped },
  };
}

function usage(error: unknown): string {
  return `${errorText(error)}\nusage: SK_INTAKE_TEST_KEY=… bun run verify:intake-live -- --engine-url <selected-test-tenant-origin> [--allow-writes --test-tenant-id <uuid> --run-id <unique-id> --json <report-path>]`;
}

if (import.meta.main) {
  try {
    const args = parseIntakeLiveArgs(process.argv.slice(2), process.env);
    const report = await runIntakeLiveSmoke(args);
    if (args.jsonPath)
      await writeFile(args.jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report));
    process.exit(report.summary.failed > 0 ? 1 : 0);
  } catch (error) {
    console.error(`verify:intake-live: ${usage(error)}`);
    process.exit(2);
  }
}
