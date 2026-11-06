import type { SubkitLlmMessage } from "./base-types.ts";

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

interface AssembleSuggestionPromptInput {
  recent_messages: ReadonlyArray<RecentMessage>;
  max_history?: number;
  max_chars_per_message?: number;
}

interface SuggestionPrompt {
  system: string;
  messages: SubkitLlmMessage[];
}

const DEFAULT_HISTORY = 8;
const DEFAULT_PER_MESSAGE_CHARS = 1200;

function trimToTail(text: string, max: number): string {
  if (text.length <= max) return text;
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

  const messages: SubkitLlmMessage[] =
    built.length > 0 && built[built.length - 1]!.role === "assistant"
      ? [...built, { role: "user", content: "What would I type next?" }]
      : built;

  return {
    system: SUGGESTION_SYSTEM_PROMPT,
    messages,
  };
}
