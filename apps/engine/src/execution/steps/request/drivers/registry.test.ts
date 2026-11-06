import { describe, expect, test } from "bun:test";
import { DriverEnum } from "../../../../connectors/types.ts";
import type { RequestStep } from "../../../../workflows/types.ts";
import { DRIVERS } from "./registry.ts";

const step = { id: "s", kind: "request", method: "GET", retry_backoff_ms: 50 } as RequestStep;

describe("DRIVERS", () => {
  test("registers exactly one request driver per connector driver", () => {
    expect(Object.keys(DRIVERS).sort()).toEqual([...DriverEnum.options].sort());
    for (const [kind, driver] of Object.entries(DRIVERS)) expect(driver.kind as string).toBe(kind);
  });

  test("only graphql, mcp and http retry; s3 and postgres send once", () => {
    expect(DRIVERS.graphql.retryPolicy(step)?.backoff_base_ms).toBe(50);
    expect(DRIVERS.mcp.retryPolicy(step)?.backoff_base_ms).toBe(50);
    expect(DRIVERS.http.retryPolicy(step)?.backoff_base_ms).toBe(50);
    expect(DRIVERS.s3.retryPolicy(step)).toBeNull();
    expect(DRIVERS.postgres.retryPolicy(step)).toBeNull();
    expect(DRIVERS.s3.capabilities.retry).toBe("none");
    expect(DRIVERS.postgres.capabilities.retry).toBe("none");
  });

  test("response filters run on the mcp result and on every http page only", () => {
    expect(
      Object.fromEntries(
        Object.entries(DRIVERS).map(([kind, d]) => [kind, d.capabilities.response_filters]),
      ),
    ).toEqual({ http: "page", graphql: "none", mcp: "result", s3: "none", postgres: "none" });
  });

  test("only http pages through the pipeline, keeps the step timer and maps its own setup errors", () => {
    for (const [kind, d] of Object.entries(DRIVERS)) {
      expect(d.paginate !== undefined).toBe(kind === "http");
      expect(d.capabilities.step_timer).toBe(kind === "http");
      expect(d.capabilities.owns_setup_errors).toBe(kind === "http");
    }
  });

  test("side-effect classification follows the driver", () => {
    expect(DRIVERS.http.classifySideEffects(step)).toBe("read");
    expect(DRIVERS.http.classifySideEffects({ ...step, method: "POST" })).toBe("write");
    expect(DRIVERS.s3.classifySideEffects({ ...step, method: "PUT" })).toBe("write");
  });
});
