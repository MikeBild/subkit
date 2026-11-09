import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  credentialWithinBoundary,
  findAuthorizedEffect,
  governingExecutionCanDispatch,
  referenceWithinBoundary,
} from "./authority-admission.ts";

const snapshot = {
  step_id: "read",
  configuration_digest: "configuration",
  credential_id: "credential",
  credential_revision: 3,
  connection_authority: { id: "connection", revision: 5 },
};
const binding = {
  digest: "binding",
  primary: { id: "credential", revision: 3 },
  connection: { id: "connection", revision: 5 },
};

test("authorized effects match step, digest and entire ordered call path", () => {
  const effect = Object.freeze({
    step_id: "read",
    configuration_digest: "configuration",
    call_path: Object.freeze(["parent", "child"]),
  });
  expect(findAuthorizedEffect([effect], snapshot, ["parent", "child"])).toBe(effect);
  expect(
    findAuthorizedEffect([effect], { ...snapshot, step_id: "other" }, ["parent", "child"]),
  ).toBeUndefined();
  expect(
    findAuthorizedEffect([effect], { ...snapshot, configuration_digest: "changed" }, [
      "parent",
      "child",
    ]),
  ).toBeUndefined();
  expect(findAuthorizedEffect([effect], snapshot, ["child", "parent"])).toBeUndefined();
  expect(findAuthorizedEffect([effect], snapshot, ["parent"])).toBeUndefined();
  expect(
    findAuthorizedEffect(
      [{ step_id: "read", configuration_digest: "configuration" }],
      snapshot,
      [],
    ),
  ).toEqual({ step_id: "read", configuration_digest: "configuration" });
});

test("referenced authorities require the same connector and configuration, with credential constraints when present", () => {
  const reference = {
    connector_id: "connector",
    configuration_digest: "configuration",
    credential_id: "credential",
    credential_revision: 3,
  };
  expect(referenceWithinBoundary(reference, "connector", snapshot)).toBe(true);
  expect(referenceWithinBoundary(reference, null, snapshot)).toBe(false);
  expect(referenceWithinBoundary(reference, "other", snapshot)).toBe(false);
  expect(
    referenceWithinBoundary(
      { ...reference, configuration_digest: "changed" },
      "connector",
      snapshot,
    ),
  ).toBe(false);
  expect(
    referenceWithinBoundary({ ...reference, credential_id: "other" }, "connector", snapshot),
  ).toBe(false);
  expect(
    referenceWithinBoundary({ ...reference, credential_revision: 4 }, "connector", snapshot),
  ).toBe(false);
  expect(
    referenceWithinBoundary({ ...reference, credential_id: null }, "connector", snapshot),
  ).toBe(true);
});

test("credential bindings require available metadata and exact primary/connection revisions", () => {
  expect(credentialWithinBoundary(snapshot, "binding", binding)).toBe(true);
  expect(credentialWithinBoundary(snapshot, "binding", null)).toBe(false);
  expect(credentialWithinBoundary(snapshot, "other", binding)).toBe(false);
  expect(credentialWithinBoundary(snapshot, "binding", { ...binding, primary: null })).toBe(false);
  expect(
    credentialWithinBoundary(snapshot, "binding", {
      ...binding,
      primary: { id: "other", revision: 3 },
    }),
  ).toBe(false);
  expect(
    credentialWithinBoundary(snapshot, "binding", {
      ...binding,
      primary: { id: "credential", revision: 4 },
    }),
  ).toBe(false);
  expect(
    credentialWithinBoundary(snapshot, "binding", {
      ...binding,
      connection: { id: "connection", revision: 6 },
    }),
  ).toBe(false);
  expect(credentialWithinBoundary(snapshot, "binding", { ...binding, connection: null })).toBe(
    false,
  );
  expect(
    credentialWithinBoundary({ ...snapshot, connection_authority: null }, "binding", {
      ...binding,
      connection: null,
    }),
  ).toBe(true);
});

test("only active uncancelled governing runs can dispatch", () => {
  for (const status of ["queued", "running"]) {
    expect(governingExecutionCanDispatch(status, false)).toBe(true);
    expect(governingExecutionCanDispatch(status, true)).toBe(false);
  }
  for (const status of ["succeeded", "failed", "aborted", "timed_out", "unknown"])
    expect(governingExecutionCanDispatch(status, false)).toBe(false);
});

test("different credential revisions cannot inherit a prior boundary", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 1000 }).filter((revision) => revision !== 3),
      (revision) => {
        const facts = Object.freeze({
          ...binding,
          primary: Object.freeze({ id: "credential", revision }),
        });
        const before = JSON.stringify(facts);
        expect(credentialWithinBoundary(snapshot, "binding", facts)).toBe(false);
        expect(JSON.stringify(facts)).toBe(before);
      },
    ),
    { seed: 20261109, numRuns: 100 },
  );
});
