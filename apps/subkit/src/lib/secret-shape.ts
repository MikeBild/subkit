type SecretShape =
  | {
      matched: true;
      kind: string;
      sample: string;
    }
  | { matched: false };

const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: "digitalocean_pat", re: /\bdop_v1_[A-Za-z0-9]{60,}\b/ },
  { kind: "github_pat", re: /\bghp_[A-Za-z0-9]{36,}\b/ },
  { kind: "github_oauth", re: /\bgho_[A-Za-z0-9]{36,}\b/ },
  { kind: "github_user_to_server", re: /\bghu_[A-Za-z0-9]{36,}\b/ },
  { kind: "github_server_to_server", re: /\bghs_[A-Za-z0-9]{36,}\b/ },
  { kind: "gitlab_pat", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { kind: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{40,}\b/ },
  { kind: "openai_key", re: /\bsk-[A-Za-z0-9]{40,}\b/ },
  { kind: "slack_token", re: /\bxox[bp]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "bearer_token", re: /\bBearer\s+[A-Za-z0-9._-]{30,}\b/ },
  {
    kind: "jwt",
    re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  },
  {
    kind: "aws_keypair",
    re: /\bAKIA[0-9A-Z]{16}\b[\s\S]{0,40}?\b[A-Za-z0-9/+=]{40}\b/,
  },
];

const WHITELIST: RegExp[] = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^\/[\w./-]+$/,
];

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

function prefixSample(token: string): string {
  const trimmed = token.replace(/^Bearer\s+/i, "");
  if (trimmed.length <= 6) return `${trimmed}…`;
  return `${trimmed.slice(0, 6)}…`;
}

export const REQUEST_CREDENTIAL_FORM_FALLBACK =
  "Please ask me for the credential through a masked form (ask_user_form with type: password, sensitive: true). I attempted to paste a credential into chat — do not echo anything; collect it via the form.";

export function secretRedirectHint(shape: { kind: string; sample: string }): string {
  const label = shape.kind.replace(/_/g, " ");
  return `That looks like a credential (${label}, ${shape.sample}). I'll ask the agent to collect it through a masked form. Press Enter to confirm, Esc to cancel.`;
}
