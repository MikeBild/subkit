import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Locale, messageKeys, t } from "../../shared/i18n.ts";
import type { InvitePreview } from "../../shared/invite-link.ts";
import { CLOSED_INVITE, inviteView, untilDate, welcomeInvite } from "./invite-model.ts";

const ORIGIN = "https://subkit.example.com";
const link = { origin: ORIGIN, token: "wf_invite_abcdefgh12345678" };
const valid: InvitePreview = {
  status: "valid",
  origin: ORIGIN,
  workspace: "Harmoniqs",
  invitedBy: "Anna Schmidt",
  emailHint: "m•••@example.com",
  expiresAt: "2026-11-27T12:00:00.000Z",
};

describe("invitation view", () => {
  test("a valid invitation names inviter, workspace, address and date, and can be joined", () => {
    expect(inviteView({ link, preview: valid }, "de")).toEqual({
      host: "subkit.example.com",
      valid: true,
      title: "invite.valid",
      body: "invite.valid.body",
      vars: { inviter: "Anna Schmidt", workspace: "Harmoniqs" },
      meta: { email: "m•••@example.com", until: "27.11.2026" },
    });
    expect(inviteView({ link, preview: valid }, "en").meta?.until).toBe("11/27/2026");
  });

  test("without an inviter the body does not name one", () => {
    const view = inviteView({ link, preview: { ...valid, invitedBy: null } }, "de");
    expect(view.body).toBe("invite.valid.anonymous");
  });

  test("a refused invitation cannot be joined and names the next step", () => {
    for (const status of ["expired", "withdrawn", "used", "invalid", "busy"] as const) {
      const view = inviteView({ link, preview: { status, origin: ORIGIN } }, "de");
      expect(view.valid).toBe(false);
      expect(view.meta).toBeNull();
      expect(messageKeys()).toContain(view.title);
      expect(messageKeys()).toContain(view.body);
    }
  });

  test("an invitation already used sends the person to sign in, the others ask for a new one", () => {
    const bodyOf = (status: "expired" | "withdrawn" | "used" | "invalid") =>
      inviteView({ link, preview: { status, origin: ORIGIN } }, "en").body;
    expect(bodyOf("used")).toBe("invite.signInInstead");
    expect(bodyOf("expired")).toBe("invite.askNew");
    expect(bodyOf("withdrawn")).toBe("invite.askNew");
    expect(bodyOf("invalid")).toBe("invite.askNew");
  });

  test("an unreadable date stays as it came", () => {
    expect(untilDate("soon", "de")).toBe("soon");
  });
});

describe("welcome invitation field", () => {
  test("closed and empty at first, busy while checking, with an error once refused", () => {
    expect(welcomeInvite(CLOSED_INVITE)).toEqual({
      open: false,
      link: "",
      checking: false,
      error: null,
    });
    expect(
      welcomeInvite({ ...CLOSED_INVITE, open: true, slot: { phase: "checking", requestId: 1 } })
        .checking,
    ).toBe(true);
    expect(welcomeInvite({ ...CLOSED_INVITE, slot: { phase: "invalid" } }).error).toBe(
      "welcome.invite.invalid",
    );
  });
});

describe("desktop guide on refused invitations", () => {
  const guideOf = (locale: Locale) =>
    readFileSync(
      join(import.meta.dir, `../../../../engine/src/http/reference/subkit-desktop.${locale}.md`),
      "utf8",
    );
  const rowsWith = (guide: string, text: string) =>
    guide.split("\n").filter((line) => line.startsWith("|") && line.includes(text));

  for (const locale of ["en", "de"] as const) {
    test(`${locale}: the same next step as the app for each refusal`, () => {
      const guide = guideOf(locale);
      for (const [title, body] of [
        ["invite.used", "invite.signInInstead"],
        ["invite.expired", "invite.askNew"],
      ] as const) {
        const rows = rowsWith(guide, t(locale, title));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toContain(t(locale, body));
      }
      expect(rowsWith(guide, t(locale, "invite.signInInstead"))).toHaveLength(1);
    });
  }
});
