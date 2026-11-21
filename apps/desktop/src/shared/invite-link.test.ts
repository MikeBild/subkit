import { describe, expect, test } from "bun:test";
import {
  invitePageUrl,
  invitePreviewBody,
  parseInviteLink,
  parseInvitePreview,
} from "./invite-link.ts";

const TOKEN = "wf_invite_Q2hhbmdlTWUxMjM0NTY3";

describe("invitation link", () => {
  test("reads the server and the token of an invitation page link", () => {
    expect(parseInviteLink(` https://subkit.example.com/cockpit/invite#${TOKEN} `)).toEqual({
      origin: "https://subkit.example.com",
      token: TOKEN,
    });
    expect(parseInviteLink(`http://localhost:3000/cockpit/invite/#${TOKEN}`)?.origin).toBe(
      "http://localhost:3000",
    );
  });

  test("refuses everything that is not exactly such a link", () => {
    for (const raw of [
      "",
      TOKEN,
      `subkit.example.com/cockpit/invite#${TOKEN}`,
      `http://subkit.example.com/cockpit/invite#${TOKEN}`,
      `https://user:pw@subkit.example.com/cockpit/invite#${TOKEN}`,
      `https://subkit.example.com/cockpit/invite?x=1#${TOKEN}`,
      `https://subkit.example.com/cockpit/other#${TOKEN}`,
      "https://subkit.example.com/cockpit/invite#wf_invite_short",
      "https://subkit.example.com/cockpit/invite#sk_live_abcdefghijk",
      `javascript://subkit.example.com/cockpit/invite#${TOKEN}`,
      `file:///cockpit/invite#${TOKEN}`,
    ]) {
      expect(parseInviteLink(raw)).toBeNull();
    }
  });

  test("the browser opens the same server's invitation page, the preview sends only the token", () => {
    const link = { origin: "https://subkit.example.com", token: TOKEN };
    expect(invitePageUrl(link)).toBe(`https://subkit.example.com/cockpit/invite#${TOKEN}`);
    expect(JSON.parse(invitePreviewBody(link))).toEqual({ token: TOKEN });
  });
});

describe("invitation preview", () => {
  const ORIGIN = "https://subkit.example.com";

  test("a valid invitation carries workspace, inviter, masked address and expiry", () => {
    expect(
      parseInvitePreview(
        200,
        {
          workspace_name: "Harmoniqs",
          invited_by_name: "Anna Schmidt",
          email_hint: "m•••@example.com",
          expires_at: "2026-11-27T12:00:00.000Z",
          providers: [],
        },
        ORIGIN,
      ),
    ).toEqual({
      status: "valid",
      origin: ORIGIN,
      workspace: "Harmoniqs",
      invitedBy: "Anna Schmidt",
      emailHint: "m•••@example.com",
      expiresAt: "2026-11-27T12:00:00.000Z",
    });
  });

  test("every refusal code of the server maps to one state", () => {
    const cases: [string, string][] = [
      ["invite_expired", "expired"],
      ["invite_revoked", "withdrawn"],
      ["invite_unavailable", "withdrawn"],
      ["invite_already_redeemed", "used"],
      ["invite_invalid", "invalid"],
      ["invite_credential_only", "invalid"],
      ["something_new", "invalid"],
    ];
    for (const [code, status] of cases) {
      expect(parseInvitePreview(400, { code }, ORIGIN)).toEqual({
        status,
        origin: ORIGIN,
      } as never);
    }
    expect(parseInvitePreview(429, null, ORIGIN).status).toBe("busy");
  });

  test("a broken answer is an invalid invitation, never a valid one", () => {
    expect(parseInvitePreview(200, null, ORIGIN).status).toBe("invalid");
    expect(parseInvitePreview(200, { workspace_name: "X", expires_at: "no" }, ORIGIN).status).toBe(
      "invalid",
    );
  });
});
