export interface TaskSource {
  readonly conversation_id: string;
  readonly message_id: string;
}

export interface TaskSourceCandidate {
  readonly id: string;
  readonly role: string;
  readonly created_at: Date;
}

export function taskSourceMessageId(
  messages: readonly TaskSourceCandidate[],
  askedAt: Date,
): string | null {
  let source: TaskSourceCandidate | null = null;
  for (const message of messages) {
    if (message.role !== "user" || message.created_at.getTime() > askedAt.getTime()) continue;
    if (source === null || message.created_at.getTime() >= source.created_at.getTime())
      source = message;
  }
  return source?.id ?? null;
}

export function taskSource(
  conversation_id: string | null,
  message_id: string | null,
): TaskSource | null {
  return conversation_id && message_id ? { conversation_id, message_id } : null;
}
