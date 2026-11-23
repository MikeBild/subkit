import { redactSecretShapes } from "@shared/redaction.ts";

export function redactKnowledgeText(text: string): { text: string; redactions: number } {
  const redacted = redactSecretShapes(text);
  return { text: redacted.text, redactions: redacted.count };
}

export function redactBundleFiles<T extends { path: string; content: string }>(
  files: readonly T[],
): { files: T[]; redactions: number } {
  let redactions = 0;
  const clean = files.map((file) => {
    const redacted = redactKnowledgeText(file.content);
    redactions += redacted.redactions;
    return redacted.redactions > 0 ? { ...file, content: redacted.text } : file;
  });
  return { files: clean, redactions };
}
