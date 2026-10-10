export type CaptureMode = "article" | "selection" | "auto";

export interface ClipMetadata {
  title: string;
  sourceUrl: string;
  author?: string;
  publishedAt?: string;
  capturedAt: string;
}

export interface CapturedClip {
  metadata: ClipMetadata;
  body: string;
  sections?: {
    description?: string;
    transcript?: string;
    transcriptLanguage?: string;
  };
  diagnostics?: CaptureDiagnostic[];
}

export interface CaptureDiagnostic {
  code:
    | "selection_unavailable"
    | "metadata_unavailable"
    | "article_fallback"
    | "main_content_unavailable"
    | "youtube_transcript_unavailable"
    | "youtube_transcript_failed";
  detail?: string;
}

export interface Draft extends CapturedClip {
  id: string;
  engineUrl: string;
  captureUrl: string;
  createdAt: string;
  updatedAt: string;
  writeRevision?: number;
  captureTabId?: number;
  originalCapture?: CapturedClip | undefined;
  note?: string;
  category?: string;
  intakeAttempt?: IntakeSubmission;
  sourceId?: string;
  sourceName?: string;
  path?: string;
  copyPath?: string;
  state: "ready" | "saving" | "failed";
  error?: string | undefined;
  attempt?: WriteAttempt | undefined;
  duplicateVersion?: string | undefined;
}

export interface WriteAttempt {
  operation: "create" | "append" | "replace" | "copy";
  sourceId?: string;
  expectedVersion?: string;
  path: string;
  content: string;
  slug?: string;
}

export interface CaptureError {
  engineUrl?: string;
  message: string;
}

export interface Settings {
  engineUrl?: string;
  apiKey?: string;
  language?: "de" | "en";
}

export interface KnowledgeSource {
  id: string;
  name: string;
  slug: string;
  source_type: string;
  scope: "global" | "workflow";
  version: string;
}

export interface KnowledgeContent {
  knowledge_source_id: string;
  version: string;
  editable: boolean;
  documents: { path: string; content: string }[];
}

export interface IntakeSnapshot {
  title: string;
  source_url: string;
  source_author?: string;
  published_at?: string;
  captured_at: string;
  body: string;
  origin: "capture" | "restored_draft";
}

export interface IntakeSubmission {
  client_request_id: string;
  category?: string;
  title: string;
  source_url: string;
  source_author?: string;
  published_at?: string;
  captured_at: string;
  body: string;
  note?: string;
  original_snapshot: IntakeSnapshot;
}

export interface IntakeItem {
  id: string;
  category: string;
  title: string;
  state: string;
}
