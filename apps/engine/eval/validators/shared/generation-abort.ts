export interface GenerationAbortInput {
  reason: string;
  needs: Array<Record<string, unknown>>;
}

type AbortConstructor = new (abort: GenerationAbortInput) => Error;

export function generationAbortError(
  errorsModule: object,
): ((abort: GenerationAbortInput) => Error) | null {
  const ctor = Reflect.get(errorsModule, "LlmGenerationAborted") as AbortConstructor | undefined;
  if (typeof ctor !== "function") return null;
  return (abort) => new ctor(abort);
}
