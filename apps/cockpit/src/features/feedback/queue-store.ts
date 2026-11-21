export interface QueueStore<Item> {
  readonly kind: "indexeddb" | "memory";
  load(): Promise<Item[]>;
  save(items: readonly Item[]): Promise<void>;
}

export function memoryQueueStore<Item>(): QueueStore<Item> {
  let items: Item[] = [];
  return {
    kind: "memory",
    load: async () => [...items],
    save: async (next) => {
      items = [...next];
    },
  };
}

const STORE = "items";
const RECORD = "queue";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function open(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  const req = factory.open(name, 1);
  req.onupgradeneeded = () => {
    if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
  };
  return request(req);
}

function browserFactory(): IDBFactory | null {
  try {
    return globalThis.indexedDB ?? null;
  } catch {
    return null;
  }
}

export function queueStore<Item>(
  name: string,
  factory: IDBFactory | null = browserFactory(),
): QueueStore<Item> {
  const memory = memoryQueueStore<Item>();
  if (!factory) return memory;
  let db: Promise<IDBDatabase | null> | null = null;
  const database = () => {
    db ??= open(factory, name).catch(() => null);
    return db;
  };
  const withStore = async <T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T | null> => {
    try {
      const handle = await database();
      if (!handle) return null;
      return await request(run(handle.transaction(STORE, mode).objectStore(STORE)));
    } catch {
      return null;
    }
  };
  return {
    kind: "indexeddb",
    load: async () => {
      const stored = await withStore<unknown>("readonly", (store) => store.get(RECORD));
      return Array.isArray(stored) ? (stored as Item[]) : memory.load();
    },
    save: async (items) => {
      await memory.save(items);
      await withStore("readwrite", (store) => store.put([...items], RECORD));
    },
  };
}
