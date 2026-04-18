#!/usr/bin/env bun
// Remote production engine smoke probe.
//
// Drives only read-only endpoints against a live DEPLOY_URL (default:
// https://subkit-api.mikebild.dev). No mutations. Intended to run
// post-deploy as a rapid health gate and as documentation of what the
// deployed surface currently exposes.
//
// Usage:
//   bun run tests/e2e/remote-health.smoke.ts
//   DEPLOY_URL=https://... bun run tests/e2e/remote-health.smoke.ts

interface Probe {
  name: string;
  path: string;
  expect: { status: number; bodyContains?: string[] };
}

const BASE = process.env.DEPLOY_URL ?? "https://subkit-api.mikebild.dev";

const PROBES: Probe[] = [
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
];

async function run(): Promise<number> {
  let failed = 0;
  for (const p of PROBES) {
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
  return failed === 0 ? 0 : 1;
}

process.exit(await run());
