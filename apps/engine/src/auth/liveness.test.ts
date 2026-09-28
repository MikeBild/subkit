import { describe, expect, test } from "bun:test";
import { clientLivenessRefusal, livenessRefusalDescription } from "./liveness.ts";

const at = new Date("2026-09-01T00:00:00.000Z");

describe("client registration liveness", () => {
  test("an enabled registration may be used", () => {
    expect(clientLivenessRefusal({ disabled_at: null, retired_at: null })).toBeNull();
  });

  test("an administrator's revocation is a revocation", () => {
    const refusal = clientLivenessRefusal({ disabled_at: at, retired_at: null });
    expect(refusal).toBe("client_revoked");
    expect(livenessRefusalDescription("client_revoked")).toContain("revoked");
  });

  test("a retired registration says it was retired, and how it comes back", () => {
    // It used to read "revoked — register again", which is neither what
    // happened nor what the client has to do.
    const refusal = clientLivenessRefusal({ disabled_at: at, retired_at: at });
    expect(refusal).toBe("client_retired");
    const description = livenessRefusalDescription("client_retired");
    expect(description).toContain("retired");
    expect(description).not.toContain("revoked");
  });

  test("a missing registration is refused", () => {
    expect(clientLivenessRefusal(undefined)).toBe("client_missing");
  });
});
