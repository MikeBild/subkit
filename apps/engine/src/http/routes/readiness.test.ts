import { describe, expect, test } from "bun:test";
import { readiness } from "./health.ts";

const base = { databaseUp: true, draining: false, schemaDrift: false, version: "12.1.2" };

describe("readiness", () => {
  test("ready when every critical check passes", () => {
    expect(readiness(base)).toEqual({
      status: 200,
      body: {
        status: "ready",
        service: "subkit",
        version: "12.1.2",
        checks: { lifecycle: "pass", database: "pass", schema: "pass" },
        failing: [],
      },
    });
  });

  test("names every failing dependency", () => {
    const { status, body } = readiness({ ...base, databaseUp: false, draining: true });
    expect(status).toBe(503);
    expect(body.failing).toEqual(["lifecycle", "database"]);
  });

  test("schema drift is reported but does not block readiness", () => {
    const { status, body } = readiness({ ...base, schemaDrift: true });
    expect(status).toBe(200);
    expect(body.checks.schema).toBe("drift");
    expect(body.failing).toEqual([]);
  });
});
