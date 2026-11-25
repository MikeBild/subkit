import { createContext, type ReactNode, useContext } from "react";
import type { FailureFacts, FailureRemedyKind } from "@/lib/failure-remedy";

/** Where a failure remedy leads. The app supplies its routes, so patterns stay route-free. */
export type RemedyHref = (
  kind: Exclude<FailureRemedyKind, "retry">,
  facts: FailureFacts,
  prompt: string,
) => string | null;

const noRemedyLinks: RemedyHref = () => null;

const RemedyLinksContext = createContext<RemedyHref>(noRemedyLinks);

export function RemedyLinksProvider({ href, children }: { href: RemedyHref; children: ReactNode }) {
  return <RemedyLinksContext.Provider value={href}>{children}</RemedyLinksContext.Provider>;
}

export function useRemedyHref(): RemedyHref {
  return useContext(RemedyLinksContext);
}
