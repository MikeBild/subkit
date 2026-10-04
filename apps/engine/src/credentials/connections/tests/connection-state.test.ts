import { describe, expect, test } from "bun:test";
import { refreshWasRefused } from "../oauth-client.ts";
import { connectionStateOf } from "../service.ts";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const past = new Date(NOW - 60_000);
const future = new Date(NOW + 60_000);

describe("connectionStateOf", () => {
  test("an unreadable token wins over everything and says so", () => {
    expect(
      connectionStateOf(
        {
          refresh_failed_at: past,
          expires_at: past,
          refresh_token_version: null,
          last_error: null,
        },
        false,
        NOW,
      ),
    ).toEqual({ state: "unreadable", state_reason: "secret_unreadable" });
  });

  test("a renewal the other side answered with an OAuth error was refused", () => {
    expect(
      connectionStateOf(
        {
          refresh_failed_at: past,
          expires_at: future,
          refresh_token_version: 2,
          last_error: "token endpoint refused: invalid_grant",
        },
        true,
        NOW,
      ),
    ).toEqual({ state: "expired", state_reason: "refresh_refused" });
  });

  test("a renewal that failed for any other reason is not called a refusal", () => {
    for (const last_error of [
      "token endpoint unreachable: The operation timed out.",
      "token endpoint refused: 503",
      "token endpoint answered without an access token",
      "connection changed during refresh",
      null,
    ]) {
      expect(refreshWasRefused(last_error)).toBe(false);
      expect(
        connectionStateOf(
          { refresh_failed_at: past, expires_at: future, refresh_token_version: 2, last_error },
          true,
          NOW,
        ).state_reason,
      ).toBe("refresh_failed");
    }
  });

  test("a grant past its end with no refresh token reads expired, because it cannot renew", () => {
    expect(
      connectionStateOf(
        {
          refresh_failed_at: null,
          expires_at: past,
          refresh_token_version: null,
          last_error: null,
        },
        true,
        NOW,
      ),
    ).toEqual({ state: "expired", state_reason: "expired_no_refresh" });
  });

  test("usable states carry no reason", () => {
    expect(
      connectionStateOf(
        {
          refresh_failed_at: null,
          expires_at: future,
          refresh_token_version: null,
          last_error: null,
        },
        true,
        NOW,
      ),
    ).toEqual({ state: "expiring", state_reason: null });
    expect(
      connectionStateOf(
        { refresh_failed_at: null, expires_at: past, refresh_token_version: 3, last_error: null },
        true,
        NOW,
      ),
    ).toEqual({ state: "valid", state_reason: null });
  });

  test("the reason is non-null exactly when the state is not usable", () => {
    for (const refresh_failed_at of [null, past]) {
      for (const expires_at of [null, past, future]) {
        for (const refresh_token_version of [null, 1]) {
          for (const readable of [true, false]) {
            const { state, state_reason } = connectionStateOf(
              { refresh_failed_at, expires_at, refresh_token_version, last_error: null },
              readable,
              NOW,
            );
            const unusable = state === "expired" || state === "unreadable";
            expect(state_reason !== null).toBe(unusable);
          }
        }
      }
    }
  });
});
