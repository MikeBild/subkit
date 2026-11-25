import { useEffect, useRef } from "react";

const dirtyForms = new Set<symbol>();

/** True while any mounted form has unsaved changes. */
export function hasDirtyForms(): boolean {
  return dirtyForms.size > 0;
}

/** Registers the calling form as dirty, so a version reload asks before it drops the changes. */
export function useDirtyGuard(dirty: boolean): void {
  const id = useRef(Symbol("form"));
  useEffect(() => {
    const key = id.current;
    if (dirty) dirtyForms.add(key);
    else dirtyForms.delete(key);
    return () => {
      dirtyForms.delete(key);
    };
  }, [dirty]);
}
