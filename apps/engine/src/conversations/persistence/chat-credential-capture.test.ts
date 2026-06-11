// Chat-paste credential capture (user decision): a secret pasted
// into chat is scrubbed from persistence AND captured into the draft
// credential cache so the agent probes instead of re-collecting.
//
// The append.ts integration path needs a database (getConversation /
// appendMessage), so per the testing plan the parse/capture decision is
// extracted into pure helpers and unit-tested here db-free:
//   - `extractChatPastedCredential` — key=value / bare-secret parsing
//     fed through the tolerant form-output extractor (aliases live on).
//   - `captureDraftCredentialFromChatText` — seed-mode resolution +
//     cache write (db-free for bearer/basic/header/query drafts).

import { afterEach, describe, expect, it } from "bun:test";
import type { Db } from "../../db/client.ts";
import { findSecretSpans } from "../../logging/scrub-secrets.ts";
import {
  captureDraftCredentialFromChatText,
  extractChatPastedCredential,
} from "./auto-persist/credential-cache.ts";
import {
  _resetDraftCredentialCacheForTests,
  getDraftCredential,
} from "./draft-credential-cache.ts";

const stubDb = {} as unknown as Db;

// Fixture secrets shaped to trip SECRET_PATTERNS without being real:
// ATATT… (Atlassian pat) and ghp_… (GitHub pat).
const FAKE_ATLASSIAN_TOKEN = "ATATTfake3xBfGH0aaaabbbbccccdddd1234";
const FAKE_GITHUB_TOKEN = "ghp_fakeFAKEfakeFAKEfakeFAKEfake123456";

afterEach(() => {
  _resetDraftCredentialCacheForTests();
});

describe("extractChatPastedCredential — pure parse/capture decision", () => {
  it("parses the session-97679846 paste shape `email=…, api_token=ATATT…` for a basic draft", () => {
    const text = `email=mike@example.com, api_token=${FAKE_ATLASSIAN_TOKEN}`;
    const out = extractChatPastedCredential("basic", {}, text, findSecretSpans(text));
    expect(out).toEqual({
      mode: "basic",
      username: "mike@example.com",
      password: FAKE_ATLASSIAN_TOKEN,
    });
  });

  it("parses `key: value` framing too", () => {
    const text = `username: alice\npassword: ${FAKE_GITHUB_TOKEN}`;
    const out = extractChatPastedCredential("basic", {}, text, findSecretSpans(text));
    expect(out).toEqual({ mode: "basic", username: "alice", password: FAKE_GITHUB_TOKEN });
  });

  it("maps a lone bare secret onto the bearer token slot", () => {
    const text = `here is my token ${FAKE_GITHUB_TOKEN}`;
    const out = extractChatPastedCredential("bearer", {}, text, findSecretSpans(text));
    expect(out).toEqual({ mode: "bearer", token: FAKE_GITHUB_TOKEN });
  });

  it("junk pair framing must not defeat the span overlay (live repro: 'my token again: <secret>')", () => {
    // v6.15.1, conversation 2f1f1463: "here is my token again: <secret>"
    // parsed into a junk `again` key, which suppressed the lone-bare-
    // secret fallback and fell through to scrub-only.
    const text = `here is my token again: ${FAKE_ATLASSIAN_TOKEN}`;
    const out = extractChatPastedCredential("bearer", {}, text, findSecretSpans(text));
    expect(out).toEqual({ mode: "bearer", token: FAKE_ATLASSIAN_TOKEN });
  });

  it("a pair that already fills the secret slot wins over the span overlay", () => {
    const text = `token: ${FAKE_GITHUB_TOKEN}`;
    const out = extractChatPastedCredential("bearer", {}, text, findSecretSpans(text));
    expect(out).toEqual({ mode: "bearer", token: FAKE_GITHUB_TOKEN });
  });

  it("maps a lone bare secret onto header_value when the draft is header-auth (seeded name)", () => {
    const text = FAKE_GITHUB_TOKEN;
    const out = extractChatPastedCredential(
      "header",
      { header_name: "X-API-Key" },
      text,
      findSecretSpans(text),
    );
    expect(out).toEqual({
      mode: "header",
      header_name: "X-API-Key",
      header_value: FAKE_GITHUB_TOKEN,
    });
  });

  it("returns null for a bare secret on a basic draft (two slots — no unambiguous mapping)", () => {
    const text = FAKE_ATLASSIAN_TOKEN;
    expect(extractChatPastedCredential("basic", {}, text, findSecretSpans(text))).toBeNull();
  });

  it("returns null when the pairs don't satisfy the mode (token only, basic draft)", () => {
    const text = `api_token=${FAKE_ATLASSIAN_TOKEN}`;
    // basic needs a username too — the pair parse finds api_token but
    // the extractor refuses an incomplete basic credential.
    expect(extractChatPastedCredential("basic", {}, text, findSecretSpans(text))).toBeNull();
  });
});

describe("captureDraftCredentialFromChatText — cache write", () => {
  it("caches a basic credential from the Atlassian paste shape on a basic draft", async () => {
    const conversation_id = "convo-chat-capture-basic";
    const res = await captureDraftCredentialFromChatText({
      tenant_id: "t-1",
      conversation_id,
      rawText: `email=mike@example.com, api_token=${FAKE_ATLASSIAN_TOKEN}`,
      connector: { auth_type: "basic" },
      db: stubDb,
    });
    expect(res).toEqual({ captured: true, mode: "basic" });
    expect(getDraftCredential(conversation_id)).toEqual({
      mode: "basic",
      username: "mike@example.com",
      password: FAKE_ATLASSIAN_TOKEN,
    });
  });

  it("caches a lone bare token as bearer on a bearer draft", async () => {
    const conversation_id = "convo-chat-capture-bearer";
    const res = await captureDraftCredentialFromChatText({
      tenant_id: "t-1",
      conversation_id,
      rawText: FAKE_GITHUB_TOKEN,
      connector: { auth_type: "bearer" },
      db: stubDb,
    });
    expect(res).toEqual({ captured: true, mode: "bearer" });
    expect(getDraftCredential(conversation_id)).toEqual({
      mode: "bearer",
      token: FAKE_GITHUB_TOKEN,
    });
  });

  it("captures nothing for an ambiguous paste (bare secret, basic draft)", async () => {
    const conversation_id = "convo-chat-capture-ambiguous";
    const res = await captureDraftCredentialFromChatText({
      tenant_id: "t-1",
      conversation_id,
      rawText: FAKE_ATLASSIAN_TOKEN,
      connector: { auth_type: "basic" },
      db: stubDb,
    });
    expect(res).toEqual({ captured: false });
    expect(getDraftCredential(conversation_id)).toBeNull();
  });

  it("captures nothing when the draft has no collectable seed mode", async () => {
    const conversation_id = "convo-chat-capture-none";
    const res = await captureDraftCredentialFromChatText({
      tenant_id: "t-1",
      conversation_id,
      rawText: FAKE_GITHUB_TOKEN,
      connector: { auth_type: "none" },
      db: stubDb,
    });
    expect(res).toEqual({ captured: false });
    expect(getDraftCredential(conversation_id)).toBeNull();
  });
});
