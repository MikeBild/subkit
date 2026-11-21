import { describe, expect, test } from "bun:test";
import type { InviteDelivery } from "@/api/invite-send";
import { ApiError } from "@/api/transport";
import { sendOutcome, sendWaitMinutes } from "./invite-send-model";

const invite = {
  id: "00000000-0000-4000-8000-000000000001",
  expires_at: "2026-11-28T08:00:00.000Z",
} as Extract<InviteDelivery, { delivery: "sent" }>["invite"];

describe("sending an invitation", () => {
  test("without mail delivery the link dialog opens with the reason, nothing reads as sent", () => {
    const outcome = sendOutcome(
      {
        delivery: "copy_link",
        reason: "no_mail_transport",
        invite,
        plaintext_token: "tok",
        link_path: "/cockpit/invite#tok",
        url: null,
      },
      "anna@example.com",
    );
    expect(outcome).toEqual({
      kind: "link",
      invite: {
        email: "anna@example.com",
        token: "tok",
        expiresAt: "2026-11-28T08:00:00.000Z",
        url: null,
        note: "people.invite.note.no_mail_transport",
      },
    });
  });

  test("every copy_link reason has its own note and keeps the engine's full link", () => {
    for (const reason of ["mail_failed", "no_public_url"] as const) {
      const outcome = sendOutcome(
        {
          delivery: "copy_link",
          reason,
          invite,
          plaintext_token: "tok",
          link_path: "/cockpit/invite#tok",
          url: "https://subkit.example/cockpit/invite#tok",
        },
        "anna@example.com",
      );
      expect(outcome.kind === "link" && outcome.invite.note).toBe(`people.invite.note.${reason}`);
      expect(outcome.kind === "link" && outcome.invite.url).toBe(
        "https://subkit.example/cockpit/invite#tok",
      );
    }
  });

  test("a sent invitation names only the masked address", () => {
    expect(
      sendOutcome(
        { delivery: "sent", channel: "email", to: "a•••@example.com", invite },
        "anna@example.com",
      ),
    ).toEqual({ kind: "sent", to: "a•••@example.com" });
  });

  test("the rate limit says how many minutes to wait", () => {
    const limited = (seconds?: number) =>
      new ApiError(
        429,
        {
          code: "rate_limit_exceeded",
          details: seconds === undefined ? {} : { retry_after_seconds: seconds },
        },
        null,
      );
    expect(sendWaitMinutes(limited(125))).toBe(3);
    expect(sendWaitMinutes(limited(20))).toBe(1);
    expect(sendWaitMinutes(limited())).toBe(1);
    expect(sendWaitMinutes(new ApiError(409, { code: "not_invited" }, null))).toBeNull();
  });
});
