import { safeStorage } from "electron";
import { readJson, writeJsonAtomic } from "./store.ts";

function entries(path: string): Record<string, string> {
  const raw = readJson(path);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

export class SecretVault {
  constructor(private readonly path: string) {}

  available(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  get(name: string): string | null {
    const sealed = entries(this.path)[name];
    if (!sealed || !this.available()) return null;
    try {
      return safeStorage.decryptString(Buffer.from(sealed, "base64"));
    } catch {
      return null;
    }
  }

  set(name: string, value: string | null): void {
    const all = entries(this.path);
    if (value === null) delete all[name];
    else {
      if (!this.available()) throw new Error("The operating system keychain is not available");
      all[name] = safeStorage.encryptString(value).toString("base64");
    }
    writeJsonAtomic(this.path, all);
  }
}
