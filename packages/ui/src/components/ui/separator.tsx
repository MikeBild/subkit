import { cn } from "@ui/lib/utils";
import { Separator as SeparatorPrimitive } from "radix-ui";
import type * as React from "react";

function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border",
        orientation === "horizontal" ? "h-[1px] w-full" : "w-[1px] self-stretch",
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
