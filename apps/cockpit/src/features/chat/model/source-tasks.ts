export interface SourceTask {
  readonly id: string;
  readonly name: string;
  readonly source_message_id: string | null;
}

export type MessageTask = Pick<SourceTask, "id" | "name">;

export function tasksBySourceMessage(
  tasks: readonly SourceTask[],
): ReadonlyMap<string, readonly MessageTask[]> {
  const grouped = new Map<string, MessageTask[]>();
  for (const task of tasks) {
    if (!task.source_message_id) continue;
    const list = grouped.get(task.source_message_id) ?? [];
    list.push({ id: task.id, name: task.name });
    grouped.set(task.source_message_id, list);
  }
  return grouped;
}

export function messageIdFromHash(hash: string): string | null {
  const match = /^#message-([0-9a-f-]{36})$/i.exec(decodeURIComponent(hash));
  return match?.[1] ?? null;
}
