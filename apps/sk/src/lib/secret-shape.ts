// Input-side credential filter for the sk Ink composer.
//
// `detectSecretShape` scans a user-typed (or pasted) string for tokens
// that *look* like credentials and returns a kind + a 6-char prefix
// sample. The matched secret is NEVER returned in full and never logged
// — only the kind label and prefix sample escape this module.
//
// Background: session 00b93a52-… leaked a DigitalOcean PAT (`dop_v1_…`)
// twice into the conversation transcript, debug.log, and dialog turn
// events because sk had no input-side filter — only `ask_user_form`'s
// `sensitive: true` flag masked anything. This module is the missing
// pre-send guard. The composer calls it on every submit, suppresses the
// send if it matches, and asks the agent to re-collect via a masked
// form.
//
// Pure module — no I/O, no logger calls. The caller decides what to
// surface to the UI; this file's only outputs are the kind name and a
// prefix-only sample.

export type SecretShape =
  | {
      matched: true;
      /** Stable kind label (e.g. "digitalocean_pat", "github_pat"). */
      kind: string;
      /** First 6 chars of the matched token, plus an ellipsis. Safe to display. */
      sample: string;
    }
  | { matched: false };

/**
 * Pattern catalogue. Order matters: more specific prefixes (e.g.
 * `sk-ant-`) must come before broader ones (e.g. `sk-`). Each entry's
 * `re` is anchored only via word boundaries so it can match inside a
 * pasted message that also contains prose ("here is my key dop_v1_…").
 */
const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  // DigitalOcean Personal Access Token. Real format observed:
  // `dop_v1_<64 hex>`; allow [A-Za-z0-9] and 60+ for safety.
  { kind: "digitalocean_pat", re: /\bdop_v1_[A-Za-z0-9]{60,}\b/ },
  // GitHub fine-grained / classic PATs and OAuth tokens. The 5
  // documented prefixes share the same shape: `<prefix>_<36+ chars>`.
  { kind: "github_pat", re: /\bghp_[A-Za-z0-9]{36,}\b/ },
  { kind: "github_oauth", re: /\bgho_[A-Za-z0-9]{36,}\b/ },
  { kind: "github_user_to_server", re: /\bghu_[A-Za-z0-9]{36,}\b/ },
  { kind: "github_server_to_server", re: /\bghs_[A-Za-z0-9]{36,}\b/ },
  // GitLab personal access tokens.
  { kind: "gitlab_pat", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  // Anthropic API keys MUST be matched before generic `sk-…`.
  { kind: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{40,}\b/ },
  // OpenAI / generic `sk-…` keys (also stripe restricted keys etc.).
  { kind: "openai_key", re: /\bsk-[A-Za-z0-9]{40,}\b/ },
  // Slack bot / user OAuth tokens.
  { kind: "slack_token", re: /\bxox[bp]-[A-Za-z0-9-]{10,}\b/ },
  // `Authorization: Bearer …` headers pasted verbatim.
  { kind: "bearer_token", re: /\bBearer\s+[A-Za-z0-9._-]{30,}\b/ },
  // JSON Web Tokens — three base64url segments separated by dots,
  // header always starts with `eyJ` (b64-encoded `{"`).
  {
    kind: "jwt",
    re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  },
  // AWS access key id (AKIA…) — almost always followed by a 40-char
  // secret. Only flag when both are present so we don't trip on raw
  // role IDs that legitimately appear in IAM JSON.
  {
    kind: "aws_keypair",
    re: /\bAKIA[0-9A-Z]{16}\b[\s\S]{0,40}?\b[A-Za-z0-9/+=]{40}\b/,
  },
];

/**
 * False-positive whitelist. We test the *match* against these regexes;
 * if any of them claim the substring, the match is suppressed. Used to
 * stop UUIDv4 conversation IDs and absolute filesystem paths from being
 * flagged when they happen to look long-and-random.
 */
const WHITELIST: RegExp[] = [
  // UUIDv4 — conversation/elicitation/tenant ids share this shape.
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  // Absolute POSIX path — `/Users/foo/bar`, `/etc/passwd`, etc. Never
  // a credential on its own; the user is talking about a file.
  /^\/[\w./-]+$/,
];

/**
 * Scan `text` for the first credential-shaped substring and return the
 * kind + prefix sample. Returns `{ matched: false }` if nothing matched
 * or the match was on the whitelist.
 *
 * The function is intentionally cheap: small fixed pattern list, single
 * pass per pattern, early return on first match. Safe to call on every
 * Enter keystroke.
 */
export function detectSecretShape(text: string): SecretShape {
  if (!text || text.length < 16) return { matched: false };

  for (const { kind, re } of PATTERNS) {
    const match = re.exec(text);
    if (!match) continue;
    const hit = match[0];
    if (WHITELIST.some((w) => w.test(hit))) continue;
    return { matched: true, kind, sample: prefixSample(hit) };
  }

  return { matched: false };
}

/**
 * Build the safe-to-display sample. Strips any well-known prefix
 * (`Bearer `) so what the user sees is `dop_v1…` not `Bearer dop_…`,
 * then returns the first 6 chars plus an ellipsis.
 */
function prefixSample(token: string): string {
  const trimmed = token.replace(/^Bearer\s+/i, "");
  if (trimmed.length <= 6) return `${trimmed}…`;
  return `${trimmed.slice(0, 6)}…`;
}

/**
 * The prose fallback the composer sends as the turn's `message` when a
 * secret shape is detected. The primary mechanism is now the typed
 * `request_credential_form` event on the message-append body (see
 * `RequestCredentialFormEvent` in engine-client/conversations.ts) — the
 * engine short-circuits the turn and opens the masked `ask_user_form`
 * deterministically, no LLM call. This prose rides along for code
 * paths that cannot carry the event (a create-conversation first turn): the
 * agent's skill set already requires `ask_user_form(type: password)`
 * for any credential, so re-prompting in plain language still gets the
 * masked form back.
 */
export const REQUEST_CREDENTIAL_FORM_FALLBACK =
  "Please ask me for the credential through a masked form (ask_user_form with type: password, sensitive: true). I attempted to paste a credential into chat — do not echo anything; collect it via the form.";

/**
 * Build the inline hint shown in the composer field after a detected
 * paste. The user sees the kind label and prefix sample, never the
 * full token.
 */
export function secretRedirectHint(shape: { kind: string; sample: string }): string {
  const label = shape.kind.replace(/_/g, " ");
  return `That looks like a credential (${label}, ${shape.sample}). I'll ask the agent to collect it through a masked form. Press Enter to confirm, Esc to cancel.`;
}
