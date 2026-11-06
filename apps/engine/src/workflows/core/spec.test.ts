import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { WorkflowSpec } from "../draft-schemas.ts";
import {
  carriedSpecColumns,
  personOriginRefused,
  readStoredSpec,
  speaksAsPerson,
  workflowSpecDigest,
} from "./spec.ts";

const spec = (origin: WorkflowSpec["origin"], goal: string | null = "Send the board report") =>
  ({
    goal,
    inputs: [],
    outputs: [],
    delivery: null,
    conventions_applied: [],
    evidence: [],
    open_questions: [],
    origin,
  }) as WorkflowSpec;

const browserUser = { kind: "user", auth_source: { kind: "browser_session" } };
const cliUser = { kind: "user", credential_origin: "cli_oauth_session" };
const apiKeyUser = { kind: "user", auth_source: { kind: "api_key" }, credential_origin: null };

describe("carriedSpecColumns", () => {
  test("carries the base spec forward", () => {
    expect(carriedSpecColumns({ spec: { goal: "x" } })).toEqual({ spec: { goal: "x" } });
  });

  test("a missing base or spec carries null", () => {
    expect(carriedSpecColumns(null)).toEqual({ spec: null });
    expect(carriedSpecColumns(undefined)).toEqual({ spec: null });
    expect(carriedSpecColumns({ spec: null })).toEqual({ spec: null });
  });
});

describe("readStoredSpec", () => {
  test("a stored spec is read", () => {
    expect(readStoredSpec(spec("person"))).toEqual(spec("person"));
  });

  test("no stored spec reads as null", () => {
    expect(readStoredSpec(null)).toBeNull();
    expect(readStoredSpec(undefined)).toBeNull();
  });

  test("a malformed spec reads as null", () => {
    expect(readStoredSpec({ goal: "x" })).toBeNull();
    expect(readStoredSpec({ ...spec("person"), extra: true })).toBeNull();
  });
});

describe("speaksAsPerson", () => {
  test("a browser session or CLI login speaks as the person", () => {
    expect(speaksAsPerson(browserUser)).toBe(true);
    expect(speaksAsPerson(cliUser)).toBe(true);
  });

  test("other credentials and actors do not", () => {
    expect(speaksAsPerson(apiKeyUser)).toBe(false);
    expect(speaksAsPerson({ kind: "user" })).toBe(false);
    expect(
      speaksAsPerson({ kind: "system_account", auth_source: { kind: "browser_session" } }),
    ).toBe(false);
    expect(speaksAsPerson({ kind: "system_account", credential_origin: "cli_oauth_session" })).toBe(
      false,
    );
    expect(speaksAsPerson(null)).toBe(false);
    expect(speaksAsPerson(undefined)).toBe(false);
  });
});

describe("personOriginRefused", () => {
  test("only a new person-origin spec needs a person", () => {
    expect(personOriginRefused(spec("person"), null, apiKeyUser)).toBe(true);
    expect(personOriginRefused(spec("person"), null, null)).toBe(true);
    expect(personOriginRefused(spec("person"), null, browserUser)).toBe(false);
    expect(personOriginRefused(spec("chat"), null, apiKeyUser)).toBe(false);
    expect(personOriginRefused(undefined, null, apiKeyUser)).toBe(false);
  });

  test("an unchanged person-origin spec carries without a person", () => {
    expect(personOriginRefused(spec("person"), spec("person"), apiKeyUser)).toBe(false);
    expect(personOriginRefused(spec("person"), spec("person", "Other goal"), apiKeyUser)).toBe(
      true,
    );
  });

  test("a person may always state the spec", () => {
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: null }), fc.jsonValue(), (goal, base) => {
        expect(personOriginRefused(spec("person", goal), base, browserUser)).toBe(false);
        expect(personOriginRefused(spec("person", goal), base, cliUser)).toBe(false);
      }),
      { seed: 20261106, numRuns: 200 },
    );
  });
});

describe("workflowSpecDigest", () => {
  test("absence digests like null", () => {
    expect(workflowSpecDigest(undefined)).toBe(workflowSpecDigest(null));
    expect(workflowSpecDigest(spec("person"))).not.toBe(workflowSpecDigest(null));
  });

  test("the digest ignores key order", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.integer()), (record) => {
        const reversed = Object.fromEntries(Object.entries(record).reverse());
        expect(workflowSpecDigest(reversed)).toBe(workflowSpecDigest(record));
      }),
      { seed: 20261106, numRuns: 200 },
    );
  });
});
