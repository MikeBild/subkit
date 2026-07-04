// The request_connector_reauth affordance: outcome extraction plus the
// ReauthCard (OSC 8 sign-in hyperlink + one-shot browser auto-open).
// Extracted verbatim from authoring-cards.tsx, which re-exports this
// surface for the tests and keeps the renderAuthoringCard dispatch.

import { hyperlink } from "@chat-ui/index.ts";
import type { ToolCallState } from "@cli-core/index.ts";
import { Box, Text } from "ink";
import type React from "react";
import { memo, useEffect, useState } from "react";
import { BrowserUrlSchema, defaultOpenBrowser } from "../lib/open-browser.ts";
import { badge, unwrapData } from "./authoring-cards-shared.tsx";

// ---- request_connector_reauth -----------------------------------------------
//
// The engine repairs a dead connector credential through one of three
// shapes (apps/engine/src/conversations/tools/request-connector-reauth.ts):
//   - oauth2 authorization-code → { method: "oauth2", reauth_url,
//     expires_at, single_use: true } — a single-use 10-min grant link the
//     operator must open in a browser.
//   - oauth2 client_credentials  → { method: "oauth2", status: "reauthorized" }
//     — machine exchange already done, nothing to click.
//   - non-OAuth → { method: "portal_setup", mode: "credential_re_issue" }
//     — handled by the ask_user_form flow; falls back to the generic card.
//
// The link path mirrors the legacy readline REPL's elicit_request OAuth
// affordance (repl.ts: `open in browser: ${hyperlink(url)}` +
// defaultOpenBrowser): render the URL as an OSC 8 hyperlink AND auto-open
// the browser so the operator doesn't have to copy-paste a 150-char URL.

/** Parsed reauth outcome — null when the result shape is none of the
 *  recognized success shapes (errors and portal_setup fall back to the
 *  generic milestone card). EXPORTED FOR TESTS. */
export type ReauthOutcome =
  | { kind: "oauth2_link"; connector: string | null; url: string; expires_at: string | null }
  | { kind: "reauthorized"; connector: string | null };

export function extractReauthOutcome(call: ToolCallState): ReauthOutcome | null {
  const d = unwrapData(call);
  if (!d || d.ok === false) return null;
  if (d.method !== "oauth2") return null;
  const connector = typeof d.connector === "string" ? d.connector : null;
  if (typeof d.reauth_url === "string") {
    // Same http(s)-only launch policy every browser-bound URL goes
    // through — a non-launchable URL falls back to the generic card
    // instead of feeding xdg-open something exotic.
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

// Auto-open dedupe: the transcript re-renders (and can remount) cards
// many times per session; the browser must launch exactly once per tool
// call. Keyed by call id, process-lifetime.
const reauthAutoOpened = new Set<string>();

/** Test-only: forget which reauth calls already auto-opened a browser. */
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
  /** Override the browser-launch hook (tests). Defaults to spawning
   *  `open`/`xdg-open` via the shared validated helper. */
  openBrowser?: (url: string) => Promise<void>;
}

export const ReauthCard: React.FC<ReauthCardProps> = memo(
  ({ call, outcome, openBrowser = defaultOpenBrowser }) => {
    // Only a FRESH single-use link auto-opens. Replaying an old session
    // re-mounts historical tool results — launching a browser onto an
    // expired (or already-consumed) grant would 400 in the user's face.
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
          {/* One Text node so the label + URL wrap as a single paragraph —
              sibling Texts in a row Box shrink against each other and split
              the label mid-word. wrap-ansi re-opens the OSC 8 target on
              every wrapped line, so the link stays clickable throughout. */}
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

// Absolute local time, not a relative countdown: the card is a static
// transcript row, so "in 10 minutes" would silently go stale while a
// clock time stays true. Falls back to the raw string on unparseable
// input (engine always sends ISO-8601; belt-and-braces for old engines).
function formatReauthExpiry(expiresAt: string): string {
  const ts = Date.parse(expiresAt);
  if (Number.isNaN(ts)) return expiresAt;
  return new Date(ts).toLocaleTimeString();
}
