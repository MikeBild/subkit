// How a reviewed storage folder is described to the person approving it.
//
// The dialog used to label every operation that was not a PUT as "read". When
// removal became grantable, a DELETE boundary fell into that branch: the most
// prominent part of the approval dialog told the human "Read files within this
// folder" for a step that permanently deletes them, and the ceiling they were
// approving was not shown at all. The fine print below said DELETE; the
// headline said read.
//
// So the mapping is explicit per operation and has no "everything else is a
// read" fallback. An operation this table does not know is presented as
// unknown and destructive-styled — a reviewer must never be shown a reassuring
// label for something the dialog cannot actually describe.

import type { TranslationKey } from "@/lib/i18n";

export interface StorageScopePresentation {
  title: TranslationKey;
  detail: TranslationKey;
  /** Interpolated into `detail`. */
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
