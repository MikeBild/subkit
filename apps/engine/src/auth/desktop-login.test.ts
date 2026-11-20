import { describe, expect, test } from "bun:test";
import {
  createDesktopLoginRateLimiter,
  DESKTOP_LOGIN_CODE_TTL_MS,
  DesktopLoginStartQuerySchema,
  DesktopSessionRequestSchema,
  desktopAppVersionAccepted,
  desktopLoginCallbackFor,
  desktopLoginCallbacks,
  desktopLoginCallbackUrl,
  desktopLoginCodeRejection,
  isDesktopLoginCallbackUrl,
  signDesktopLoginConfirmation,
  signDesktopLoginRequest,
  verifyDesktopLoginConfirmation,
  verifyDesktopLoginRequest,
} from "./desktop-login.ts";
import { sha256Hex } from "./oauth/tokens.ts";

const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const OTHER_VERIFIER = "A".repeat(43);
const STATE = "state-0123456789abcdef";
const DEVICE_ID = "7f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const NOW = new Date("2026-11-20T10:00:00.000Z");

const START = {
  code_challenge: CHALLENGE,
  code_challenge_method: "S256",
  state: STATE,
  device_id: DEVICE_ID,
  device_label: "Mike's MacBook",
};

function facts(overrides: Partial<Parameters<typeof desktopLoginCodeRejection>[0]> = {}) {
  return {
    code_challenge: CHALLENGE,
    state_sha256: sha256Hex(STATE),
    expires_at: new Date(NOW.getTime() + DESKTOP_LOGIN_CODE_TTL_MS),
    consumed_at: null,
    ...overrides,
  };
}

describe("desktop sign-in start parameters", () => {
  test("accepts an S256 challenge, a state and a device", () => {
    expect(DesktopLoginStartQuerySchema.safeParse(START).success).toBe(true);
  });

  test("refuses the plain challenge method", () => {
    expect(
      DesktopLoginStartQuerySchema.safeParse({ ...START, code_challenge_method: "plain" }).success,
    ).toBe(false);
  });

  test("refuses a challenge that is not a base64url SHA-256", () => {
    for (const code_challenge of ["", "short", `${CHALLENGE}=`, `${CHALLENGE}x`])
      expect(DesktopLoginStartQuerySchema.safeParse({ ...START, code_challenge }).success).toBe(
        false,
      );
  });

  test("refuses a short state, a missing device and a device label with control characters", () => {
    expect(DesktopLoginStartQuerySchema.safeParse({ ...START, state: "short" }).success).toBe(
      false,
    );
    expect(DesktopLoginStartQuerySchema.safeParse({ ...START, device_id: "laptop" }).success).toBe(
      false,
    );
    expect(
      DesktopLoginStartQuerySchema.safeParse({ ...START, device_label: "Mac\u0000Book" }).success,
    ).toBe(false);
    expect(
      DesktopLoginStartQuerySchema.safeParse({ ...START, device_label: "x".repeat(65) }).success,
    ).toBe(false);
  });

  test("accepts only subkit://callback as a named redirect target and no unknown parameter", () => {
    expect(
      DesktopLoginStartQuerySchema.safeParse({ ...START, redirect_uri: "subkit://callback" })
        .success,
    ).toBe(true);
    for (const redirect_uri of [
      "https://evil.example/callback",
      "subkit://callback/extra",
      "subkit://evil",
      "SUBKIT://callback",
      "/cockpit",
    ])
      expect(DesktopLoginStartQuerySchema.safeParse({ ...START, redirect_uri }).success).toBe(
        false,
      );
    expect(
      DesktopLoginStartQuerySchema.safeParse({ ...START, return_to: "https://evil.example" })
        .success,
    ).toBe(false);
  });
});

describe("desktop sign-in callback target", () => {
  test("is always subkit://callback with the code and the state", () => {
    const url = desktopLoginCallbackUrl({ code: "abc_DEF-123", state: STATE });
    expect(url).toBe(`subkit://callback?code=abc_DEF-123&state=${STATE}`);
    expect(isDesktopLoginCallbackUrl(url)).toBe(true);
  });

  test("carries a refusal without a code", () => {
    const url = desktopLoginCallbackUrl({ error: "access_denied", state: STATE });
    expect(url).toBe(`subkit://callback?error=access_denied&state=${STATE}`);
    expect(url).not.toContain("code=");
  });

  test("a state cannot change the target", () => {
    const url = desktopLoginCallbackUrl({ code: "c", state: "x&redirect=https://evil.example#f" });
    expect(isDesktopLoginCallbackUrl(url)).toBe(true);
    expect(new URL(url).searchParams.get("state")).toBe("x&redirect=https://evil.example#f");
  });

  test("nothing else passes as the callback", () => {
    for (const candidate of [
      "https://subkit.example/callback?code=c",
      "subkit://callback.evil.example?code=c",
      "subkit://callback@evil.example?code=c",
      "subkit://callback/path?code=c",
      "subkit://evil?code=c",
      "//callback?code=c",
      "subkit://callback",
    ])
      expect(isDesktopLoginCallbackUrl(candidate)).toBe(false);
  });
});

describe("desktop sign-in request token", () => {
  const request = {
    code_challenge: CHALLENGE,
    state: STATE,
    device_id: DEVICE_ID,
    device_label: "Mike's MacBook",
  };

  test("round-trips the challenge, the state and the device", async () => {
    expect(
      await verifyDesktopLoginRequest(await signDesktopLoginRequest(request, NOW), NOW),
    ).toEqual(request);
  });

  test("a tampered or foreign token is refused", async () => {
    const token = await signDesktopLoginRequest(request, NOW);
    expect(await verifyDesktopLoginRequest(`${token.slice(0, -2)}xx`, NOW)).toBeNull();
    expect(await verifyDesktopLoginRequest("not-a-token", NOW)).toBeNull();
    expect(await verifyDesktopLoginRequest("", NOW)).toBeNull();
  });

  test("expires after ten minutes", async () => {
    const token = await signDesktopLoginRequest(request, NOW);
    expect(await verifyDesktopLoginRequest(token, new Date(NOW.getTime() + 9 * 60_000))).toEqual(
      request,
    );
    expect(
      await verifyDesktopLoginRequest(token, new Date(NOW.getTime() + 11 * 60_000)),
    ).toBeNull();
  });

  test("a confirmation token is not a request token", async () => {
    const confirmation = await signDesktopLoginConfirmation("session-1", "request-token", NOW);
    expect(await verifyDesktopLoginRequest(confirmation, NOW)).toBeNull();
  });
});

describe("desktop sign-in confirmation", () => {
  test("is bound to the browser session and to the request it was shown for", async () => {
    const token = await signDesktopLoginConfirmation("session-1", "request-a", NOW);
    expect(await verifyDesktopLoginConfirmation(token, "session-1", "request-a", NOW)).toBe(true);
    expect(await verifyDesktopLoginConfirmation(token, "session-2", "request-a", NOW)).toBe(false);
    expect(await verifyDesktopLoginConfirmation(token, "session-1", "request-b", NOW)).toBe(false);
    expect(await verifyDesktopLoginConfirmation("forged", "session-1", "request-a", NOW)).toBe(
      false,
    );
  });

  test("expires with the request it confirms", async () => {
    const token = await signDesktopLoginConfirmation("session-1", "request-a", NOW);
    const later = new Date(NOW.getTime() + 11 * 60_000);
    expect(await verifyDesktopLoginConfirmation(token, "session-1", "request-a", later)).toBe(
      false,
    );
  });

  test("a request token does not pass as a confirmation", async () => {
    const request = await signDesktopLoginRequest(
      { code_challenge: CHALLENGE, state: STATE, device_id: DEVICE_ID, device_label: "Laptop" },
      NOW,
    );
    expect(await verifyDesktopLoginConfirmation(request, "session-1", request, NOW)).toBe(false);
  });
});

describe("desktop sign-in code lifecycle", () => {
  test("the matching verifier within the lifetime is accepted", () => {
    expect(desktopLoginCodeRejection(facts(), { code_verifier: VERIFIER, now: NOW })).toBeNull();
    expect(
      desktopLoginCodeRejection(facts(), { code_verifier: VERIFIER, state: STATE, now: NOW }),
    ).toBeNull();
  });

  test("the code lives for at most sixty seconds", () => {
    expect(DESKTOP_LOGIN_CODE_TTL_MS).toBeLessThanOrEqual(60_000);
    const lastMoment = new Date(NOW.getTime() + DESKTOP_LOGIN_CODE_TTL_MS - 1);
    expect(
      desktopLoginCodeRejection(facts(), { code_verifier: VERIFIER, now: lastMoment }),
    ).toBeNull();
    const expiry = new Date(NOW.getTime() + DESKTOP_LOGIN_CODE_TTL_MS);
    expect(desktopLoginCodeRejection(facts(), { code_verifier: VERIFIER, now: expiry })).toBe(
      "expired",
    );
  });

  test("a consumed code is a replay even with the right verifier", () => {
    expect(
      desktopLoginCodeRejection(facts({ consumed_at: NOW }), {
        code_verifier: VERIFIER,
        now: NOW,
      }),
    ).toBe("replayed");
  });

  test("another verifier is refused", () => {
    expect(desktopLoginCodeRejection(facts(), { code_verifier: OTHER_VERIFIER, now: NOW })).toBe(
      "invalid_verifier",
    );
    expect(desktopLoginCodeRejection(facts(), { code_verifier: CHALLENGE, now: NOW })).toBe(
      "invalid_verifier",
    );
  });

  test("a state that differs from the one the sign-in started with is refused", () => {
    expect(
      desktopLoginCodeRejection(facts(), {
        code_verifier: VERIFIER,
        state: "state-fedcba9876543210",
        now: NOW,
      }),
    ).toBe("state_mismatch");
  });
});

describe("desktop session exchange body", () => {
  const code = "c".repeat(43);

  test("takes the code, the verifier and optionally the state", () => {
    expect(DesktopSessionRequestSchema.safeParse({ code, code_verifier: VERIFIER }).success).toBe(
      true,
    );
    expect(
      DesktopSessionRequestSchema.safeParse({ code, code_verifier: VERIFIER, state: STATE })
        .success,
    ).toBe(true);
  });

  test("refuses a short verifier, a malformed code and unknown fields", () => {
    expect(DesktopSessionRequestSchema.safeParse({ code, code_verifier: "short" }).success).toBe(
      false,
    );
    expect(
      DesktopSessionRequestSchema.safeParse({ code: "nope", code_verifier: VERIFIER }).success,
    ).toBe(false);
    expect(
      DesktopSessionRequestSchema.safeParse({
        code,
        code_verifier: VERIFIER,
        installation_id: DEVICE_ID,
      }).success,
    ).toBe(false);
  });
});

describe("desktop sign-in rate limit", () => {
  test("refuses beyond the limit and recovers after the window", () => {
    const limiter = createDesktopLoginRateLimiter({ max: 2, windowMs: 60_000 });
    expect(limiter.take("ip", 0).allowed).toBe(true);
    expect(limiter.take("ip", 1_000).allowed).toBe(true);
    const refused = limiter.take("ip", 2_000);
    expect(refused.allowed).toBe(false);
    expect(refused.retry_after_seconds).toBe(58);
    expect(limiter.take("other", 2_000).allowed).toBe(true);
    expect(limiter.take("ip", 60_000).allowed).toBe(true);
  });
});

describe("desktop sign-in callback schemes", () => {
  const PRODUCTION = desktopLoginCallbacks({ production: true, dev_callback: false });
  const DEVELOPMENT = desktopLoginCallbacks({ production: false, dev_callback: false });

  test("production accepts only subkit://callback", () => {
    expect(PRODUCTION).toEqual(["subkit://callback"]);
    expect(desktopLoginCallbackFor(undefined, PRODUCTION)).toBe("subkit://callback");
    expect(desktopLoginCallbackFor("subkit://callback", PRODUCTION)).toBe("subkit://callback");
    expect(desktopLoginCallbackFor("subkit-dev://callback", PRODUCTION)).toBeNull();
  });

  test("the development scheme is accepted outside production or with the explicit setting", () => {
    expect(DEVELOPMENT).toEqual(["subkit://callback", "subkit-dev://callback"]);
    expect(desktopLoginCallbacks({ production: true, dev_callback: true })).toEqual(DEVELOPMENT);
    expect(desktopLoginCallbackFor("subkit-dev://callback", DEVELOPMENT)).toBe(
      "subkit-dev://callback",
    );
    expect(desktopLoginCallbackFor(undefined, DEVELOPMENT)).toBe("subkit://callback");
  });

  test("no other scheme, host, path or web address is ever a target", () => {
    for (const candidate of [
      "subkit-dev://callback/",
      "subkit-dev://callback?x=1",
      "subkit-dev://open",
      "subkit-development://callback",
      "SUBKIT://callback",
      "subkit://callback.evil.example",
      "https://evil.example/callback",
      "javascript:alert(1)",
      "",
    ])
      expect(desktopLoginCallbackFor(candidate, DEVELOPMENT)).toBeNull();
  });

  test("the start query names a known scheme or none", () => {
    const base = {
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      state: "state-0123456789abcdef",
      device_id: "0b0e9c1c-3f4f-4a59-9a3e-2f6f0a4f4a11",
      device_label: "Laptop",
    };
    for (const redirect_uri of ["subkit://callback", "subkit-dev://callback"])
      expect(DesktopLoginStartQuerySchema.safeParse({ ...base, redirect_uri }).success).toBe(true);
    for (const redirect_uri of ["subkit-dev://open", "https://evil.example/callback", ""])
      expect(DesktopLoginStartQuerySchema.safeParse({ ...base, redirect_uri }).success).toBe(false);
  });

  test("the redirect carries the code to the scheme the sign-in started with", () => {
    const url = desktopLoginCallbackUrl(
      { code: "abc_DEF-123", state: "s" },
      "subkit-dev://callback",
    );
    expect(url).toBe("subkit-dev://callback?code=abc_DEF-123&state=s");
    expect(isDesktopLoginCallbackUrl(url, DEVELOPMENT)).toBe(true);
    expect(isDesktopLoginCallbackUrl(url, PRODUCTION)).toBe(false);
    expect(isDesktopLoginCallbackUrl(url)).toBe(false);
    expect(isDesktopLoginCallbackUrl("subkit-dev://callback.evil?code=1", DEVELOPMENT)).toBe(false);
    expect(isDesktopLoginCallbackUrl("subkit-dev://callback/x?code=1", DEVELOPMENT)).toBe(false);
    expect(isDesktopLoginCallbackUrl("subkit-dev://user@callback?code=1", DEVELOPMENT)).toBe(false);
  });

  test("the signed request keeps the development scheme and drops anything else", async () => {
    const request = {
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      state: "state-0123456789abcdef",
      device_id: "0b0e9c1c-3f4f-4a59-9a3e-2f6f0a4f4a11",
      device_label: "Laptop",
    };
    const dev = await signDesktopLoginRequest({
      ...request,
      redirect_uri: "subkit-dev://callback",
    });
    expect((await verifyDesktopLoginRequest(dev))?.redirect_uri).toBe("subkit-dev://callback");
    const foreign = await signDesktopLoginRequest({
      ...request,
      redirect_uri: "https://evil.example/callback",
    });
    expect(await verifyDesktopLoginRequest(foreign)).toBeNull();
    expect(
      (await verifyDesktopLoginRequest(await signDesktopLoginRequest(request)))?.redirect_uri,
    ).toBeUndefined();
  });
});

describe("desktop app minimum version", () => {
  test("accepts the minimum and anything newer", () => {
    for (const version of ["0.1.0", "0.1.1", "0.2.0", "1.0.0", "11.1.0", "0.1.1-beta.2"])
      expect(desktopAppVersionAccepted(version, "0.1.0")).toBe(true);
  });

  test("refuses older versions, pre-releases of the minimum, unreadable and missing versions", () => {
    for (const version of ["0.0.9", "0.1.0-beta.1", "abc", "1.2", "", undefined])
      expect(desktopAppVersionAccepted(version, "0.1.0")).toBe(false);
    expect(desktopAppVersionAccepted("1.9.9", "2.0.0")).toBe(false);
    expect(desktopAppVersionAccepted("2.0.0", "10.0.0")).toBe(false);
  });

  test("the start parameters and the exchange body carry the version", () => {
    expect(
      DesktopSessionRequestSchema.safeParse({
        code: "c".repeat(43),
        code_verifier: VERIFIER,
        app_version: "0.1.0",
      }).success,
    ).toBe(true);
    expect(
      DesktopSessionRequestSchema.safeParse({
        code: "c".repeat(43),
        code_verifier: VERIFIER,
        app_version: "latest",
      }).success,
    ).toBe(false);
  });
});
