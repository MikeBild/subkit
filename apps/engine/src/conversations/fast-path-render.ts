// Deterministic rendering of a workflow run's output for a chat reply.
// Split out of `fast-path.ts` to keep that orchestrator under the
// file-size invariant; kept pure and dependency-free so both the
// fast-path and its tests can import it directly.

/**
 * Render a workflow's output for a chat reply. Deterministic and
 * shape-agnostic: a flat object becomes a `key: value` bullet list, a
 * scalar/string prints directly, anything nested falls back to a fenced
 * JSON block (which the outbound formatter leaves verbatim). Returns
 * `null` when there is no meaningful output so the caller can fall back
 * to a plain "succeeded" line.
 */
export function renderRunOutput(output: unknown): string | null {
  if (output === null || output === undefined) return null;
  if (typeof output === "string") return output.trim() === "" ? null : output;
  if (typeof output === "number" || typeof output === "boolean") return String(output);
  const asJsonBlock = (v: unknown) => `\`\`\`json\n${JSON.stringify(v, null, 2)}\n\`\`\``;
  if (Array.isArray(output)) {
    return output.length === 0 ? null : asJsonBlock(output);
  }
  if (typeof output === "object") {
    const entries = Object.entries(output as Record<string, unknown>);
    if (entries.length === 0) return null;
    const allScalar = entries.every(
      ([, v]) => v === null || ["string", "number", "boolean"].includes(typeof v),
    );
    if (allScalar) {
      return entries.map(([k, v]) => `- ${k}: ${v === null ? "—" : String(v)}`).join("\n");
    }
    return asJsonBlock(output);
  }
  return null;
}
