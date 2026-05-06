// Browser-launch + poll loop for OAuth credential authorization.
//
// 1. Renders the auth URL and tries to open the user's default browser.
// 2. Polls `pollUrl` on a backoff schedule (1s, 2s, 4s, 8s, capped).
// 3. Returns the credential payload via `onConnected` when the engine
//    reports the authorization completed.
// 4. Always lets the operator paste a token manually as a fallback —
//    no browser, no problem.

import { exec } from "node:child_process";
import { useTheme } from "@chat-ui/index.ts";
import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";

export interface OAuthPollResponse {
  status: "pending" | "complete" | "failed";
  credential?: { id: string; [k: string]: unknown };
  error?: string;
}

export interface OAuthWaitViewProps {
  authUrl: string;
  /** Function the view calls to poll the engine. Tests inject a mock here. */
  poll: () => Promise<OAuthPollResponse>;
  onConnected: (credential: { id: string; [k: string]: unknown }) => void;
  onCancel?: () => void;
  /** Initial poll delay (ms). Doubles each attempt up to `maxIntervalMs`. */
  initialIntervalMs?: number;
  maxIntervalMs?: number;
  /** Override the browser-launch hook. Defaults to spawning `open`/`xdg-open`. */
  openBrowser?: (url: string) => Promise<void>;
}

function defaultOpenBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd =
      process.platform === "darwin"
        ? `open "${url.replace(/"/g, '\\"')}"`
        : process.platform === "win32"
          ? `start "" "${url}"`
          : `xdg-open "${url.replace(/"/g, '\\"')}"`;
    exec(cmd, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function OAuthWaitView({
  authUrl,
  poll,
  onConnected,
  onCancel,
  initialIntervalMs = 1000,
  maxIntervalMs = 8000,
  openBrowser = defaultOpenBrowser,
}: OAuthWaitViewProps): React.ReactElement {
  const tokens = useTheme();
  const [phase, setPhase] = useState<"launching" | "waiting" | "manual">("launching");
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Step 1 — launch the browser. Failures fall through to the manual
  // path; the URL is always printed for copy-paste.
  useEffect(() => {
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
  }, [authUrl, openBrowser]);

  // Step 2 — poll loop.
  useEffect(() => {
    if (phase !== "waiting") return undefined;
    let cancelled = false;
    let intervalMs = initialIntervalMs;

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      try {
        const r = await poll();
        if (cancelled) return;
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
