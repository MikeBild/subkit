import { FileRefSchema } from "../api/files-schemas.ts";
import {
  type ResolverContext,
  resolvePlaceholdersTypePreserving,
  resolveStringPlaceholders,
} from "../llm/substitution/resolver.ts";
import type { MultipartPart } from "../workflows/types.ts";

export async function resolveMultipartInput(part: MultipartPart, ctx: ResolverContext) {
  const file =
    typeof part.file === "string" ? await resolvePlaceholdersTypePreserving(part.file, ctx) : null;
  if (file?.unresolved.length) throw new Error("multipart file reference is unresolved");
  const value = part.value === undefined ? null : await resolveStringPlaceholders(part.value, ctx);
  if (value?.unresolved.length) throw new Error("multipart value is unresolved");
  return {
    ...part,
    ...(file ? { file: FileRefSchema.parse(file.value) } : {}),
    ...(value ? { value: value.value } : {}),
  };
}
