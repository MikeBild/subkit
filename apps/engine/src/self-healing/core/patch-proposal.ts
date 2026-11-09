export interface PatchProposal {
  classification: string;
  kind: string;
  description: string;
  patch: Record<string, unknown>;
  reasoning: string;
}
