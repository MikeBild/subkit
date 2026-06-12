// Loop-iteration scope construction — extracted from engine.ts so the
// binding contract has a single owner with focused tests. The canonical
// loop-item bindings are `$item` + `$loop_index`; the bare `item_var`
// name is a per-definition contract: it is bound ONLY when the stored
// definition explicitly declares `item_var` (legacy versions executed
// via version_id keep running unchanged), and new/migrated definitions
// omit the field and address the item as `$item` exclusively.
//
// This conditional binding is a versioned stored-data contract keyed on
// the stored definition — NOT a compatibility flag. A definition
// without `item_var` that references a bare iteration name gets the
// runtime `unresolved_identifier` warning instead of a silent empty
// result, which is exactly the signal the authoring loop repairs from.

import type { LoopStep } from "../workflows/types.ts";

export function buildLoopChildScope(
  loopStep: Pick<LoopStep, "item_var">,
  scope: Record<string, unknown>,
  item: unknown,
  itemIdx: number,
): Record<string, unknown> {
  const declared = typeof loopStep.item_var === "string" && loopStep.item_var.length > 0;
  return {
    ...scope,
    ...(declared ? { [loopStep.item_var as string]: item } : {}),
    $item: item,
    $loop_index: itemIdx,
  };
}
