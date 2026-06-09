// probe-recovery — same mapping, three call sites. The mapping
// itself is hoisted out of probe_connector_draft so probe_connector
// and dry_run_step can reuse it; this test pins the contract once.

import { describe, expect, test } from "bun:test";
import { pickProbeRecoveryActions, probeStatusHint } from "../probe-recovery.ts";

describe("pickProbeRecoveryActions", () => {
  test("404 → search_docs + discover_connector_endpoints", () => {
    expect(pickProbeRecoveryActions({ status: 404 })).toEqual([
      "search_docs",
      "discover_connector_endpoints",
      "update_connector_draft",
    ]);
  });

  test("401 → setup_connector_credentials + update_connector_draft + fetch_connector_docs", () => {
    expect(pickProbeRecoveryActions({ status: 401 })).toEqual([
      "setup_connector_credentials",
      "update_connector_draft",
      "fetch_connector_docs",
    ]);
  });

  test("403 → setup_connector_credentials + update_connector_draft + fetch_connector_docs", () => {
    expect(pickProbeRecoveryActions({ status: 403 })).toEqual([
      "setup_connector_credentials",
      "update_connector_draft",
      "fetch_connector_docs",
    ]);
  });

  test("429 → retry probe", () => {
    expect(pickProbeRecoveryActions({ status: 429 })).toEqual([
      "probe_connector_draft",
      "fetch_connector_docs",
    ]);
  });

  test("503 → retry probe", () => {
    expect(pickProbeRecoveryActions({ status: 503 })).toEqual([
      "probe_connector_draft",
      "fetch_connector_docs",
    ]);
  });

  test("probe_timeout → update + docs", () => {
    expect(pickProbeRecoveryActions({ failure_code: "probe_timeout" })).toEqual([
      "update_connector_draft",
      "fetch_connector_docs",
    ]);
  });

  test("request_timeout maps to the same timeout bucket", () => {
    // dry_run_step emits `request_timeout`; probe_*_draft emits
    // `probe_timeout`. Both should land in the same recovery branch.
    expect(pickProbeRecoveryActions({ failure_code: "request_timeout" })).toEqual([
      "update_connector_draft",
      "fetch_connector_docs",
    ]);
  });

  test("unknown / no-status → catch-all", () => {
    expect(pickProbeRecoveryActions({})).toEqual([
      "search_docs",
      "fetch_connector_docs",
      "update_connector_draft",
    ]);
  });

  test("400 → catch-all (not auth, not transient)", () => {
    expect(pickProbeRecoveryActions({ status: 400 })).toEqual([
      "search_docs",
      "fetch_connector_docs",
      "update_connector_draft",
    ]);
  });

  // New assertions for the multi-fix: 401/403 must include update_connector_draft
  // so the LLM is told to check base_url (a valid credential against the wrong host
  // still returns 401).
  test("401 includes update_connector_draft alongside setup_connector_credentials", () => {
    const actions = pickProbeRecoveryActions({ status: 401 });
    expect(actions).toContain("update_connector_draft");
    expect(actions).toContain("setup_connector_credentials");
  });

  test("403 includes update_connector_draft alongside setup_connector_credentials", () => {
    const actions = pickProbeRecoveryActions({ status: 403 });
    expect(actions).toContain("update_connector_draft");
    expect(actions).toContain("setup_connector_credentials");
  });
});

describe("probeStatusHint", () => {
  test("401 returns a non-empty hint mentioning base_url", () => {
    const hint = probeStatusHint(401);
    expect(hint.length).toBeGreaterThan(0);
    expect(hint).toContain("base_url");
  });

  test("403 returns a non-empty hint mentioning base_url", () => {
    const hint = probeStatusHint(403);
    expect(hint.length).toBeGreaterThan(0);
    expect(hint).toContain("base_url");
  });

  test("200 returns an empty string — no caveat needed", () => {
    expect(probeStatusHint(200)).toBe("");
  });

  test("404 returns a non-empty hint", () => {
    const hint = probeStatusHint(404);
    expect(hint.length).toBeGreaterThan(0);
  });

  test("500 returns an empty string — transient, no structural hint", () => {
    expect(probeStatusHint(500)).toBe("");
  });
});
