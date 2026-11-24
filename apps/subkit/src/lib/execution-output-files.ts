import type { EngineClient, FileWire } from "../engine-client.ts";
import { collectFileRefs } from "../utils/file-ref.ts";

type ExecutionLike = { id: string; input?: unknown };

const MAX_LINKED_FILE_PAGES = 20;

function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unitIndex]}`;
}

export function outputFileIds(
  execution: ExecutionLike,
  linkedFiles: ReadonlyArray<Pick<FileWire, "id">>,
): string[] {
  const inputFids = new Set(collectFileRefs(execution.input));
  const { input: _input, ...withoutInput } = execution;
  const candidates = [
    ...linkedFiles.map((file) => file.id),
    ...collectFileRefs(withoutInput).filter((fid) => !inputFids.has(fid)),
  ];
  return [...new Set(candidates)];
}

async function listLinkedOutputFiles(
  client: EngineClient,
  executionId: string,
): Promise<FileWire[]> {
  const linkedFiles: FileWire[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LINKED_FILE_PAGES; page++) {
    const res = await client.listFiles({
      linked_to: `workflow_run:${executionId}`,
      ...(cursor ? { cursor } : {}),
    });
    linkedFiles.push(...res.items);
    if (!res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return linkedFiles;
}

export async function executionOutputFileLines(
  client: EngineClient,
  execution: ExecutionLike,
): Promise<string[]> {
  let linkedFiles: FileWire[];
  try {
    linkedFiles = await listLinkedOutputFiles(client, execution.id);
  } catch {
    linkedFiles = [];
  }
  const filesById = new Map(linkedFiles.map((file) => [file.id, file]));
  return Promise.all(
    outputFileIds(execution, linkedFiles).map(async (fid) => {
      const file = filesById.get(fid) ?? (await client.getFile(fid).catch(() => undefined));
      const details = file ? ` (${file.filename}, ${humanBytes(file.size_bytes)})` : "";
      return `${fid}${details} — subkit files download ${fid}`;
    }),
  );
}
