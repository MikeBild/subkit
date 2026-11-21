import type { ReactNode } from "react";

export function CenteredColumn({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-lg py-16">{children}</div>;
}
