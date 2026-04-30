// probe-recovery — same mapping, three call sites. The mapping
// itself is hoisted out of probe_connector_draft so probe_connector
// and dry_run_step can reuse it; this test pins the contract once.

import { describe, expect, test } from "bun:test";
import { pickProbeRecoveryActions } from "../probe-recovery.ts";

describe("pickProbeRecoveryActions", () => {
  test("404 → search_docs + discover_connector_endpoints", () => {
    expect(pickProbeRecoveryActions({ status: 404 })).toEqual([
      "search_docs",
      "discover_connector_endpoints",
      "update_connector_draft",
    ]);
  });

  test("401 → setup_connector_credentials", () => {
    expect(pickProbeRecoveryActions({ status: 401 })).toEqual([
      "setup_connector_credentials",
      "fetch_connector_docs",
    ]);
  });

  test("403 → setup_connector_credentials", () => {
    expect(pickProbeRecoveryActions({ status: 403 })).toEqual([
      "setup_connector_credentials",
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
});
