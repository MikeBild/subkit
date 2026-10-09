export type CaptureMode = "article" | "selection";

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
}

export interface Draft extends CapturedClip {
  id: string;
  engineUrl: string;
  captureTabId?: number;
  sourceId?: string;
  sourceName?: string;
  path?: string;
  copyPath?: string;
  collectionName?: string;
  collectionSlug?: string;
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
