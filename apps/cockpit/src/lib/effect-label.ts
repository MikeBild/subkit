import type { TranslationKey } from "@/lib/i18n";

const SUBJECT_KEYS: Record<string, TranslationKey> = {
  issues: "authority.subject.issues",
  comments: "authority.subject.comments",
  commits: "authority.subject.commits",
  pulls: "authority.subject.pulls",
  repos: "authority.subject.repos",
  ref: "authority.subject.ref",
  contents: "authority.subject.contents",
  messages: "authority.subject.messages",
  files: "authority.subject.files",
  rows: "authority.subject.rows",
};

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function humanize(value: string): string {
  const words = decoded(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[\s._-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0]?.toUpperCase() + words.slice(1) : "";
}

export function effectLabel(
  t: (key: TranslationKey) => string,
  subject: string | null | undefined,
  stepId: string,
): string {
  const known = subject ? SUBJECT_KEYS[subject.toLowerCase()] : undefined;
  if (known) return t(known);
  return (subject ? humanize(subject) : "") || humanize(stepId) || stepId;
}
