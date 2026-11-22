export interface PreviewWarning {
  code?: unknown;
}

export function previewWarningDetail(warnings: readonly PreviewWarning[]): string {
  const codes = warnings
    .map((warning) => warning.code)
    .filter((code): code is string => typeof code === "string" && code.length > 0);
  return `${warnings.length} warning(s): ${codes.length > 0 ? codes.join(", ") : "(no code)"}`;
}
