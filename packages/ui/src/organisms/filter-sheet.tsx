import { useI18n } from "@ui/lib/ui-context";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@ui/organisms/sheet";
import type { ReactNode } from "react";

export function FilterSheet({
  open,
  onOpenChange,
  title,
  footer,
  testId,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  footer?: ReactNode;
  testId?: string | undefined;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        className="w-full max-w-full gap-0 sm:max-w-sm"
        closeLabel={t.common.close}
        data-testid={testId}
      >
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-6">
          {children}
        </div>
        {footer ? (
          <div className="flex items-center justify-between gap-3 border-t px-5 py-4">{footer}</div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
