import { cn } from "@ui/lib/utils";
import type { ReactNode } from "react";
import { Page, type PageKind, pageColumn } from "./page";

export function Screen({
  testId,
  kind = "list",
  children,
}: {
  testId: string;
  kind?: PageKind;
  children: ReactNode;
}) {
  return (
    <Page kind="workspace" scroll="page" testId={testId} header={null}>
      <div className={cn("mx-auto w-full px-4 pt-6 sm:px-8", pageColumn(kind))}>{children}</div>
    </Page>
  );
}
