import { safeStorage } from "electron";
import {
  type DeviceVaultDocument,
  type DeviceVaultItemView,
  deviceVaultItems,
  parseDeviceVault,
  putDeviceVaultEntry,
  removeDeviceVaultEntry,
} from "../shared/device-vault-model.ts";
import { readJson, writeJsonAtomic } from "./store.ts";

export class SecretVault {
  constructor(
    private readonly path: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private load(): DeviceVaultDocument {
    return parseDeviceVault(readJson(this.path));
  }

  available(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  get(name: string): string | null {
    const entry = this.load().items[name];
    if (!entry || !this.available()) return null;
    try {
      return safeStorage.decryptString(Buffer.from(entry.sealed, "base64"));
    } catch {
      return null;
    }
  }

  set(name: string, value: string | null): void {
    const document = this.load();
    if (value === null) {
      writeJsonAtomic(this.path, removeDeviceVaultEntry(document, name));
      return;
    }
    if (!this.available()) throw new Error("The operating system keychain is not available");
    const sealed = safeStorage.encryptString(value).toString("base64");
    writeJsonAtomic(this.path, putDeviceVaultEntry(document, name, sealed, this.now()));
  }

  list(): DeviceVaultItemView[] {
    return deviceVaultItems(this.load());
  }
}
