// Minimal prompt builder for the model-fallback path of next-message
// suggestion. The whole file exists to enforce ONE invariant by
// construction: this prompt assembler MUST NOT load skills, knowledge,
// docs, runtime context, or anything else the converse pipeline pulls
// in for a real turn. Regressing this re-introduces the 1M-token
// empty-turn class of bug we already fought once (see the converse
// pipeline note in repo memory).
//
// The output is intentionally small:
//   - a static system prompt that tells the model to predict the user's
//     next message in 2–12 words, or stay silent;
//   - the last N message turns of the conversation, text-only,
//     trimmed to keep the call cheap.
//
// The shape is `SubkitLlmMessage` so the service can hand the result
// straight to the engine's existing `generateText` helper without any
// adapter layer.

import type { SubkitLlmMessage } from "./base-types.ts";

/**
 * The system prompt is adapted from Claude Code's `SUGGESTION_PROMPT`
 * (PromptSuggestion service). The rules match — what differs is the
 * branding: we say "sk" instead of "Claude Code", and we explicitly
 * call out slash-command predictions because sk has more first-class
 * slash surface than Claude Code.
 */
export const SUGGESTION_SYSTEM_PROMPT = [
  "[SUGGESTION MODE: predict what the user is most likely to type next into sk.]",
  "",
  "FIRST: read the conversation above and the user's original ask.",
  "",
  "Predict what THE USER would type — not what you think they should do.",
  "",
  'THE TEST: would they think "I was just about to type that"?',
  "",
  "EXAMPLES:",
  "- User asked 'fix the bug and run tests', bug is fixed → 'run the tests'",
  "- After code changes are written → 'try it out'",
  "- Assistant offered options → predict the one the user would pick",
  "- Assistant asked to continue → 'yes' or 'go ahead'",
  "- Task complete, obvious follow-up → 'commit this' or 'push it'",
  "- Skill is loaded and the obvious next action is a skill verb → emit '/skill <slug> <verb>'",
  "- After an error or misunderstanding → STAY SILENT (let them assess)",
  "",
  "Be specific: 'run the tests' beats 'continue'.",
  "",
  "NEVER SUGGEST:",
  "- Evaluative phrasing ('looks good', 'thanks')",
  "- Questions back to the assistant ('what about...?')",
  "- Assistant-voice ('Let me...', 'I'll...', 'Here is...')",
  "- New ideas the user did not ask about",
  "- Multiple sentences",
  "",
  "Stay silent if the next step isn't obvious from what the user said.",
  "",
  "Format: 2–12 words, match the user's style. Or nothing.",
  "Reply with ONLY the suggestion — no quotes, no labels, no explanation.",
].join("\n");

export interface RecentMessage {
  role: "user" | "assistant";
  text: string;
}

export interface AssembleSuggestionPromptInput {
  /** Most-recent-last conversation messages, already sanitized to text-only. */
  recent_messages: ReadonlyArray<RecentMessage>;
  /** Hard cap on history turns included in the prompt. Defaults to 8. */
  max_history?: number;
  /** Hard cap per-message character length; defaults to 1200. Trims preserve the tail. */
  max_chars_per_message?: number;
}

export interface SuggestionPrompt {
  system: string;
  messages: SubkitLlmMessage[];
}

const DEFAULT_HISTORY = 8;
const DEFAULT_PER_MESSAGE_CHARS = 1200;

function trimToTail(text: string, max: number): string {
  if (text.length <= max) return text;
  // Tail-preserving trim: the model cares more about the LATEST content of
  // a long message (recent assistant prose) than its opener.
  const tail = text.slice(-max);
  return `…${tail.replace(/^\S*\s+/, "")}`;
}

export function assembleSuggestionPrompt(input: AssembleSuggestionPromptInput): SuggestionPrompt {
  const max = input.max_history ?? DEFAULT_HISTORY;
  const perMsg = input.max_chars_per_message ?? DEFAULT_PER_MESSAGE_CHARS;

  const tail = input.recent_messages.slice(-max);
  const built: SubkitLlmMessage[] = tail
    .filter((m) => typeof m.text === "string" && m.text.trim().length > 0)
    .map((m) => ({
      role: m.role,
      content: trimToTail(m.text.trim(), perMsg),
    }));

  // Anthropic and some other providers reject `messages` arrays that end
  // with an assistant turn — they treat it as an attempt to prefill the
  // assistant's response. Suggest-next runs immediately after an
  // assistant turn, so without this guard every model call ends with
  // assistant role and the provider returns "This model does not support
  // assistant message prefill. The conversation must end with a user
  // message." (production session 16:09:50 against v4.10.0). The
  // suggestion's job is to predict what the USER would type next, so we
  // append a synthetic user nudge that frames the prediction explicitly.
  // The system prompt already tells the model to reply with only the
  // suggestion, so the nudge stays terse.
  const messages: SubkitLlmMessage[] =
    built.length > 0 && built[built.length - 1]!.role === "assistant"
      ? [...built, { role: "user", content: "What would I type next?" }]
      : built;

  return {
    system: SUGGESTION_SYSTEM_PROMPT,
    messages,
  };
}
