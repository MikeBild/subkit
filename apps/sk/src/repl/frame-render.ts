// Line-based turn-event rendering for the readline REPL.
//
// Owns the TurnEvent → terminal-line translation used by the readline
// surface in repl.ts: the per-event frame lines (tool calls, structured
// tool-result warnings, elicitation prompts incl. the OAuth auto-open
// path, validation errors, commits) and the end-of-turn assistant +
// usage summary. The Ink REPL renders the same events through its own
// React components instead — this module is readline-only.
//
// Every renderer takes the caller's `line` sink rather than writing to
// stdout directly so repl.ts keeps its debug-log-mirroring writer in
// one place.

import { hyperlink } from "@chat-ui/index.ts";
import { lastAssistantText, type SkSessionState, type TurnEvent } from "@cli-core/index.ts";
import { OAuthApprovalInputSchema } from "@shared/elicitation-constants.ts";
import { BrowserUrlSchema, defaultOpenBrowser } from "../lib/open-browser.ts";

/** Output sink for one rendered terminal line (no trailing newline). */
export type RenderLineSink = (s: string) => void;

/**
 * Pull the OAuth authorization URL out of an `elicit_request` input
 * payload. `authenticate_oauth` on the portal surface pauses via
 * `ask_user_confirm` carrying `kind: "external_write"` and an
 * `authorization_url` field — that's the marker the REPL keys on to
 * auto-open the browser. Returns `null` for any other elicitation.
 *
 * The whole payload is validated against the shared
 * `OAuthApprovalInputSchema` (the engine producer builds through the
 * same schema), so producer and consumer cannot silently drift. A
 * non-OAuth `ask_user_confirm` pause fails the schema and returns
 * `null` — `.safeParse` keeps that contract intact.
 */
function extractOAuthUrl(input: unknown): string | null {
  const approval = OAuthApprovalInputSchema.safeParse(input);
  if (!approval.success) return null;
  // `BrowserUrlSchema` owns the http(s)-only launch policy — route the
  // candidate through it rather than re-implementing the prefix check.
  // (`OAuthApprovalInputSchema` already validated it is a URL; this
  // additionally clamps the scheme to http(s) before a browser launch.)
  const parsed = BrowserUrlSchema.safeParse(approval.data.authorization_url);
  return parsed.success ? parsed.data : null;
}

export const renderFrame = (ev: TurnEvent, line: RenderLineSink): void => {
  switch (ev.type) {
    case "tool_call_start":
      line(
        `  ∙ tool_call ${ev.tool}${ev.input_partial !== undefined ? ` ${JSON.stringify(ev.input_partial).slice(0, 120)}` : ""}`,
      );
      break;
    case "tool_result": {
      line(`  ∙ tool_result ${ev.tool} ok`);
      // Bubble structured warnings the engine attached to the tool
      // result so authors can see operational hints (e.g.
      // `schedule_not_bound` from the Root A safety net) without
      // having to read raw JSON. Both shapes are tolerated:
      //   - top-level `warnings: [{ code, message? }]`
      //   - nested `output.data.warnings: [...]`
      const output =
        ev.output && typeof ev.output === "object" ? (ev.output as Record<string, unknown>) : null;
      const collected: Array<{ code?: unknown; message?: unknown }> = [];
      if (output && Array.isArray(output.warnings)) {
        for (const w of output.warnings) {
          if (w && typeof w === "object") collected.push(w as { code?: unknown });
        }
      }
      const data =
        output?.data && typeof output.data === "object"
          ? (output.data as Record<string, unknown>)
          : null;
      if (data && Array.isArray(data.warnings)) {
        for (const w of data.warnings) {
          if (w && typeof w === "object") collected.push(w as { code?: unknown });
        }
      }
      for (const w of collected) {
        const code = typeof w.code === "string" ? w.code : "warning";
        const msg = typeof w.message === "string" ? `: ${w.message}` : "";
        // Cap to ~80 chars so the warning stays on one terminal line.
        const text = `    ! ${code}${msg}`;
        line(text.length > 80 ? `${text.slice(0, 77)}...` : text);
      }
      break;
    }
    case "elicit_request": {
      const oauthUrl = extractOAuthUrl(ev.input);
      if (oauthUrl) {
        // OAuth authorization step — auto-open the browser and show a
        // clear waiting status. The engine-side waitForOAuthCredential
        // gates the actual continuation; the operator resumes via the
        // same confirm/`/respond` path once the browser flow finishes.
        line(`  ! authorization needed: ${ev.summary}`);
        line(`    open in browser: ${hyperlink(oauthUrl)}`);
        void defaultOpenBrowser(oauthUrl).then(
          () => line("    waiting for authorization in your browser…"),
          () => line("    browser launch failed — open the URL above manually, then resume below"),
        );
        line(`    when done, run '/respond ${ev.elicitation_id} {"confirmed":true}'`);
        break;
      }
      line(`  ! input needed: ${ev.tool_name} — ${ev.summary}`);
      line(`    run '/respond ${ev.elicitation_id} <value>'`);
      break;
    }
    case "validation_error":
      for (const e of ev.errors) line(`  × validation: ${e.path}: ${e.message}`);
      break;
    case "committed":
      line(`  ✓ committed workflow ${ev.workflow_id}`);
      break;
    default:
      break;
  }
};

// Print the assistant's last message and the per-turn token usage. Used
// at the tail of every consumption path (SSE stream and the synchronous
// events array returned by /respond) so a turn always concludes with a
// visible result line — which is what was missing from the slash-command
// path that produced the silent-hang transcript.
export const finishTurnRender = (session: SkSessionState, line: RenderLineSink): void => {
  const text = lastAssistantText(session).trim();
  if (text) line(`\nassistant> ${text}`);
  if (session.usage) {
    line(
      `   (usage: ${session.usage.turn_tokens} tokens this turn; ` +
        `${session.usage.remaining_monthly_budget_tokens ?? "∞"} remaining)`,
    );
  }
};
