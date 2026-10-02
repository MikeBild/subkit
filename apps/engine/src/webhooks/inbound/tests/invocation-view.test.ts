import { describe, expect, test } from "bun:test";
import { describeInboundSigning } from "../invocation-view.ts";

describe("describeInboundSigning", () => {
  test("the fixed schemes name the headers their verifier reads", () => {
    expect(describeInboundSigning("standard", null)).toEqual({
      signed: true,
      headers: ["webhook-id", "webhook-timestamp", "webhook-signature"],
      hmac: null,
    });
    expect(describeInboundSigning("github", null).headers).toEqual([
      "x-hub-signature-256",
      "x-github-delivery",
      "x-github-event",
    ]);
    expect(describeInboundSigning("stripe", { source: "stripe" }).headers).toEqual([
      "stripe-signature",
    ]);
  });

  test("a generic scheme names the sender's own headers, lower-case", () => {
    expect(
      describeInboundSigning("hmac", {
        hmac: {
          signature_header: "X-Signature",
          id_header: "X-Delivery",
          timestamp_header: "X-Timestamp",
          type_header: "X-Event",
          signed_payload: "{timestamp}.{body}",
          encoding: "base64",
        },
      }),
    ).toEqual({
      signed: true,
      headers: ["x-signature", "x-delivery", "x-timestamp", "x-event"],
      hmac: {
        algorithm: "sha256",
        encoding: "base64",
        signed_payload: "{timestamp}.{body}",
        signature_prefix: "",
      },
    });
  });

  test("a generic scheme that does not parse invents no header names", () => {
    expect(describeInboundSigning("hmac", { hmac: { signature_header: "" } })).toEqual({
      signed: true,
      headers: [],
      hmac: null,
    });
    expect(describeInboundSigning("hmac", null).headers).toEqual([]);
  });

  test("a binding that skips verification is unsigned, whatever its verifier", () => {
    expect(describeInboundSigning("standard", { skip: true })).toEqual({
      signed: false,
      headers: [],
      hmac: null,
    });
  });

  test("an unknown verifier names no headers", () => {
    expect(describeInboundSigning("custom", null)).toEqual({
      signed: true,
      headers: [],
      hmac: null,
    });
  });
});
