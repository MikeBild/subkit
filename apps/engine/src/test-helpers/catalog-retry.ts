import { CatalogVocabularyBusyError } from "../db/catalog-vocabulary.ts";
import { waitFor } from "./determinism/wait.ts";

export async function retryCatalogConflict<T>(operation: () => Promise<T>): Promise<T> {
  let result: { value: T } | undefined;
  await waitFor(
    async () => {
      try {
        result = { value: await operation() };
        return true;
      } catch (error) {
        if (error instanceof CatalogVocabularyBusyError) return false;
        throw error;
      }
    },
    { tries: 200, sleepMs: 5, label: "catalog conflict retried" },
  );
  if (!result) throw new Error("operation did not produce an outcome");
  return result.value;
}
