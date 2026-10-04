import { describe, expect, test } from "bun:test";
import { pickProbeRecoveryActions } from "./probe-connector-draft.ts";

describe("pickProbeRecoveryActions", () => {
  test("404 → search_docs + discover_connector_endpoints + update_connector_draft", () => {
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

  test("429 → retry-with-probe (transient)", () => {
    expect(pickProbeRecoveryActions({ status: 429 })).toEqual([
      "probe_connector_draft",
      "fetch_connector_docs",
    ]);
  });

  test("500 → retry-with-probe (transient)", () => {
    expect(pickProbeRecoveryActions({ status: 500 })).toEqual([
      "probe_connector_draft",
      "fetch_connector_docs",
    ]);
  });

  test("503 → retry-with-probe (transient)", () => {
    expect(pickProbeRecoveryActions({ status: 503 })).toEqual([
      "probe_connector_draft",
      "fetch_connector_docs",
    ]);
  });

  test("timeout → update_connector_draft + fetch_connector_docs", () => {
    expect(pickProbeRecoveryActions({ failure_code: "probe_timeout" })).toEqual([
      "update_connector_draft",
      "fetch_connector_docs",
    ]);
  });

  test("unknown / no-status → search_docs catch-all", () => {
    expect(pickProbeRecoveryActions({})).toEqual([
      "search_docs",
      "fetch_connector_docs",
      "update_connector_draft",
    ]);
  });

  test("400 → catch-all (not auth, not transient, likely path)", () => {
    expect(pickProbeRecoveryActions({ status: 400 })).toEqual([
      "search_docs",
      "fetch_connector_docs",
      "update_connector_draft",
    ]);
  });
});
