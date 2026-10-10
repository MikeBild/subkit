import type { Draft, IntakeSnapshot, IntakeSubmission } from "./types.ts";

export function intakeSubmission(draft: Draft, requestId: string): IntakeSubmission {
  const original = draft.originalCapture || draft;
  const originalSnapshot: IntakeSnapshot = {
    title: original.metadata.title,
    source_url: draft.captureUrl,
    ...(original.metadata.author ? { source_author: original.metadata.author } : {}),
    ...(original.metadata.publishedAt ? { published_at: original.metadata.publishedAt } : {}),
    captured_at: original.metadata.capturedAt,
    body: original.body,
    origin: draft.originalCapture ? "capture" : "restored_draft",
  };
  return {
    client_request_id: requestId,
    ...(draft.category ? { category: draft.category } : {}),
    title: draft.metadata.title,
    source_url: draft.captureUrl,
    ...(originalSnapshot.source_author ? { source_author: originalSnapshot.source_author } : {}),
    ...(originalSnapshot.published_at ? { published_at: originalSnapshot.published_at } : {}),
    captured_at: originalSnapshot.captured_at,
    body: draft.body,
    ...(draft.note?.trim() ? { note: draft.note.trim() } : {}),
    original_snapshot: originalSnapshot,
  };
}
