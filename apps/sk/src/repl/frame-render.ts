import { hyperlink } from "@chat-ui/index.ts";
import { lastAssistantText, type SkSessionState, type TurnEvent } from "@cli-core/index.ts";
import { OAuthApprovalInputSchema } from "@shared/elicitation-constants.ts";
import { formatCitationsFooter, terminalAssistantCitations } from "../lib/citations-footer.ts";
import { BrowserUrlSchema, defaultOpenBrowser } from "../lib/open-browser.ts";

type RenderLineSink = (s: string) => void;

function extractOAuthUrl(input: unknown): string | null {
  const approval = OAuthApprovalInputSchema.safeParse(input);
  if (!approval.success) return null;
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
        const text = `    ! ${code}${msg}`;
        line(text.length > 80 ? `${text.slice(0, 77)}...` : text);
      }
      break;
    }
    case "elicit_request": {
      const oauthUrl = extractOAuthUrl(ev.input);
      if (oauthUrl) {
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

export const finishTurnRender = (session: SkSessionState, line: RenderLineSink): void => {
  const text = lastAssistantText(session).trim();
  if (text) {
    line(`\nassistant> ${text}`);
    const footer = formatCitationsFooter(terminalAssistantCitations(session.messages));
    if (footer) line(footer);
  }
  if (session.usage) {
    line(
      `   (usage: ${session.usage.turn_tokens} tokens this turn; ` +
        `${session.usage.remaining_monthly_budget_tokens ?? "∞"} remaining)`,
    );
  }
};
