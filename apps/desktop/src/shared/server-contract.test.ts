import { describe, expect, test } from "bun:test";
import {
  acceptsCallback,
  apiBase,
  apiUrl,
  attentionHint,
  classifyAuthFailure,
  classifyExchangeFailure,
  DEFAULT_LOGIN_PATHS,
  DELIVERY_MEMORY_MS,
  deliveryHint,
  deliveryNow,
  deviceLabel,
  helloHeartbeat,
  idleTimeoutFor,
  loginStartUrl,
  MIN_SERVER_VERSION,
  NO_DELIVERY_MEMORY,
  parseDescriptor,
  parseDesktopSession,
  rememberDelivery,
  sessionEnded,
  streamReaction,
} from "./server-contract.ts";

describe("parseDescriptor", () => {
  const login = {
    start: "/v1/identity/desktop-login/start",
    session: "/v1/identity/desktop-session",
    callback: "subkit://callback",
    code_challenge_methods: ["S256"],
  };

  test("reads version, minimum app version and the sign-in block of the server", () => {
    expect(
      parseDescriptor({
        service: "subkit",
        version: "11.2.0",
        clients: { desktop: { min_version: "0.1.0", login } },
      }),
    ).toEqual({
      version: "11.2.0",
      desktop: {
        minVersion: "0.1.0",
        login: DEFAULT_LOGIN_PATHS,
        loginSupported: true,
        callbacks: ["subkit://callback"],
        feedbackPath: null,
        anonymousFeedbackPath: null,
      },
    });
  });

  test("refuses a sign-in the app cannot complete", () => {
    const supported = (patch: Record<string, unknown>, callback = "subkit://callback") =>
      acceptsCallback(
        parseDescriptor({
          version: "11.2.0",
          clients: { desktop: { login: { ...login, ...patch } } },
        })?.desktop ?? null,
        callback,
      );
    expect(supported({})).toBe(true);
    expect(supported({ code_challenge_methods: ["S512"] })).toBe(false);
    expect(supported({ code_challenge_methods: "S256" })).toBe(false);
    expect(supported({ callback: "https://evil.test/callback" })).toBe(false);
    expect(supported({ callback: 7 })).toBe(false);
  });

  test("a development build signs in only where the server lists its scheme", () => {
    const dev = "subkit-dev://callback";
    const supported = (patch: Record<string, unknown>, callback: string) =>
      acceptsCallback(
        parseDescriptor({
          version: "11.2.0",
          clients: { desktop: { login: { ...login, ...patch } } },
        })?.desktop ?? null,
        callback,
      );
    expect(supported({}, dev)).toBe(false);
    expect(supported({ callbacks: ["subkit://callback"] }, dev)).toBe(false);
    expect(supported({ callbacks: ["subkit://callback", dev] }, dev)).toBe(true);
    expect(supported({ callbacks: ["subkit://callback", dev] }, "subkit://callback")).toBe(true);
    expect(supported({ callbacks: [dev, 4, null] }, "subkit://callback")).toBe(false);
    expect(acceptsCallback(null, dev)).toBe(false);
  });

  test("marks a server without the desktop block and falls back on unsafe paths", () => {
    expect(parseDescriptor({ version: "11.0.0" })).toEqual({ version: "11.0.0", desktop: null });
    expect(
      parseDescriptor({
        version: "11.2.0",
        clients: {
          desktop: {
            login: { start: "https://evil.test/start", session: "//evil.test" },
            feedback_path: "/feedback",
            anonymous_feedback_path: "/v1/feedback/anonymous",
          },
        },
      })?.desktop,
    ).toEqual({
      minVersion: null,
      login: DEFAULT_LOGIN_PATHS,
      loginSupported: true,
      callbacks: ["subkit://callback"],
      feedbackPath: "/feedback",
      anonymousFeedbackPath: "/v1/feedback/anonymous",
    });
    expect(
      parseDescriptor({
        version: "12.0.0",
        clients: { desktop: { login, anonymous_feedback_path: "https://evil.test/collect" } },
      })?.desktop?.anonymousFeedbackPath,
    ).toBeNull();
    expect(parseDescriptor({ service: "other" })).toBeNull();
    expect(parseDescriptor("<html>")).toBeNull();
  });

  test("requires the first server release with the local capabilities", () => {
    expect(MIN_SERVER_VERSION).toBe("12.1.0");
  });
});

describe("login", () => {
  test("builds the start URL with the PKCE challenge, state and device", () => {
    const url = new URL(
      loginStartUrl("https://subkit.example.com", DEFAULT_LOGIN_PATHS, {
        challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        state: "state-1234567890",
        deviceId: "0b0e6a52-6d0c-4c58-9f0e-3a4a52a3a001",
        deviceLabel: "Mikes MacBook Pro",
        callback: "subkit-dev://callback",
        appVersion: "v0.4.1+build.7",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://subkit.example.com/v1/identity/desktop-login/start",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      state: "state-1234567890",
      device_id: "0b0e6a52-6d0c-4c58-9f0e-3a4a52a3a001",
      device_label: "Mikes MacBook Pro",
      redirect_uri: "subkit-dev://callback",
      app_version: "0.4.1",
    });
  });

  test("cleans the device label to what the server accepts", () => {
    expect(deviceLabel("  host\u0007name\u0085  ")).toBe("hostname");
    expect(deviceLabel("")).toBe("SubKit Desktop");
    expect(deviceLabel("\u0000 \u001f")).toBe("SubKit Desktop");
    expect(deviceLabel("x".repeat(200))).toHaveLength(64);
    expect(deviceLabel(`${"x".repeat(63)} y`)).toBe("x".repeat(63));
  });

  test("reads the session answer and refuses foreign cockpit paths", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    expect(
      parseDesktopSession({
        installation_id: id,
        cockpit_path: `/cockpit/i/${id}/`,
        created: true,
      }),
    ).toEqual({ installationId: id, cockpitPath: `/cockpit/i/${id}/` });
    expect(parseDesktopSession({ installation_id: id, start_url: `/cockpit/i/${id}/` })).toBeNull();
    expect(
      parseDesktopSession({ installation_id: id, cockpit_path: "https://evil.test/" }),
    ).toBeNull();
    expect(parseDesktopSession({ installation_id: id, cockpit_path: "/cockpit" })).toBeNull();
    expect(
      parseDesktopSession({
        installation_id: id,
        cockpit_path: "/cockpit/i/99999999-2222-3333-4444-555555555555/",
      }),
    ).toBeNull();
    expect(parseDesktopSession({ installation_id: "../x", cockpit_path: "/cockpit" })).toBeNull();
    expect(parseDesktopSession({ cockpit_path: "/cockpit" })).toBeNull();
  });

  test("classifies a failed exchange by the answers of the server", () => {
    expect(classifyExchangeFailure(401)).toBe("expired");
    expect(classifyExchangeFailure(400)).toBe("rejected");
    expect(classifyExchangeFailure(403)).toBe("rejected");
    expect(classifyExchangeFailure(426)).toBe("outdated");
    expect(classifyExchangeFailure(429)).toBe("unreachable");
    expect(classifyExchangeFailure(500)).toBe("unreachable");
  });
});

describe("api addressing", () => {
  test("routes through the installation prefix so the scoped cookie is sent", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    expect(apiBase(`/cockpit/i/${id}/`)).toBe(`/cockpit/i/${id}/api`);
    expect(apiBase("/cockpit")).toBe("");
    expect(apiBase(null)).toBe("");
    expect(apiUrl("https://s.example.com", `/cockpit/i/${id}/`, "/v1/attention")).toBe(
      `https://s.example.com/cockpit/i/${id}/api/v1/attention`,
    );
    expect(apiUrl("https://s.example.com", "/cockpit", "/v1/attention")).toBe(
      "https://s.example.com/v1/attention",
    );
  });
});

describe("auth failures", () => {
  test("tells an expired session from a revoked device", () => {
    expect(classifyAuthFailure(401, { code: "installation_session_required" })).toBe("expired");
    expect(classifyAuthFailure(401, { code: "unauthorized" })).toBe("expired");
    expect(classifyAuthFailure(401, null)).toBe("expired");
    expect(classifyAuthFailure(403, { code: "installation_revoked" })).toBe("revoked");
    expect(classifyAuthFailure(401, { code: "installation_revoked" })).toBe("expired");
    expect(classifyAuthFailure(403, { code: "installation_tenant_fixed" })).toBeNull();
    expect(classifyAuthFailure(403, { code: "tenant_unavailable" })).toBeNull();
    expect(classifyAuthFailure(404, { code: "installation_not_found" })).toBeNull();
    expect(classifyAuthFailure(410, null)).toBeNull();
    expect(classifyAuthFailure(500, null)).toBeNull();
  });
});

describe("attentionHint", () => {
  test("reads the attention item id the stream event names", () => {
    expect(attentionHint('{"connector_id":"42","attention_id":"connector:42"}')).toBe(
      "connector:42",
    );
    expect(attentionHint('{"id":"task:1"}')).toBeNull();
    expect(attentionHint('{"workflow_id":"42"}')).toBeNull();
    expect(attentionHint('{"attention_id":7}')).toBeNull();
    expect(attentionHint("not json")).toBeNull();
    expect(attentionHint("[]")).toBeNull();
  });
});

describe("streamReaction", () => {
  test("announces on every event type of the server and only syncs on hello", () => {
    expect(streamReaction("ping")).toBe("ignore");
    expect(streamReaction("hello")).toBe("sync");
    expect(streamReaction("connector.auth_failed")).toBe("announce");
    expect(streamReaction("workflow.automation_changed")).toBe("announce");
    expect(streamReaction("notification.emitted")).toBe("announce");
    expect(streamReaction("session.ended")).toBe("session");
    expect(streamReaction("server.shutdown")).toBe("shutdown");
  });
});

describe("sessionEnded", () => {
  test("a revoked installation is told apart from an expired session", () => {
    expect(sessionEnded('{"status":403,"code":"installation_revoked"}')).toBe("revoked");
    expect(sessionEnded('{"status":401,"code":"installation_session_required"}')).toBe("expired");
  });

  test("anything unreadable counts as expired, never as revoked", () => {
    expect(sessionEnded("")).toBe("expired");
    expect(sessionEnded("[]")).toBe("expired");
    expect(sessionEnded('{"status":403,"code":"forbidden"}')).toBe("expired");
    expect(sessionEnded('{"code":"installation_revoked"}')).toBe("expired");
  });
});

describe("helloHeartbeat", () => {
  test("reads the heartbeat the server announces", () => {
    expect(helloHeartbeat('{"cursor":4,"heartbeat_ms":25000}')).toBe(25_000);
    expect(idleTimeoutFor(10_000)).toBe(30_000);
  });

  test("falls back to the default for a missing or absurd value", () => {
    expect(helloHeartbeat('{"cursor":4}')).toBeNull();
    expect(helloHeartbeat('{"heartbeat_ms":5}')).toBeNull();
    expect(helloHeartbeat('{"heartbeat_ms":"25000"}')).toBeNull();
    expect(helloHeartbeat("nope")).toBeNull();
    expect(idleTimeoutFor(null)).toBe(75_000);
  });
});

describe("delivery under the person's notification schedule", () => {
  test("reads the mark of a frame and ignores anything else", () => {
    expect(deliveryHint('{"attention_id":"workflow:1","delivery":"held"}')).toBe("held");
    expect(deliveryHint('{"delivery":"critical_only"}')).toBe("critical_only");
    expect(deliveryHint('{"delivery":"now"}')).toBeNull();
    expect(deliveryHint("{}")).toBeNull();
    expect(deliveryHint("not json")).toBeNull();
  });

  test("hello and heartbeat frames state it, marked frames set it, other frames leave it", () => {
    let memory = rememberDelivery(NO_DELIVERY_MEMORY, "hello", '{"delivery":"held"}', 1_000);
    expect(deliveryNow(memory, 1_000)).toBe("held");
    memory = rememberDelivery(memory, "execution.started", "{}", 2_000);
    expect(deliveryNow(memory, 2_000)).toBe("held");
    memory = rememberDelivery(
      memory,
      "connector.auth_failed",
      '{"delivery":"critical_only"}',
      3_000,
    );
    expect(deliveryNow(memory, 3_000)).toBe("critical_only");
    memory = rememberDelivery(memory, "ping", "{}", 4_000);
    expect(deliveryNow(memory, 4_000)).toBeNull();
  });

  test("a mark that no frame confirmed for 90 seconds no longer holds anything back", () => {
    const memory = rememberDelivery(NO_DELIVERY_MEMORY, "ping", '{"delivery":"held"}', 10_000);
    expect(deliveryNow(memory, 10_000 + DELIVERY_MEMORY_MS)).toBe("held");
    expect(deliveryNow(memory, 10_001 + DELIVERY_MEMORY_MS)).toBeNull();
  });
});
