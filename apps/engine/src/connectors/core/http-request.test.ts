import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { DecryptedCredential } from "../../credentials/types.ts";
import type { ConnectorView } from "../types.ts";
import {
  applyAuthMaterial,
  canSignalApiDisabled,
  carriesRequestBody,
  deriveAppliedAuthMethod,
  detectErrorReasonBody,
  dropContentTypeHeaders,
  effectiveDispatchPolicy,
  isAuthorityRedirect,
  isSuccessStatus,
  mergeProbeHeaders,
  outboundHeaderViolation,
  planInlineBody,
  probeStatusCode,
  probeTarget,
  probeVerdict,
  resolveRespectRobots,
  resolveSigV4Target,
  shadowedProbeHeader,
  unverifiedProbeWarning,
} from "./http-request.ts";

const FC = { seed: 20261106, numRuns: 200 } as const;

function connector(config: Record<string, unknown> | null = {}): ConnectorView {
  return { id: "c-1", config } as unknown as ConnectorView;
}

function cred(value: Record<string, unknown>): DecryptedCredential {
  return value as unknown as DecryptedCredential;
}

function applied(credential: DecryptedCredential | null, config: Record<string, unknown> = {}) {
  const headers: Record<string, string> = {};
  const query: Record<string, string | number | boolean> = {};
  applyAuthMaterial(connector(config), credential, headers, query);
  return { headers, query };
}

const statusArb = fc.integer({ min: 100, max: 599 });

describe("outboundHeaderViolation", () => {
  test("accepts a record of token names with string values", () => {
    expect(outboundHeaderViolation({ "X-Id": "1", "a!#$%&'*+-.^_`|~9": "v" })).toBeNull();
    expect(outboundHeaderViolation({})).toBeNull();
  });

  test("rejects non-records with the received kind", () => {
    expect(outboundHeaderViolation(null)).toEqual({
      message: "headers must be a {string: string} record, got object",
      field: "headers",
    });
    expect(outboundHeaderViolation(["a"])).toEqual({
      message: "headers must be a {string: string} record, got array",
      field: "headers",
    });
    expect(outboundHeaderViolation("x")).toEqual({
      message: "headers must be a {string: string} record, got string",
      field: "headers",
    });
  });

  test("rejects a name that is not an RFC 7230 token", () => {
    expect(outboundHeaderViolation({ "bad name": "v" })).toEqual({
      message: `header name "bad name" is not an RFC 7230 token — fix the workflow's headers field`,
      field: "headers.bad name",
    });
    expect(outboundHeaderViolation({ "x:y": "v" })?.field).toBe("headers.x:y");
    expect(outboundHeaderViolation({ "": "v" })?.field).toBe("headers.");
    expect(outboundHeaderViolation({ "a b": "v" })?.field).toBe("headers.a b");
    expect(outboundHeaderViolation({ ab: "v", "c d": "v" })?.field).toBe("headers.c d");
  });

  test("rejects a non-string value", () => {
    expect(outboundHeaderViolation({ ok: "v", n: 1 })).toEqual({
      message: `header "n" must be a string, got number`,
      field: "headers.n",
    });
  });

  test("any non-token character in a name is a violation", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 8 }),
        fc.constantFrom(" ", ":", "(", "\n", "é"),
        (prefix, bad) => {
          const name = `${prefix}${bad}`;
          expect(outboundHeaderViolation({ [name]: "v" })?.field).toBe(`headers.${name}`);
        },
      ),
      FC,
    );
  });
});

describe("applyAuthMaterial", () => {
  test("static headers and query from config apply before the credential", () => {
    const out = applied(cred({ mode: "bearer", token: "t" }), {
      static_headers: { Authorization: "static", "X-A": "a" },
      static_query: { q: "1" },
    });
    expect(out).toEqual({ headers: { Authorization: "Bearer t", "X-A": "a" }, query: { q: "1" } });
  });

  test("null connector config and null credential leave everything empty", () => {
    const headers: Record<string, string> = {};
    const query: Record<string, string | number | boolean> = {};
    applyAuthMaterial(connector(null), null, headers, query);
    expect({ headers, query }).toEqual({ headers: {}, query: {} });
    expect(applied(null, { static_headers: { a: "b" } })).toEqual({
      headers: { a: "b" },
      query: {},
    });
  });

  test("none, aws_sigv4 and signed_jwt add nothing", () => {
    for (const mode of ["none", "aws_sigv4", "signed_jwt", "unknown"]) {
      expect(applied(cred({ mode }))).toEqual({ headers: {}, query: {} });
    }
  });

  test("header and query modes copy their entries", () => {
    expect(applied(cred({ mode: "header", headers: { "X-Key": "k", B: "b" } }))).toEqual({
      headers: { "X-Key": "k", B: "b" },
      query: {},
    });
    expect(applied(cred({ mode: "query", query: { key: "k", z: "y" } }))).toEqual({
      headers: {},
      query: { key: "k", z: "y" },
    });
  });

  test("basic encodes user and password as utf8 base64", () => {
    expect(applied(cred({ mode: "basic", username: "ü", password: "p:w" })).headers).toEqual({
      Authorization: `Basic ${Buffer.from("ü:p:w", "utf8").toString("base64")}`,
    });
  });

  test("oauth2 maps token_type to the authorization scheme", () => {
    const auth = (token_type: unknown, access_token: unknown = "tok") =>
      applied(cred({ mode: "oauth2", access_token, token_type })).headers.Authorization;
    expect(auth(undefined)).toBe("tok");
    expect(auth("  ")).toBe("tok");
    expect(auth("none")).toBe("tok");
    expect(auth("NO_PREFIX")).toBe("tok");
    expect(auth("xnone")).toBe("xnone tok");
    expect(auth("nonex")).toBe("nonex tok");
    expect(auth(" bearer ")).toBe("Bearer tok");
    expect(auth("BEARER")).toBe("Bearer tok");
    expect(auth("MAC")).toBe("MAC tok");
    expect(auth("Bearer", "")).toBeUndefined();
  });

  test("token_mint fills every placeholder of the template", () => {
    const auth = (header_template: unknown, access_token: unknown = "tok") =>
      applied(cred({ mode: "token_mint", access_token, header_template })).headers.Authorization;
    expect(auth(undefined)).toBe("Bearer tok");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder under test
    expect(auth("Token ${token}|${token}")).toBe("Token tok|tok");
    expect(auth(undefined, "")).toBeUndefined();
  });

  test("oauth2_client and oauth2_private_key are refused", () => {
    expect(() => applied(cred({ mode: "oauth2_client" }))).toThrow(
      "oauth2_client credentials are not directly applied to HTTP requests — they identify the registered OAuth2 client and are consumed by the token endpoint flow.",
    );
    expect(() => applied(cred({ mode: "oauth2_private_key" }))).toThrow(
      "oauth2_private_key credentials are not directly applied to HTTP requests — they are consumed by the MCP client pool's PrivateKeyJwtProvider.",
    );
  });

  test("a bearer credential always wins over a static Authorization header", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (token, stat) => {
        const out = applied(cred({ mode: "bearer", token }), {
          static_headers: { Authorization: stat },
        });
        expect(out.headers.Authorization).toBe(`Bearer ${token}`);
      }),
      FC,
    );
  });
});

describe("deriveAppliedAuthMethod", () => {
  test("maps every mode", () => {
    const m = (mode: string, refreshed = false) =>
      deriveAppliedAuthMethod(cred({ mode }), refreshed);
    expect(deriveAppliedAuthMethod(null, true)).toBe("none");
    expect(m("none")).toBe("none");
    expect(m("bearer")).toBe("bearer");
    expect(m("header")).toBe("header");
    expect(m("query")).toBe("query");
    expect(m("basic")).toBe("basic");
    expect(m("oauth2")).toBe("oauth2_static");
    expect(m("oauth2", true)).toBe("oauth2_refreshed");
    expect(m("aws_sigv4")).toBe("aws_sigv4");
    expect(m("token_mint")).toBe("token_mint_static");
    expect(m("token_mint", true)).toBe("token_mint_refreshed");
    expect(m("oauth2_client")).toBe("none");
    expect(m("oauth2_private_key")).toBe("none");
    expect(m("signed_jwt")).toBe("signed_jwt");
  });
});

describe("resolveRespectRobots", () => {
  test("a boolean connector setting wins over the tenant default", () => {
    fc.assert(
      fc.property(fc.anything(), fc.boolean(), (configured, fallback) => {
        expect(resolveRespectRobots(configured, fallback)).toBe(
          typeof configured === "boolean" ? configured : fallback,
        );
      }),
      FC,
    );
    expect(resolveRespectRobots(false, true)).toBe(false);
    expect(resolveRespectRobots("false", true)).toBe(true);
  });
});

describe("request body shaping", () => {
  test("only GET and HEAD carry no body", () => {
    expect(carriesRequestBody("GET")).toBe(false);
    expect(carriesRequestBody("HEAD")).toBe(false);
    expect(carriesRequestBody("POST")).toBe(true);
    expect(carriesRequestBody("get")).toBe(true);
  });

  test("dropContentTypeHeaders removes every casing and keeps the rest", () => {
    const headers: Record<string, string> = {
      "Content-Type": "a",
      "content-type": "b",
      "CONTENT-TYPE": "c",
      X: "x",
    };
    dropContentTypeHeaders(headers);
    expect(headers).toEqual({ X: "x" });
  });

  test("planInlineBody", () => {
    expect(planInlineBody("POST", undefined, {})).toBeNull();
    expect(planInlineBody("POST", null, {})).toBeNull();
    expect(planInlineBody("GET", "x", {})).toBeNull();
    expect(planInlineBody("HEAD", { a: 1 }, {})).toBeNull();
    expect(planInlineBody("POST", "raw", {})).toEqual({
      body: "raw",
      content_type: "application/json",
    });
    expect(planInlineBody("PUT", { a: 1 }, { "content-type": "text/plain" })).toEqual({
      body: '{"a":1}',
      content_type: null,
    });
    expect(planInlineBody("PUT", 0, { "Content-Type": "x" })).toEqual({
      body: "0",
      content_type: null,
    });
    expect(planInlineBody("PATCH", false, { "content-type": "" })?.content_type).toBe(
      "application/json",
    );
  });

  test("object bodies are serialized as JSON", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.integer()), (body) => {
        expect(planInlineBody("POST", body, {})?.body).toBe(JSON.stringify(body));
      }),
      FC,
    );
  });
});

describe("dispatch policy", () => {
  test("an explicit policy wins, signed_jwt defaults to manual redirects", () => {
    const explicit = { redirect: "manual" as const };
    expect(effectiveDispatchPolicy(explicit, true)).toBe(explicit);
    expect(effectiveDispatchPolicy(explicit, false)).toBe(explicit);
    expect(effectiveDispatchPolicy(undefined, true)).toEqual({ redirect: "manual" });
    expect(effectiveDispatchPolicy(undefined, false)).toBeUndefined();
  });

  test("isAuthorityRedirect needs a policy, a 3xx status and a location", () => {
    const policy = { redirect: "manual" as const };
    expect(isAuthorityRedirect(300, true, policy)).toBe(true);
    expect(isAuthorityRedirect(399, true, policy)).toBe(true);
    expect(isAuthorityRedirect(299, true, policy)).toBe(false);
    expect(isAuthorityRedirect(400, true, policy)).toBe(false);
    expect(isAuthorityRedirect(302, false, policy)).toBe(false);
    expect(isAuthorityRedirect(302, true, undefined)).toBe(false);
    fc.assert(
      fc.property(statusArb, fc.boolean(), (status, loc) => {
        expect(isAuthorityRedirect(status, loc, policy)).toBe(
          loc && Math.floor(status / 100) === 3,
        );
      }),
      FC,
    );
  });

  test("isSuccessStatus covers exactly 2xx", () => {
    expect(isSuccessStatus(199)).toBe(false);
    expect(isSuccessStatus(200)).toBe(true);
    expect(isSuccessStatus(299)).toBe(true);
    expect(isSuccessStatus(300)).toBe(false);
  });
});

describe("resolveSigV4Target", () => {
  test("defaults the region and requires a service", () => {
    expect(resolveSigV4Target({ aws_service: "s3" }, "c")).toEqual({
      region: "us-east-1",
      service: "s3",
    });
    expect(resolveSigV4Target({ aws_region: "eu-west-1", aws_service: "sqs" }, "c")).toEqual({
      region: "eu-west-1",
      service: "sqs",
    });
    expect(resolveSigV4Target({ aws_region: 5, aws_service: "s3" }, "c").region).toBe("us-east-1");
    expect(() => resolveSigV4Target(null, "c-9")).toThrow(
      "aws_sigv4 connector c-9 missing required config.aws_service",
    );
    expect(() => resolveSigV4Target({ aws_service: "" }, "c")).toThrow("config.aws_service");
    expect(() => resolveSigV4Target({ aws_service: 1 }, "c")).toThrow("config.aws_service");
  });
});

describe("detectErrorReasonBody", () => {
  const body = (errors: unknown, message?: unknown) => ({ error: { errors, message } });

  test("non-matching shapes", () => {
    expect(detectErrorReasonBody(null, "r")).toEqual({ matched: false });
    expect(detectErrorReasonBody("x", "r")).toEqual({ matched: false });
    expect(detectErrorReasonBody({ error: null }, "r")).toEqual({ matched: false });
    expect(detectErrorReasonBody({ error: "x" }, "r")).toEqual({ matched: false });
    expect(detectErrorReasonBody(body({ reason: "r" }), "r")).toEqual({ matched: false });
    expect(detectErrorReasonBody(body([null, "r", { reason: "other" }]), "r")).toEqual({
      matched: false,
    });
  });

  test("only plain objects and strings take part in the match", () => {
    const fnWith = <T extends object>(props: T) => Object.assign(() => undefined, props);
    expect(detectErrorReasonBody(fnWith({ error: { errors: [{ reason: "r" }] } }), "r")).toEqual({
      matched: false,
    });
    expect(detectErrorReasonBody({ error: fnWith({ errors: [{ reason: "r" }] }) }, "r")).toEqual({
      matched: false,
    });
    expect(detectErrorReasonBody(body([fnWith({ reason: "r" })]), "r")).toEqual({
      matched: false,
    });
    expect(
      detectErrorReasonBody(body([{ reason: "r" }], { toString: () => "Drive API" }), "r"),
    ).toStrictEqual({ matched: true });
  });

  test("an unnamed match carries no api_name key", () => {
    expect(detectErrorReasonBody(body([{ reason: "r" }], "nothing"), "r")).toStrictEqual({
      matched: true,
    });
    expect(detectErrorReasonBody(body([{ reason: "r" }], "Drive  API"), "r")).toStrictEqual({
      matched: true,
      api_name: "Drive",
    });
  });

  test("matching reason with and without an API name", () => {
    expect(detectErrorReasonBody(body([{ reason: "r" }]), "r")).toEqual({ matched: true });
    expect(detectErrorReasonBody(body([{ reason: "r" }], 42), "r")).toEqual({ matched: true });
    expect(detectErrorReasonBody(body([{ reason: "r" }], "no api here"), "r")).toEqual({
      matched: true,
    });
    expect(
      detectErrorReasonBody(body([{}, { reason: "r" }], "Drive API has not been used"), "r"),
    ).toEqual({ matched: true, api_name: "Drive" });
    expect(detectErrorReasonBody(body([{ reason: "r" }], "xDrive API"), "r")).toEqual({
      matched: true,
    });
    expect(detectErrorReasonBody(body([{ reason: "r" }], "Big  Query API"), "r")).toEqual({
      matched: true,
      api_name: "Query",
    });
    expect(detectErrorReasonBody(body([{ reason: "r" }], "Sheets APIs"), "r")).toEqual({
      matched: true,
    });
    expect(detectErrorReasonBody(body([{ reason: "r" }], "SheetsAPI"), "r")).toEqual({
      matched: true,
    });
  });
});

describe("probe status", () => {
  test("canSignalApiDisabled", () => {
    expect([400, 403, 404].map(canSignalApiDisabled)).toEqual([true, true, true]);
    expect([401, 405, 500].map(canSignalApiDisabled)).toEqual([false, false, false]);
  });

  test("probeStatusCode", () => {
    expect(probeStatusCode(401)).toBe("credential_invalid");
    expect(probeStatusCode(403)).toBe("scope_insufficient");
    expect(probeStatusCode(404)).toBe("remote_resource_not_found");
    fc.assert(
      fc.property(statusArb, (status) => {
        fc.pre(![401, 403, 404].includes(status));
        expect(probeStatusCode(status)).toBe("unknown_upstream_error");
      }),
      FC,
    );
  });
});

describe("probe headers", () => {
  test("mergeProbeHeaders replaces inherited names case-insensitively", () => {
    const inherited = { Accept: "a", "X-Api": "1" };
    expect(mergeProbeHeaders(inherited, { accept: "b", New: "n" })).toEqual({
      "X-Api": "1",
      accept: "b",
      New: "n",
    });
    expect(mergeProbeHeaders(inherited, undefined)).toEqual(inherited);
    expect(mergeProbeHeaders(inherited, undefined)).not.toBe(inherited);
    expect(inherited).toEqual({ Accept: "a", "X-Api": "1" });
    expect(mergeProbeHeaders({ undefined: "keep" }, { Other: "o" })).toEqual({
      undefined: "keep",
      Other: "o",
    });
  });

  test("shadowedProbeHeader finds a header the credential supplies", () => {
    const header = cred({ mode: "header", headers: { "X-Key": "k" } });
    expect(shadowedProbeHeader({ "x-key": "v" }, header)).toBe("x-key");
    expect(shadowedProbeHeader({ A: "v", "X-KEY": "v" }, header)).toBe("X-KEY");
    expect(shadowedProbeHeader({ Other: "v" }, header)).toBeNull();
    expect(shadowedProbeHeader(undefined, header)).toBeNull();
    expect(shadowedProbeHeader({ "X-Key": "v" }, cred({ mode: "bearer", token: "t" }))).toBeNull();
    expect(shadowedProbeHeader({ "X-Key": "v" }, null)).toBeNull();
  });
});

describe("probeTarget", () => {
  test("defaults to GET /", () => {
    expect(probeTarget(null)).toEqual({ method: "GET", path_or_url: "/" });
    expect(probeTarget({ method: "POST", path: "" })).toEqual({ method: "POST", path_or_url: "/" });
    expect(probeTarget({ method: "HEAD", path: "/me" })).toEqual({
      method: "HEAD",
      path_or_url: "/me",
    });
  });
});

describe("probeVerdict", () => {
  test("a configured probe compares against the expected range", () => {
    const none = { warning_only: false, unverified_fallback: false, warnings: [] };
    expect(probeVerdict(200, [200, 299], true)).toEqual({ ok: true, ...none });
    expect(probeVerdict(299, [200, 299], true)).toEqual({ ok: true, ...none });
    expect(probeVerdict(199, [200, 299], true)).toEqual({ ok: false, ...none });
    expect(probeVerdict(300, [200, 299], true)).toEqual({ ok: false, ...none });
    expect(probeVerdict(404, [200, 299], true)).toEqual({ ok: false, ...none });
    expect(probeVerdict(401, [200, 299], true)).toEqual({ ok: false, ...none });
  });

  test("the fallback probe treats 404 and 405 as ambiguous success", () => {
    for (const status of [404, 405]) {
      expect(probeVerdict(status, null, true)).toEqual({
        ok: true,
        warning_only: true,
        unverified_fallback: false,
        warnings: [
          {
            code: "PROBE_AMBIGUOUS",
            message: `Fallback probe GET / returned ${status}; connectivity likely OK but endpoint unknown.`,
          },
        ],
      });
    }
  });

  test("the fallback probe marks auth failures unverified only with a credential", () => {
    for (const status of [401, 403]) {
      expect(probeVerdict(status, null, true)).toEqual({
        ok: false,
        warning_only: false,
        unverified_fallback: true,
        warnings: [],
      });
      expect(probeVerdict(status, null, false).unverified_fallback).toBe(false);
    }
  });

  test("the fallback probe accepts anything below 500 otherwise", () => {
    const none = { warning_only: false, unverified_fallback: false, warnings: [] };
    expect(probeVerdict(499, null, true)).toEqual({ ok: true, ...none });
    expect(probeVerdict(500, null, true)).toEqual({ ok: false, ...none });
    expect(probeVerdict(400, null, true)).toEqual({ ok: true, ...none });
    expect(probeVerdict(402, null, true)).toEqual({ ok: true, ...none });
    expect(probeVerdict(406, null, true)).toEqual({ ok: true, ...none });
  });

  test("a configured probe is ok exactly inside its range", () => {
    fc.assert(
      fc.property(statusArb, statusArb, statusArb, fc.boolean(), (a, b, status, has) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        expect(probeVerdict(status, [lo, hi], has).ok).toBe(status >= lo && status <= hi);
      }),
      FC,
    );
  });

  test("unverifiedProbeWarning names the status", () => {
    expect(unverifiedProbeWarning(403)).toEqual({
      code: "PROBE_AUTH_UNVERIFIED",
      message:
        "Fallback probe GET / returned 403: the root path requires sign-in, so the credential was not verified. Set config.probe_endpoint to a cheap authenticated read.",
    });
  });
});
