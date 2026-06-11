// Interactive ID picker for commands whose required ID was omitted.
//
// In a TTY, an omitted ID opens a @clack/prompts select over the
// resource list instead of erroring — the codex-CLI "resume picker"
// pattern. Non-TTY (CI, pipes) keeps the current behavior byte-
// identical: the same "<label> is required" error the command threw
// before this helper existed, so scripts never block on a prompt.

import * as prompts from "@clack/prompts";

export interface PickRow {
  id: string;
  /** Human label parts — joined as "name (detail) id-prefix". */
  name?: string | null;
  detail?: string | null;
}

export interface PickIdOptions {
  /** What is being picked — used in the prompt and the non-TTY error. */
  label: string;
  /** Provided positional/flag value — returned untouched when present. */
  argValue?: string | undefined;
  /** Fetches candidate rows when interactive selection is needed. */
  fetch: () => Promise<PickRow[]>;
  /** Test seams. */
  isTTY?: boolean;
  selectImpl?: typeof prompts.select;
}

function rowLabel(row: PickRow): string {
  const parts: string[] = [];
  if (row.name) parts.push(row.name);
  if (row.detail) parts.push(`(${row.detail})`);
  parts.push(row.id.slice(0, 8));
  return parts.join(" ");
}

/**
 * Resolve an ID: passthrough when supplied; interactive picker in a
 * TTY; the canonical "required" error otherwise.
 */
export async function pickId(opts: PickIdOptions): Promise<string> {
  if (opts.argValue) return opts.argValue;
  const interactive = opts.isTTY ?? (process.stdout.isTTY === true && process.stdin.isTTY === true);
  if (!interactive) {
    throw new Error(`${opts.label} is required`);
  }
  const rows = await opts.fetch();
  if (rows.length === 0) {
    throw new Error(`${opts.label} is required (no candidates found to pick from)`);
  }
  const select = opts.selectImpl ?? prompts.select;
  const choice = await select({
    message: `Select a ${opts.label}`,
    options: rows.map((row) => ({ value: row.id, label: rowLabel(row) })),
  });
  if (prompts.isCancel(choice) || typeof choice !== "string") {
    throw new Error(`${opts.label} is required`);
  }
  return choice;
}
