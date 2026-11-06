import { useTheme } from "@chat-ui/index.ts";
import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { defaultOpenBrowser } from "../../lib/open-browser.ts";

const OAuthCredentialSchema = z.object({ id: z.string() }).passthrough();

const OAuthPollResponseSchema = z.object({
  status: z.enum(["pending", "complete", "failed"]),
  credential: OAuthCredentialSchema.optional(),
  error: z.string().optional(),
});

export type OAuthPollResponse = z.infer<typeof OAuthPollResponseSchema>;
type OAuthCredential = z.infer<typeof OAuthCredentialSchema>;

const AuthUrlSchema = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), {
    message: "authUrl must be http(s); file:/javascript:/data: schemes rejected",
  });

export interface OAuthWaitViewProps {
  authUrl: string;
  redirectUri?: string;
  poll: () => Promise<unknown>;
  onConnected: (credential: OAuthCredential) => void;
  onCancel?: () => void;
  initialIntervalMs?: number;
  maxIntervalMs?: number;
  openBrowser?: (url: string) => Promise<void>;
}

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
  const urlCheck = AuthUrlSchema.safeParse(authUrl);
  const [phase, setPhase] = useState<"launching" | "waiting" | "manual">(
    urlCheck.success ? "launching" : "manual",
  );
  const [error, setError] = useState<string | null>(
    urlCheck.success ? null : `rejected authUrl: ${urlCheck.error.issues[0]?.message ?? "invalid"}`,
  );
  const [attempts, setAttempts] = useState(0);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  useEffect(() => {
    if (phase !== "waiting") return undefined;
    let cancelled = false;
    let intervalMs = initialIntervalMs;

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      try {
        const raw = await poll();
        if (cancelled) return;
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
