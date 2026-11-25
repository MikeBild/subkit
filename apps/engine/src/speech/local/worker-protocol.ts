export type WhisperRequest = {
  readonly id: number;
  readonly kind: "transcribe";
  readonly dir: string;
  readonly samples: Float32Array;
  readonly language?: string | undefined;
};

export type WhisperResponse =
  | { readonly id: number; readonly kind: "text"; readonly text: string }
  | { readonly id: number; readonly kind: "failed"; readonly reason: string };
