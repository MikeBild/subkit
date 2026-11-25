import { useEffect, useRef } from "react";

const dirtyForms = new Set<symbol>();

export function hasDirtyForms(): boolean {
  return dirtyForms.size > 0;
}

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
