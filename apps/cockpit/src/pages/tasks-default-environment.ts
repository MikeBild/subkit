import { useEffect, useRef } from "react";
import { type SetupEnvironment, useSetup } from "@/api/setup";

export function useTaskEnvironmentDefault(
  fresh: boolean,
  offered: boolean,
  apply: (environment: SetupEnvironment) => void,
): SetupEnvironment | null {
  const personal = useSetup().data?.default_environment;
  const applied = useRef(false);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    if (!fresh || !offered || !personal || applied.current) return;
    applied.current = true;
    applyRef.current(personal);
  }, [fresh, offered, personal]);
  return fresh && offered && personal ? personal : null;
}

export function fromSetup(preselected: SetupEnvironment | null, chosen: SetupEnvironment): boolean {
  return preselected !== null && preselected === chosen;
}
