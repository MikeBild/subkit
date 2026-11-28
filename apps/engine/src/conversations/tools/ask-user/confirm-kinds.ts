export const CONFIRM_PROMPT_KINDS = [
  "save_workflow_draft",
  "external_write",
  "generic",
  "partial_diff_approval",
  "mcp_local_command",
] as const;

export type ConfirmPromptKind = (typeof CONFIRM_PROMPT_KINDS)[number];
