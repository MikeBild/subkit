export type EmbeddingRequest =
  | { id: number; kind: "available" }
  | { id: number; kind: "embed"; texts: string[] };

export type EmbeddingResponse =
  | { id: number; kind: "available"; available: boolean }
  | { id: number; kind: "embed"; vectors: number[][] }
  | { id: number; kind: "failed" };
