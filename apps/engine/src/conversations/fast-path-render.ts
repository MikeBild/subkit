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
