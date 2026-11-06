import { useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

export function searchWithParam(
  search: string,
  name: string,
  value: string | null,
  fallback: string,
): string {
  const params = new URLSearchParams(search);
  if (value === null || value === "" || value === fallback) params.delete(name);
  else params.set(name, value);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function readSearchParam(name: string): string | null {
  return typeof window === "undefined"
    ? null
    : new URLSearchParams(window.location.search).get(name);
}

export function writeSearchParam(name: string, value: string | null, fallback: string): void {
  if (typeof window === "undefined") return;
  const search = searchWithParam(window.location.search, name, value, fallback);
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${search}${window.location.hash}`,
  );
}

export function useSearchParamState<T extends string = string>(
  name: string,
  fallback: NoInfer<T>,
  accept: (value: string) => value is T = (value): value is T => value !== "",
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const raw = readSearchParam(name);
    return raw !== null && accept(raw) ? raw : fallback;
  });
  const routed = useRouterState({ select: (state) => state.location.searchStr });
  useEffect(() => {
    void routed;
    const raw = readSearchParam(name);
    const next = raw !== null && accept(raw) ? raw : fallback;
    setValue((current) => (current === next ? current : next));
  }, [routed, name, fallback, accept]);
  const update = useCallback(
    (next: T) => {
      setValue(next);
      writeSearchParam(name, next, fallback);
    },
    [name, fallback],
  );
  return [value, update];
}
