import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { emptyStore, parseStore, type StoreData } from "../shared/profiles.ts";

export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

const SAVE_DELAY_MS = 750;

export class ProfileStore {
  private current: StoreData = emptyStore();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly path: string,
    private readonly onError: (error: unknown) => void,
  ) {}

  load(): void {
    this.current = parseStore(readJson(this.path));
  }

  get data(): StoreData {
    return this.current;
  }

  update(change: (data: StoreData) => StoreData, urgent = true): void {
    this.current = change(this.current);
    if (urgent) {
      this.flush();
      return;
    }
    this.timer ??= setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      writeJsonAtomic(this.path, this.current);
    } catch (error) {
      this.onError(error);
    }
  }
}
