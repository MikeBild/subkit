import type { FeedbackDiagnostics } from "./redaction.ts";

export const FEEDBACK_KINDS = ["bug", "idea", "other"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export const FEEDBACK_CATEGORY = "feedback";
export const FEEDBACK_MESSAGE_MAX = 5000;
export const FEEDBACK_MAX_RECENT_ERRORS = 10;

const TITLE_PREFIX: Record<FeedbackKind, string> = {
  bug: "Bug report",
  idea: "Idea",
  other: "Feedback",
};
const TITLE_MAX = 120;

export interface StoredFeedbackFile {
  readonly id: string;
  readonly filename: string;
  readonly content_type: string;
  readonly size_bytes: number;
}

export function feedbackTitle(kind: FeedbackKind, message: string): string {
  const line = message.trim().split(/\r?\n/)[0]?.trim() ?? "";
  const short = line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line;
  return short ? `${TITLE_PREFIX[kind]}: ${short}` : TITLE_PREFIX[kind];
}

function sizeLabel(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.ceil(bytes / 1024)} KB`;
}

function diagnosticLines(diagnostics: FeedbackDiagnostics): string[] {
  const fields: [string, string | undefined][] = [
    ["Client", diagnostics.client_kind],
    ["App version", diagnostics.app_version],
    ["Platform", diagnostics.platform],
    ["Server version", diagnostics.server_version],
    ["Connection", diagnostics.connection],
    ["Route", diagnostics.route],
  ];
  const lines = fields
    .filter((field): field is [string, string] => Boolean(field[1]))
    .map(([label, value]) => `- ${label}: ${value}`);
  const errors = diagnostics.recent_errors ?? [];
  if (errors.length > 0) {
    lines.push("- Recent errors:");
    for (const entry of errors) lines.push(`  - ${entry.at} ${entry.code}`);
  }
  return lines;
}

export function feedbackBody(input: {
  report_id: string;
  kind: FeedbackKind;
  message: string;
  diagnostics: FeedbackDiagnostics | null;
  files: readonly StoredFeedbackFile[];
  redactions: number;
  contact_email?: string | null;
}): string {
  const sections = [input.message.trim()];
  if (input.contact_email)
    sections.push(["## Contact", `- Email: ${input.contact_email}`].join("\n"));
  sections.push(
    [
      "## Report",
      `- Kind: ${input.kind}`,
      `- Report id: ${input.report_id}`,
      `- Removed before storing: ${input.redactions}`,
    ].join("\n"),
  );
  if (input.diagnostics) {
    const lines = diagnosticLines(input.diagnostics);
    if (lines.length > 0) sections.push(["## Diagnostics", ...lines].join("\n"));
  }
  if (input.files.length > 0)
    sections.push(
      [
        "## Attachments",
        ...input.files.map(
          (file) =>
            `- ${file.filename} (${file.content_type.split(";")[0]}, ${sizeLabel(file.size_bytes)}), file ${file.id}`,
        ),
      ].join("\n"),
    );
  return sections.join("\n\n");
}
