/* eslint-disable no-template-curly-in-string -- literal `${...}` placeholder tokens are part of the tested grammar. */
// Validation-fingerprint loop-break — repeated identical-shape
// validation failures across DIFFERENT args trigger a structured
// short-circuit. Distinct from the args-hash repeat detector, which
// only catches IDENTICAL args; this one catches the case where the
// model varies the args trying to dodge the same constraint
// (session f00b8d1c: build_workflow → propose_step → build_workflow
// all hitting "${item.…} placeholder outside loop body").

import { describe, expect, test } from "bun:test";

import { computeValidationFingerprint } from "../sdk-wrap.ts";

describe("computeValidationFingerprint", () => {
  test("identical errors produce the same fingerprint", () => {
    const a = computeValidationFingerprint([
      { path: "steps.fetch_resources", message: "step uses ${item.…} placeholder" },
      { path: "steps.loop_projects", message: "unknown loop body target: fetch_resources" },
    ]);
    const b = computeValidationFingerprint([
      { path: "steps.fetch_resources", message: "step uses ${item.…} placeholder" },
      { path: "steps.loop_projects", message: "unknown loop body target: fetch_resources" },
    ]);
    expect(a).toBe(b);
    expect(a).not.toBeNull();
  });

  test("reordering errors does not change the fingerprint", () => {
    const a = computeValidationFingerprint([
      { path: "steps.0", message: "missing connector_id" },
      { path: "steps.1", message: "invalid kind" },
    ]);
    const b = computeValidationFingerprint([
      { path: "steps.1", message: "invalid kind" },
      { path: "steps.0", message: "missing connector_id" },
    ]);
    expect(a).toBe(b);
  });

  test("different error messages produce different fingerprints", () => {
    const a = computeValidationFingerprint([{ path: "steps.0", message: "missing connector_id" }]);
    const b = computeValidationFingerprint([{ path: "steps.0", message: "invalid path" }]);
    expect(a).not.toBe(b);
  });

  test("UUIDs in messages are normalised so otherwise-identical errors hash the same", () => {
    const a = computeValidationFingerprint([
      {
        path: "steps.0",
        message: "connector 11111111-2222-3333-4444-555555555555 not found",
      },
    ]);
    const b = computeValidationFingerprint([
      {
        path: "steps.0",
        message: "connector 99999999-8888-7777-6666-555555555555 not found",
      },
    ]);
    expect(a).toBe(b);
  });

  test("numbers in messages are normalised — different step indexes still match", () => {
    const a = computeValidationFingerprint([
      { path: "steps.0", message: "step 1 missing connector_id" },
    ]);
    const b = computeValidationFingerprint([
      { path: "steps.0", message: "step 7 missing connector_id" },
    ]);
    expect(a).toBe(b);
  });

  test("empty / unrecognisable input returns null", () => {
    expect(computeValidationFingerprint([])).toBeNull();
    expect(computeValidationFingerprint([{ path: 42 as unknown as string }])).toBeNull();
  });

  test("message-prefix truncation prevents long-message divergence", () => {
    // Two identical errors except for trailing tail past 60 chars
    // should hash identically — the tail is usually a stack /
    // serialised payload that varies between runs.
    const baseMsg = "X".repeat(60);
    const a = computeValidationFingerprint([{ path: "p", message: `${baseMsg}AAAAAAAAA` }]);
    const b = computeValidationFingerprint([{ path: "p", message: `${baseMsg}ZZZZZZZZZ` }]);
    expect(a).toBe(b);
  });
});
