import { expect, test } from "bun:test";
import { auditResourceName } from "./resource-name.ts";

test("uses the recorded new name and retains the old name for deleted resources", () => {
  expect(
    auditResourceName({
      resource_type: "workflow",
      before: { name: "Old" },
      after: { name: "New" },
    }),
  ).toBe("New");
  expect(
    auditResourceName({ resource_type: "connector", before: { name: "Removed" }, after: null }),
  ).toBe("Removed");
  expect(
    auditResourceName({ resource_type: "file", before: null, after: { filename: "report.csv" } }),
  ).toBe("report.csv");
});

test("person names remain email addresses and missing evidence never becomes another field", () => {
  expect(
    auditResourceName({
      resource_type: "user",
      before: null,
      after: { email: "person@example.com", name: "Display name" },
    }),
  ).toBe("person@example.com");
  for (const after of [
    null,
    {},
    { name: " " },
    { name: 42 },
    [{ name: "nested" }],
    { id: "identifier", token: "synthetic-token" },
  ]) {
    expect(auditResourceName({ resource_type: "workflow", before: null, after })).toBeNull();
  }
  expect(
    auditResourceName({
      resource_type: "credential",
      before: { name: "Secret label" },
      after: null,
    }),
  ).toBeNull();
});

test("unknown prototype property resource types remain unnamed", () => {
  for (const resource_type of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    expect(
      auditResourceName({ resource_type, before: null, after: { name: "Unrelated" } }),
    ).toBeNull();
  }
});

test("uses the domain title fields for skills and connector snapshots", () => {
  expect(
    auditResourceName({ resource_type: "skill", before: null, after: { title: "Guidance" } }),
  ).toBe("Guidance");
  expect(
    auditResourceName({
      resource_type: "connector",
      before: { display_name: "Connection" },
      after: null,
    }),
  ).toBe("Connection");
});
