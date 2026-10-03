import { createContext, type ReactNode, useContext, useEffect, useId, useState } from "react";

/**
 * A page shows the "Spalten" column picker at most once: two tables on one
 * page would otherwise each carry the same action. The first table that can
 * hide a column claims it; the others leave it out.
 */
interface ColumnToggleClaims {
  owner: string | null;
}

const ClaimContext = createContext<ColumnToggleClaims | null>(null);

/** One claim per page; `Page` provides it. */
export function ColumnToggleScope({ children }: { children: ReactNode }) {
  const [claims] = useState<ColumnToggleClaims>(() => ({ owner: null }));
  return <ClaimContext.Provider value={claims}>{children}</ClaimContext.Provider>;
}

function claim(claims: ColumnToggleClaims, id: string): boolean {
  if (claims.owner === null) claims.owner = id;
  return claims.owner === id;
}

/**
 * Whether this table shows the column picker. Outside a page (a test, an
 * isolated render) every table that wants one keeps it.
 */
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
