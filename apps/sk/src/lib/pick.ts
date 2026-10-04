import * as prompts from "@clack/prompts";

export interface PickRow {
  id: string;
  name?: string | null;
  detail?: string | null;
}

export interface PickIdOptions {
  label: string;
  argValue?: string | undefined;
  fetch: () => Promise<PickRow[]>;
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
