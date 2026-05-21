// Browser-launch + poll loop for OAuth credential authorization.
//
// 1. Renders the auth URL and tries to open the user's default browser.
// 2. Polls `pollUrl` on a backoff schedule (1s, 2s, 4s, 8s, capped).
// 3. Returns the credential payload via `onConnected` when the engine
//    reports the authorization completed.
// 4. Always lets the operator paste a token manually as a fallback —
//    no browser, no problem.

import { useTheme } from "@chat-ui/index.ts";
import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { defaultOpenBrowser } from "../../lib/open-browser.ts";

// Validate the engine→CLI poll response at the
// boundary. The credential payload arrives over HTTP and lands in
// `onConnected` — exactly the kind of "CLI input" AGENTS.md says
// should be Zod-validated. `passthrough()` keeps unknown extras
// (e.g. provider-specific identity fields) without dropping them.
const OAuthCredentialSchema = z.object({ id: z.string() }).passthrough();

const OAuthPollResponseSchema = z.object({
  status: z.enum(["pending", "complete", "failed"]),
  credential: OAuthCredentialSchema.optional(),
  error: z.string().optional(),
});

export type OAuthPollResponse = z.infer<typeof OAuthPollResponseSchema>;
export type OAuthCredential = z.infer<typeof OAuthCredentialSchema>;

// R5-W4 review fix: validate `authUrl` itself before launching it
// via `spawn(bin, [authUrl])`. The `spawn(..., { shell: false })`
// guard prevents shell-injection but it does NOT prevent URL-scheme
// abuse — `xdg-open file:///etc/passwd` would still launch a file
// reader if a tampered connector template snuck through. Restrict
// to plain `http(s)://` and reject `file:`, `javascript:`, `data:`,
// or anything else exotic.
export const AuthUrlSchema = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), {
    message: "authUrl must be http(s); file:/javascript:/data: schemes rejected",
  });

export interface OAuthWaitViewProps {
  authUrl: string;
  /** Canonical redirect URI the operator must add to their OAuth
   *  provider's allowlist before opening `authUrl`. Synthesized by the
   *  engine from `server.public_base_url + /v1/oauth/callback`. When
   *  set, the view surfaces it above the authorize URL so the
   *  operator has a chance to configure the provider before the
   *  browser opens. Without this, providers return
   *  `redirect_uri_mismatch` on first authorize. */
  redirectUri?: string;
  /** Function the view calls to poll the engine. Tests inject a mock
   *  here. The returned value is parsed through `OAuthPollResponseSchema`
   *  before reaching `onConnected`. */
  poll: () => Promise<unknown>;
  onConnected: (credential: OAuthCredential) => void;
  onCancel?: () => void;
  /** Initial poll delay (ms). Doubles each attempt up to `maxIntervalMs`. */
  initialIntervalMs?: number;
  maxIntervalMs?: number;
  /** Override the browser-launch hook. Defaults to spawning `open`/`xdg-open`. */
  openBrowser?: (url: string) => Promise<void>;
}

// Argv-style browser launch lives in the shared `lib/open-browser.ts`
// util — see that file for the shell-injection / URL-scheme threat
// model. The REPL's OAuth-elicitation path reuses the same helper.

export function OAuthWaitView({
  authUrl,
  redirectUri,
  poll,
  onConnected,
  onCancel,
  initialIntervalMs = 1000,
  maxIntervalMs = 8000,
  openBrowser = defaultOpenBrowser,
}: OAuthWaitViewProps): React.ReactElement {
  const tokens = useTheme();
  // Validate the URL up-front. A malformed or unsupported-scheme URL
  // lands the view in the "manual" phase with an error rather than
  // launching `xdg-open file:///etc/passwd` or similar. R5-W4.
  const urlCheck = AuthUrlSchema.safeParse(authUrl);
  const [phase, setPhase] = useState<"launching" | "waiting" | "manual">(
    urlCheck.success ? "launching" : "manual",
  );
  const [error, setError] = useState<string | null>(
    urlCheck.success ? null : `rejected authUrl: ${urlCheck.error.issues[0]?.message ?? "invalid"}`,
  );
  const [attempts, setAttempts] = useState(0);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Step 1 — launch the browser. Failures fall through to the manual
  // path; the URL is always printed for copy-paste. Skips entirely
  // when the URL didn't pass the scheme check.
  useEffect(() => {
    if (!urlCheck.success) return undefined;
    let cancelled = false;
    openBrowser(authUrl).then(
      () => {
        if (!cancelled) setPhase("waiting");
      },
      () => {
        if (!cancelled) {
          setPhase("manual");
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [authUrl, openBrowser, urlCheck.success]);

  // Step 2 — poll loop.
  useEffect(() => {
    if (phase !== "waiting") return undefined;
    let cancelled = false;
    let intervalMs = initialIntervalMs;

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      try {
        const raw = await poll();
        if (cancelled) return;
        // Validate the wire shape at the CLI boundary. A malformed
        // engine response (legacy server, partial deploy) lands in
        // `setError` rather than crashing the view.
        const parsed = OAuthPollResponseSchema.safeParse(raw);
        if (!parsed.success) {
          setError(`malformed poll response: ${parsed.error.message}`);
          return;
        }
        const r = parsed.data;
        setAttempts((n) => n + 1);
        if (r.status === "complete" && r.credential) {
          onConnected(r.credential);
          return;
        }
        if (r.status === "failed") {
          setError(r.error ?? "authorization failed");
          return;
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
      intervalMs = Math.min(maxIntervalMs, intervalMs * 2);
      pollTimer.current = setTimeout(tick, intervalMs);
    };

    pollTimer.current = setTimeout(tick, intervalMs);
    return () => {
      cancelled = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [phase, poll, onConnected, initialIntervalMs, maxIntervalMs]);

  useInput((input, key) => {
    if (key.escape) onCancel?.();
    if (input === "m" || input === "M") setPhase("manual");
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={tokens.accent.primary} bold>
          ▸ authorize the connection
        </Text>
      </Box>
      {redirectUri ? (
        <>
          <Box paddingLeft={2}>
            <Text color={tokens.severity.dim}>
              add this redirect URI to your OAuth app's allowlist:
            </Text>
          </Box>
          <Box paddingLeft={2}>
            <Text color={tokens.accent.link}>{redirectUri}</Text>
          </Box>
        </>
      ) : null}
      <Box paddingLeft={2}>
        <Text color={tokens.severity.dim}>open in browser:</Text>
      </Box>
      <Box paddingLeft={2}>
        <Text color={tokens.accent.link}>{authUrl}</Text>
      </Box>

      {phase === "launching" ? (
        <Box paddingLeft={2}>
          <Text color={tokens.severity.dim}>launching browser…</Text>
        </Box>
      ) : null}

      {phase === "waiting" ? (
        <Box paddingLeft={2}>
          <Text color={tokens.severity.dim}>waiting for callback (attempt {attempts + 1})…</Text>
        </Box>
      ) : null}

      {phase === "manual" ? (
        <Box paddingLeft={2} flexDirection="column">
          <Text color={tokens.severity.warning}>
            browser launch failed — open the URL above manually, then press M when authorized
          </Text>
        </Box>
      ) : null}

      {error ? (
        <Box paddingLeft={2}>
          <Text color={tokens.severity.error}>error: {error}</Text>
        </Box>
      ) : null}

      <Box paddingLeft={2}>
        <Text color={tokens.severity.dim}>esc cancels</Text>
      </Box>
    </Box>
  );
}
