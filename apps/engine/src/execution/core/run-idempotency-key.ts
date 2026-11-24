export const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

export const runIdempotencyKeyLength = (idempotencyKey: string): number =>
  Array.from(idempotencyKey).length;

export const isRunIdempotencyKey = (idempotencyKey: string): boolean => {
  const codePointLength = runIdempotencyKeyLength(idempotencyKey);
  return codePointLength >= 1 && codePointLength <= IDEMPOTENCY_KEY_MAX_LENGTH;
};
