export type LocalChatVerificationMode = "mock" | "provider";

export function localChatVerificationMode(explicitMock: boolean): LocalChatVerificationMode {
  return explicitMock ? "mock" : "provider";
}

export function assertLocalChatResponseModel(model: unknown, mock: boolean): void {
  if (typeof model !== "string" || !model.trim())
    throw new Error("Local chat response is missing its model identity");
  const mocked = /^mock(?:$|[:/\s-])/i.test(model.trim());
  if (mock !== mocked)
    throw new Error(
      mock ? "Expected a mock provider response" : "Expected a real provider response",
    );
}

export async function cleanupLocalWorkflow(operations: {
  revoke?: () => Promise<void>;
  remove: () => Promise<void>;
}): Promise<string[]> {
  const failures: string[] = [];
  for (const operation of [operations.revoke, operations.remove]) {
    if (!operation) continue;
    try {
      await operation();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return failures;
}

export function redactLocalVerificationError(error: unknown, secrets: Iterable<string>): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [...secrets]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length))
    message = message.replaceAll(secret, "[redacted]");
  return message;
}

export async function finalizeLocalVerification(operations: {
  saveReceipt: (cleanupFailures: readonly string[]) => Promise<void>;
  closeContext: () => Promise<void>;
  closeBrowser: () => Promise<void>;
}): Promise<string[]> {
  const failures: string[] = [];
  for (const [name, operation] of [
    ["Browser context cleanup", operations.closeContext],
    ["Browser cleanup", operations.closeBrowser],
  ] as const) {
    try {
      await operation();
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    await operations.saveReceipt(failures);
  } catch (error) {
    failures.push(`Receipt: ${error instanceof Error ? error.message : String(error)}`);
  }
  return failures;
}
