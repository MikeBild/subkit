// Constants and schemas shared between the engine and the CLI for the
// elicitation surface. The engine encodes these field names into
// elicitation payloads; the CLI keys on them to drive client-side
// behavior (e.g. auto-opening the OAuth authorization URL in a browser).
// Keeping the name — and now the full carrier shape — in one place
// prevents the two sides from silently drifting apart.

import { z } from "zod";

/**
 * The field on an `ask_user_confirm` elicitation `input` payload that
 * carries the OAuth authorization URL. The engine's `authenticate_oauth`
 * tool sets it on the DB-pause elicitation; the CLI REPL keys on it to
 * detect the OAuth step and auto-open the browser.
 */
export const OAUTH_AUTHORIZATION_URL_FIELD = "authorization_url";

/**
 * The full `ask_user_confirm` elicitation `input` carrier shape for the
 * OAuth authorization case. Both the engine producer
 * (`authenticate_oauth#oauthApprovalInput`) and the CLI consumer
 * (`apps/sk/src/repl.ts#extractOAuthUrl`) validate against this schema,
 * so the producer cannot add/rename a field the consumer silently
 * ignores. `.passthrough()` is deliberate — unrelated `ask_user_confirm`
 * pauses also flow through `extractOAuthUrl`, and a non-OAuth payload
 * simply fails the `kind` / URL-field checks rather than the object
 * being rejected outright.
 */
export const OAuthApprovalInputSchema = z
  .object({
    /** Fixed discriminator — this pause is a non-auto-approvable external write. */
    kind: z.literal("external_write"),
    /** Operator-facing confirmation question. */
    question: z.string().min(1),
    /** Human-readable summary (the authorize-in-browser instructions). */
    summary: z.string().min(1),
    /**
     * The OAuth authorization URL the operator opens in their browser.
     *
     * Constrained to `http(s)://` at the producer — defence in depth. A
     * connector with a hostile `oauth.issuer_url` could otherwise make the
     * engine emit a `javascript:` / `data:` URL into the elicitation row;
     * the CLI's `BrowserUrlSchema` already rejects it on the consumer side,
     * but the producer must not write a non-launchable URL in the first
     * place. Same positive `^https?://` allowlist semantics as
     * `BrowserUrlSchema` (`apps/sk/src/lib/open-browser.ts`): it admits only
     * http(s) and rejects everything else (file:, javascript:, data:, …).
     */
    [OAUTH_AUTHORIZATION_URL_FIELD]: z
      .string()
      .url()
      .refine((u) => /^https?:\/\//i.test(u), {
        message: "authorization_url must be an http(s) URL",
      }),
    /** Canonical engine-synthesized redirect URI for the provider allowlist. */
    redirect_uri: z.string().url(),
  })
  .passthrough();
