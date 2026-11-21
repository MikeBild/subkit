import { createContext, useContext } from "react";
import type { Bootstrap } from "@/api/client";

export const SessionContext = createContext<Bootstrap | null>(null);

export function useOptionalSession(): Bootstrap | null {
  return useContext(SessionContext);
}
