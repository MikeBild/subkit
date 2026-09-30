// Configurable HMAC verifier tests.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { handleInbound } from "../service.ts";
import { HmacVerifierConfig, verifyHmac } from "../verifiers/hmac.ts";
import { createInboundCtx, type InboundTestCtx } from "./setup.ts";

const SECRET = "hmac-secret-0123456789";
const NOW_S = 1_800_000_000;
const NOW_MS = NOW_S * 1000;

// A sender that signs "v1:<timestamp>:<body>" and sends "v1=<hex>".
const TIMESTAMPED = {
  signature_header: "X-Example-Signature",
  signature_prefix: "v1=",
  encoding: "hex",
  signed_payload: "v1:{timestamp}:{body}",
  timestamp_header: "X-Example-Timestamp",
  id_header: "X-Example-Message-Id",
  type_field: "eventType",
};

function sign(secret: string, base: string, encoding: "hex" | "base64" = "hex"): string {
  return createHmac("sha256", secret).update(base, "utf8").digest(encoding);
}

function timestampedHeaders(
  body: string,
  opts: { ts?: number; id?: string; secret?: string } = {},
) {
  const ts = String(opts.ts ?? NOW_S);
  return {
    "x-example-signature": `v1=${sign(opts.secret ?? SECRET, `v1:${ts}:${body}`)}`,
    "x-example-timestamp": ts,
    "x-example-message-id": opts.id ?? "msg_1",
  };
}

function verify(headers: Record<string, string>, rawBody: string, config: unknown = TIMESTAMPED) {
  return verifyHmac({ headers, rawBody, secret: SECRET, now: NOW_MS, config: { hmac: config } });
}

describe("hmac verifier: config", () => {
  test("lowercases header names and applies defaults", () => {
    const cfg = HmacVerifierConfig.parse({ signature_header: "X-Sig", id_header: "X-Id" });
    expect(cfg.signature_header).toBe("x-sig");
    expect(cfg.encoding).toBe("hex");
    expect(cfg.signed_payload).toBe("{body}");
    expect(cfg.tolerance_seconds).toBe(300);
  });

  test("requires {body} in the signed payload", () => {
    const r = HmacVerifierConfig.safeParse({
      signature_header: "x-sig",
      id_header: "x-id",
      signed_payload: "{id}",
    });
    expect(r.success).toBe(false);
  });

  test("rejects unknown placeholders", () => {
    const r = HmacVerifierConfig.safeParse({
      signature_header: "x-sig",
      id_header: "x-id",
      signed_payload: "{nonce}.{body}",
    });
    expect(r.success).toBe(false);
  });

  test("requires a timestamp header when the payload uses {timestamp}", () => {
    const r = HmacVerifierConfig.safeParse({
      signature_header: "x-sig",
      id_header: "x-id",
      signed_payload: "{timestamp}.{body}",
    });
    expect(r.success).toBe(false);
  });

  test("rejects unknown keys", () => {
    const r = HmacVerifierConfig.safeParse({ ...TIMESTAMPED, algo: "sha1" });
    expect(r.success).toBe(false);
  });

  test("a binding without a valid config denies instead of throwing", () => {
    const body = "{}";
    expect(verify(timestampedHeaders(body), body, null)).toEqual({
      ok: false,
      reason: "bad_hmac_config",
    });
  });
});

describe("hmac verifier: verification", () => {
  const body = JSON.stringify({ eventType: "thing.happened", n: 1 });

  test("accepts a correct timestamped signature", () => {
    const r = verify(timestampedHeaders(body), body);
    expect(r).toEqual({
      ok: true,
      normalized: { id: "msg_1", timestamp: NOW_S, type: "thing.happened" },
    });
  });

  test("signs the raw body byte for byte", () => {
    const spaced = '{ "eventType" : "thing.happened" }';
    expect(verify(timestampedHeaders(spaced), spaced).ok).toBe(true);
    expect(verify(timestampedHeaders(spaced), JSON.stringify(JSON.parse(spaced))).ok).toBe(false);
  });

  test("rejects a wrong secret", () => {
    const r = verify(timestampedHeaders(body, { secret: "other" }), body);
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("rejects a tampered body", () => {
    const r = verify(timestampedHeaders(body), `${body} `);
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("rejects a timestamp outside the window", () => {
    const r = verify(timestampedHeaders(body, { ts: NOW_S - 301 }), body);
    expect(r).toEqual({ ok: false, reason: "timestamp_outside_window" });
  });

  test("rejects a signature re-used with a different timestamp", () => {
    const headers = { ...timestampedHeaders(body), "x-example-timestamp": String(NOW_S + 1) };
    expect(verify(headers, body)).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("rejects missing signature or id headers", () => {
    const { "x-example-message-id": _id, ...noId } = timestampedHeaders(body);
    expect(verify(noId, body)).toEqual({ ok: false, reason: "missing_hmac_headers" });
    const { "x-example-signature": _sig, ...noSig } = timestampedHeaders(body);
    expect(verify(noSig, body)).toEqual({ ok: false, reason: "missing_hmac_headers" });
  });

  test("rejects a wrong prefix and malformed hex", () => {
    const headers = timestampedHeaders(body);
    const hex = headers["x-example-signature"].slice(3);
    expect(verify({ ...headers, "x-example-signature": `v2=${hex}` }, body).ok).toBe(false);
    // An invalid hex pair would make Buffer.from truncate silently.
    const broken = `v1=${hex.slice(0, 62)}zz`;
    expect(verify({ ...headers, "x-example-signature": broken }, body)).toEqual({
      ok: false,
      reason: "bad_hmac_signature_format",
    });
  });

  test("supports base64 digests over the body alone", () => {
    const cfg = { signature_header: "x-sig", id_header: "x-id", encoding: "base64" };
    const headers = { "x-sig": sign(SECRET, body, "base64"), "x-id": "d1" };
    const r = verify(headers, body, cfg);
    expect(r).toEqual({ ok: true, normalized: { id: "d1", timestamp: NOW_S, type: "unknown" } });
  });

  test("can include the delivery id in the signed payload", () => {
    const cfg = { signature_header: "x-sig", id_header: "x-id", signed_payload: "{id}.{body}" };
    const headers = { "x-sig": sign(SECRET, `d2.${body}`), "x-id": "d2" };
    expect(verify(headers, body, cfg).ok).toBe(true);
    expect(verify({ ...headers, "x-id": "d3" }, body, cfg).ok).toBe(false);
  });

  test("reads the event type from a header when configured", () => {
    const cfg = { ...TIMESTAMPED, type_field: undefined, type_header: "X-Example-Event" };
    const headers = { ...timestampedHeaders(body), "x-example-event": "from.header" };
    const r = verify(headers, body, cfg);
    expect(r.ok && r.normalized.type).toBe("from.header");
  });
});

describe("inbound: hmac verifier", () => {
  let ctx: InboundTestCtx;

  beforeAll(async () => {
    ctx = await createInboundCtx("hmac");
    await ctx.grantAuthority();
    await ctx.createBinding({
      slug: "hmac-events",
      verifier: "hmac",
      secret: SECRET,
      native_verifier_config: { hmac: HmacVerifierConfig.parse(TIMESTAMPED) },
    });
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  const body = JSON.stringify({ eventType: "thing.happened" });

  test("accepts a signed delivery and dedups its retry", async () => {
    const ts = NOW_S;
    const headers = timestampedHeaders(body, { ts, id: "msg_live" });
    const deps = { db: ctx.db, boss: ctx.boss };
    const first = await handleInbound(deps, {
      slug: "hmac-events",
      rawBody: body,
      headers,
      now: NOW_MS,
    });
    expect(first.status).toBe("ok");
    if (first.status !== "ok") throw new Error("expected ok");
    expect(first.normalized.id).toBe("msg_live");
    expect(first.normalized.type).toBe("thing.happened");

    const retry = await handleInbound(deps, {
      slug: "hmac-events",
      rawBody: body,
      headers,
      now: NOW_MS,
    });
    expect(retry.status).toBe("deduped");
  });

  test("denies a bad signature", async () => {
    const ts = NOW_S;
    const headers = timestampedHeaders(body, { ts, id: "msg_bad", secret: "wrong" });
    const outcome = await handleInbound(
      { db: ctx.db, boss: ctx.boss },
      { slug: "hmac-events", rawBody: body, headers, now: NOW_MS },
    );
    expect(outcome.status).toBe("denied");
    if (outcome.status !== "denied") throw new Error("expected denied");
    expect(outcome.reason).toBe("bad_signature");
  });
});
