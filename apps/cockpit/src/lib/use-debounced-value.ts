import { useEffect, useState } from "react";

/**
 * Holds a fast-changing value still for `delay` ms.
 *
 * One place, one number: the catalogue debounced at 300 ms and the runs page
 * did not debounce at all, so the same keystroke reached the engine at two
 * different speeds depending on which list you were reading.
 */
export function useDebouncedValue<T>(value: T, delay = 200): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return settled;
}
