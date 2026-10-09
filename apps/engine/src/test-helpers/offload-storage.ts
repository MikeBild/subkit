import { getConfig, isConfigLoaded, setConfigKey } from "../config/loader.ts";
import { MemoryObjectStore, setObjectStoreForTesting } from "../storage/object-store.ts";

export interface MemoryOffloadStorage {
  store: MemoryObjectStore;
  restore(): Promise<void>;
}

export const OFFLOAD_TEST_BUCKET = "test";

const BUCKET_KEY = "storage.object_store.bucket";

export async function useMemoryOffloadStorage(): Promise<MemoryOffloadStorage> {
  const store = new MemoryObjectStore();
  setObjectStoreForTesting(store);
  const priorBucket = isConfigLoaded() ? getConfig().storage.object_store.bucket : null;
  if (priorBucket !== null) {
    await setConfigKey(BUCKET_KEY, OFFLOAD_TEST_BUCKET, { force: true });
  }
  return {
    store,
    restore: async () => {
      if (priorBucket !== null && isConfigLoaded()) {
        await setConfigKey(BUCKET_KEY, priorBucket, { force: true });
      }
      setObjectStoreForTesting(null);
    },
  };
}
