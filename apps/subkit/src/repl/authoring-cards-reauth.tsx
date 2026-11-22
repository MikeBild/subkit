import { hyperlink } from "@chat-ui/index.ts";
import type { ToolCallState } from "@cli-core/index.ts";
import { Box, Text } from "ink";
import type React from "react";
import { memo, useEffect, useState } from "react";
import { BrowserUrlSchema, defaultOpenBrowser } from "../lib/open-browser.ts";
import { badge, unwrapData } from "./authoring-cards-shared.tsx";

export type ReauthOutcome =
  | { kind: "oauth2_link"; connector: string | null; url: string; expires_at: string | null }
  | { kind: "reauthorized"; connector: string | null };

export function extractReauthOutcome(call: ToolCallState): ReauthOutcome | null {
  const d = unwrapData(call);
  if (!d || d.ok === false) return null;
  if (d.method !== "oauth2") return null;
  const connector = typeof d.connector === "string" ? d.connector : null;
  if (typeof d.reauth_url === "string") {
    const parsed = BrowserUrlSchema.safeParse(d.reauth_url);
    if (!parsed.success) return null;
    return {
      kind: "oauth2_link",
      connector,
      url: parsed.data,
      expires_at: typeof d.expires_at === "string" ? d.expires_at : null,
    };
  }
  if (d.status === "reauthorized") return { kind: "reauthorized", connector };
  return null;
}

const reauthAutoOpened = new Set<string>();

export function resetReauthAutoOpenForTests(): void {
  reauthAutoOpened.clear();
}

function reauthLinkIsFresh(expiresAt: string | null): boolean {
  if (!expiresAt) return true;
  const ts = Date.parse(expiresAt);
  return Number.isNaN(ts) ? true : ts > Date.now();
}

export interface ReauthCardProps {
  call: ToolCallState;
  outcome: ReauthOutcome;
  openBrowser?: (url: string) => Promise<void>;
}

export const ReauthCard: React.FC<ReauthCardProps> = memo(
  ({ call, outcome, openBrowser = defaultOpenBrowser }) => {
    const fresh = outcome.kind === "oauth2_link" && reauthLinkIsFresh(outcome.expires_at);
    const [launch, setLaunch] = useState<"opened" | "failed" | null>(null);
    useEffect(() => {
      if (outcome.kind !== "oauth2_link" || !fresh) return undefined;
      if (reauthAutoOpened.has(call.id)) return undefined;
      reauthAutoOpened.add(call.id);
      let cancelled = false;
      openBrowser(outcome.url).then(
        () => {
          if (!cancelled) setLaunch("opened");
        },
        () => {
          if (!cancelled) setLaunch("failed");
        },
      );
      return () => {
        cancelled = true;
      };
    }, [outcome, fresh, call.id, openBrowser]);

    const slug = outcome.connector ? ` ${outcome.connector}` : "";
    if (outcome.kind === "reauthorized") {
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Box>{badge("ok", `connector${slug} reauthorized`)}</Box>
          <Box marginLeft={2}>
            <Text dimColor>credential refreshed machine-side — no sign-in needed</Text>
          </Box>
        </Box>
      );
    }
    const expiryNote = outcome.expires_at
      ? `single-use link · expires ${formatReauthExpiry(outcome.expires_at)}`
      : "single-use link";
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box>{badge("warn", `sign-in needed:${slug || " connector"}`)}</Box>
        <Box marginLeft={2}>
          <Text wrap="wrap">
            <Text dimColor>open in browser: </Text>
            <Text color="cyan">{hyperlink(outcome.url)}</Text>
          </Text>
        </Box>
        <Box marginLeft={2}>
          <Text dimColor>{expiryNote}</Text>
        </Box>
        {!fresh ? (
          <Box marginLeft={2}>
            <Text color="yellow">
              link expired — ask for a fresh one (request_connector_reauth)
            </Text>
          </Box>
        ) : null}
        {launch === "opened" ? (
          <Box marginLeft={2}>
            <Text dimColor>browser opened — finish the sign-in there</Text>
          </Box>
        ) : null}
        {launch === "failed" ? (
          <Box marginLeft={2}>
            <Text color="yellow">browser launch failed — open the URL above manually</Text>
          </Box>
        ) : null}
      </Box>
    );
  },
);
ReauthCard.displayName = "ReauthCard";

function formatReauthExpiry(expiresAt: string): string {
  const ts = Date.parse(expiresAt);
  if (Number.isNaN(ts)) return expiresAt;
  return new Date(ts).toLocaleTimeString();
}
