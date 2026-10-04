import type { TranslationKey } from "@/lib/i18n";

export interface StorageScopePresentation {
  title: TranslationKey;
  detail: TranslationKey;
  values: Record<string, string | number>;
  destructive: boolean;
}

export function presentStorageScope(
  scope: { operation: string; max_bytes: number; max_keys: number; max_deletes?: number },
  formatNumber: (value: number) => string,
): StorageScopePresentation {
  switch (scope.operation) {
    case "PUT":
      return {
        title: "authority.storage.write",
        detail: "authority.storage.writeScope",
        values: { bytes: formatNumber(scope.max_bytes) },
        destructive: false,
      };
    case "LIST":
      return {
        title: "authority.storage.read",
        detail: "authority.storage.listScope",
        values: { count: scope.max_keys },
        destructive: false,
      };
    case "GET":
    case "HEAD":
      return {
        title: "authority.storage.read",
        detail: "authority.storage.readScope",
        values: {},
        destructive: false,
      };
    case "DELETE":
      return {
        title: "authority.storage.delete",
        detail: "authority.storage.deleteScope",
        values: { count: formatNumber(scope.max_deletes ?? 0) },
        destructive: true,
      };
    default:
      return {
        title: "authority.storage.unknown",
        detail: "authority.storage.unknownScope",
        values: { operation: scope.operation },
        destructive: true,
      };
  }
}
