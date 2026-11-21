import {
  SheetContent as UiSheetContent,
  SheetFooter as UiSheetFooter,
  SheetHeader as UiSheetHeader,
} from "@ui/components/ui/sheet";
import type * as React from "react";
import { cn } from "@/lib/utils";

function SheetContent({ className, ...props }: React.ComponentProps<typeof UiSheetContent>) {
  return (
    <UiSheetContent
      className={cn(
        "p-0 data-[side=bottom]:pb-[env(safe-area-inset-bottom)] data-[side=left]:pt-[env(safe-area-inset-top)] data-[side=left]:pb-[env(safe-area-inset-bottom)] data-[side=left]:pl-[env(safe-area-inset-left)] data-[side=right]:pt-[env(safe-area-inset-top)] data-[side=right]:pr-[env(safe-area-inset-right)] data-[side=right]:pb-[env(safe-area-inset-bottom)] data-[side=top]:pt-[env(safe-area-inset-top)]",
        className,
      )}
      {...props}
    />
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<typeof UiSheetHeader>) {
  return <UiSheetHeader className={cn("gap-0.5 p-4", className)} {...props} />;
}

function SheetFooter({ className, ...props }: React.ComponentProps<typeof UiSheetFooter>) {
  return <UiSheetFooter className={cn("p-4", className)} {...props} />;
}

export {
  Sheet,
  SheetClose,
  SheetDescription,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
} from "@ui/components/ui/sheet";
export { SheetContent, SheetFooter, SheetHeader };
