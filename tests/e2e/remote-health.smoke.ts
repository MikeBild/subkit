#!/usr/bin/env bun
// Remote production engine smoke probe.
//
// Drives the public surfaces against a live DEPLOY_URL (default:
// https://subkit-api.mikebild.dev). The first batch is unauthenticated
// — health, OpenAPI, the auth gate on /metrics. The second batch
// proves the LLM dispatch path actually works end-to-end by creating a
// conversation with a real prompt; that batch needs SK_SMOKE_API_KEY
// (skipped with a warning when absent).
//
// CRITICAL: must run post-deploy and block promotion on failure. The
// previous `internal_error`-on-every-conversation regression shipped
// because no probe in this file ever called POST /v1/conversations.
//
// Usage:
//   bun run tests/e2e/remote-health.smoke.ts
//   DEPLOY_URL=https://... SK_SMOKE_API_KEY=wf_live_xxx \
//     bun run tests/e2e/remote-health.smoke.ts

interface ReadProbe {
  name: string;
  path: string;
  expect: { status: number; bodyContains?: string[] };
}

const BASE = process.env.DEPLOY_URL ?? "https://subkit-api.mikebild.dev";
const SMOKE_KEY = process.env.SK_SMOKE_API_KEY ?? "";

const READ_PROBES: ReadProbe[] = [
  {
    name: "v1 health — liveness + version + db",
    path: "/v1/health",
    expect: {
      status: 200,
      bodyContains: ['"status":"ok"', '"version":', '"db_connected":true'],
    },
  },
  {
    name: "OpenAPI doc — spec is servable",
    path: "/openapi.json",
    expect: { status: 200, bodyContains: ['"openapi":'] },
  },
  {
    name: "Metrics — /metrics requires auth (401 without credentials)",
    path: "/metrics",
    expect: { status: 401 },
  },
  {
    name: "Diagnostics — /v1/diagnostics/llm requires auth (401 without credentials)",
    path: "/v1/diagnostics/llm",
    expect: { status: 401 },
  },
  {
    name: "Diagnostics — /v1/diagnostics/setup requires auth (401 without credentials)",
    path: "/v1/diagnostics/setup",
    expect: { status: 401 },
  },
];

async function runReadProbes(): Promise<number> {
  let failed = 0;
  for (const p of READ_PROBES) {
    const r = await fetch(`${BASE}${p.path}`, {
      method: "GET",
      headers: { accept: "application/json, text/plain" },
    });
    const bodyText = await r.text();
    let ok = r.status === p.expect.status;
    if (ok && p.expect.bodyContains) {
      for (const frag of p.expect.bodyContains) {
        if (!bodyText.includes(frag)) {
          ok = false;
          console.error(`✘ ${p.name} — body missing fragment ${JSON.stringify(frag)}`);
        }
      }
    }
    if (ok) {
      console.log(`✓ ${p.name} (status=${r.status})`);
    } else {
      failed += 1;
      console.log(`✘ ${p.name} — expected status=${p.expect.status}, got ${r.status}`);
      console.log(`  body: ${bodyText.slice(0, 200)}`);
    }
  }
  return failed;
}

/**
 * Inspect /v1/diagnostics/llm — fail fast if the engine resolved
 * provider is `mock`, since that means the conversation dispatch path
 * will never reach a real LLM and every prompt 500s. This is the gate
 * that should have caught the production regression.
 *
 * Authenticated (audit:read) so an unauthenticated visitor cannot
 * fingerprint our LLM posture. Skipped with a warning when
 * SK_SMOKE_API_KEY is missing — same env var as the conversation probe.
 */
async function probeLlmRouting(): Promise<number> {
  if (!SMOKE_KEY) {
    console.log(
      "⚠ /v1/diagnostics/llm — skipped (SK_SMOKE_API_KEY not set). MUST be set post-deploy.",
    );
    return 0;
  }
  const r = await fetch(`${BASE}/v1/diagnostics/llm`, {
    headers: { authorization: `Bearer ${SMOKE_KEY}`, accept: "application/json" },
  });
  if (r.status === 403) {
    console.log("✘ /v1/diagnostics/llm — 403 (smoke key lacks audit:read)");
    return 1;
  }
  if (!r.ok) {
    console.log(`✘ /v1/diagnostics/llm — status ${r.status}`);
    return 1;
  }
  const body = (await r.json()) as {
    inferred_provider?: string;
    provider_env?: string | null;
    configuration_error?: string | null;
  };
  const inferred = body.inferred_provider ?? "(missing)";
  if (inferred === "mock" || inferred === "unconfigured") {
    console.log(
      `✘ LLM routing — inferred_provider=${inferred}; the engine cannot serve real conversations.`,
    );
    if (body.configuration_error) console.log(`  detail: ${body.configuration_error}`);
    console.log(
      "  fix: set AI_GATEWAY_API_KEY + AI_GATEWAY_MODEL, or LLM_PROVIDER plus matching provider credentials.",
    );
    return 1;
  }
  console.log(
    `✓ LLM routing — provider_env=${body.provider_env ?? "(unset)"} inferred_provider=${inferred}`,
  );
  return 0;
}

async function probeSetupValidation(): Promise<number> {
  if (!SMOKE_KEY) {
    console.log(
      "⚠ /v1/diagnostics/setup — skipped (SK_SMOKE_API_KEY not set). MUST be set post-deploy.",
    );
    return 0;
  }
  const r = await fetch(`${BASE}/v1/diagnostics/setup`, {
    headers: { authorization: `Bearer ${SMOKE_KEY}`, accept: "application/json" },
  });
  if (r.status === 403) {
    console.log("✘ /v1/diagnostics/setup — 403 (smoke key lacks audit:read or identity:read)");
    return 1;
  }
  if (!r.ok) {
    console.log(`✘ /v1/diagnostics/setup — status ${r.status}`);
    return 1;
  }
  const body = (await r.json()) as {
    overall_status?: "ok" | "warn" | "blocked";
    issues?: Array<{ severity?: string; title?: string; detail?: string }>;
  };
  const issues = Array.isArray(body.issues) ? body.issues : [];
  const blockers = issues.filter((issue) => issue.severity === "blocker");
  if (body.overall_status === "blocked" || blockers.length > 0) {
    console.log(`✘ Setup validation — overall_status=${body.overall_status ?? "(missing)"}`);
    for (const issue of blockers) {
      console.log(`  blocker: ${issue.title ?? "(untitled)"} — ${issue.detail ?? ""}`);
    }
    return 1;
  }
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  console.log(
    `✓ Setup validation — overall_status=${body.overall_status ?? "ok"} warnings=${warningCount}`,
  );
  return 0;
}

/**
 * Drive POST /v1/conversations with a real prompt. This is the exact
 * path that 500'd on every release because no smoke ever exercised it.
 * Skips with a warning when SK_SMOKE_API_KEY is not provided so the
 * unauthenticated probe set still runs in dev / PR builds; a
 * post-deploy gate MUST set the env var.
 */
async function probeConversationCreate(): Promise<number> {
  if (!SMOKE_KEY) {
    console.log(
      "⚠ POST /v1/conversations — skipped (SK_SMOKE_API_KEY not set). MUST be set post-deploy.",
    );
    return 0;
  }
  const r = await fetch(`${BASE}/v1/conversations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SMOKE_KEY}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ initial_message: "smoke: hello" }),
  });
  const bodyText = await r.text();
  if (r.status === 201) {
    let parsed: { conversation?: { id?: string }; events?: Array<{ type: string }> };
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      console.log(`✘ POST /v1/conversations — 201 but body is not JSON`);
      return 1;
    }
    const id = parsed.conversation?.id ?? "(no id)";
    const events = parsed.events ?? [];
    const completed = events.find((e) => e.type === "completed");
    if (!completed) {
      console.log(
        `✘ POST /v1/conversations — 201 but no 'completed' event in turn (id=${id}). LLM dispatch likely silently failed.`,
      );
      return 1;
    }
    console.log(
      `✓ POST /v1/conversations — 201 + completed (id=${id.slice(0, 8)}, ${events.length} events)`,
    );
    return 0;
  }
  console.log(`✘ POST /v1/conversations — expected 201, got ${r.status}`);
  console.log(`  body: ${bodyText.slice(0, 400)}`);
  return 1;
}

async function run(): Promise<number> {
  let failed = await runReadProbes();
  failed += await probeLlmRouting();
  failed += await probeSetupValidation();
  failed += await probeConversationCreate();
  return failed === 0 ? 0 : 1;
}

process.exit(await run());
