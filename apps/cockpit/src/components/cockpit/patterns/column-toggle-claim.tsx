import { createContext, type ReactNode, useContext, useEffect, useId, useState } from "react";

interface ColumnToggleClaims {
  owner: string | null;
}

const ClaimContext = createContext<ColumnToggleClaims | null>(null);

export function ColumnToggleScope({ children }: { children: ReactNode }) {
  const [claims] = useState<ColumnToggleClaims>(() => ({ owner: null }));
  return <ClaimContext.Provider value={claims}>{children}</ClaimContext.Provider>;
}

function claim(claims: ColumnToggleClaims, id: string): boolean {
  if (claims.owner === null) claims.owner = id;
  return claims.owner === id;
}

export function useColumnToggleClaim(wanted: boolean): boolean {
  const id = useId();
  const claims = useContext(ClaimContext);
  const [owns] = useState(() => !claims || (wanted && claim(claims, id)));
  useEffect(() => {
    if (!claims || !wanted) return;
    claim(claims, id);
    return () => {
      if (claims.owner === id) claims.owner = null;
    };
  }, [claims, id, wanted]);
  return wanted && owns;
}
