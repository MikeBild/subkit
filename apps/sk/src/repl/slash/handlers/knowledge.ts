import { collectBundleFiles, defaultBundleName } from "../../../lib/bundle-import.ts";
import { sanitizePathInput } from "../../../lib/path-input.ts";
import type { SlashHandlerContext } from "../handler.ts";
import { dispatchInspectSlash } from "./inspect.ts";

const USAGE =
  "usage: /knowledge import <dir> [name…] — import a markdown directory (Obsidian vault, agent wiki, OKF bundle) as a searchable knowledge source";

export async function dispatchKnowledgeSlash(
  rawArgs: string[],
  ctx: SlashHandlerContext,
): Promise<string | null> {
  const action = (rawArgs[0] ?? "").trim();
  if (action === "") return (await dispatchInspectSlash("knowledge", ctx)) ?? null;
  if (action !== "import") return USAGE;
  const dirArg = (rawArgs[1] ?? "").trim();
  if (!dirArg) return USAGE;

  let files: ReturnType<typeof collectBundleFiles>;
  let dir: string;
  try {
    dir = sanitizePathInput(dirArg);
    files = collectBundleFiles(dir);
  } catch (err) {
    return `couldn't read bundle: ${err instanceof Error ? err.message : String(err)}`;
  }

  const nameOverride = rawArgs.slice(2).join(" ").trim();
  const name = nameOverride || defaultBundleName(dir, files.files);

  try {
    const result = await ctx.client.importKnowledgeBundle({ name, files: files.files });
    const ks = (result.knowledge_source ?? {}) as Record<string, unknown>;
    const outcome = String(result.outcome ?? "unknown");
    const skipped = Number(result.skipped_count ?? 0);
    const nonMd = files.skipped_non_markdown;
    return (
      `${outcome}: "${String(ks.name ?? name)}" (${String(ks.slug ?? "")}) — ` +
      `${files.files.length} files, ${String(result.ingested_count ?? 0)} chunks ingested` +
      (skipped > 0 ? `, ${skipped} skipped (index/log/duplicates)` : "") +
      (nonMd > 0 ? `, ${nonMd} non-markdown files left out` : "") +
      " — ask about it right away; search_knowledge grounds on it"
    );
  } catch (err) {
    return `import failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
