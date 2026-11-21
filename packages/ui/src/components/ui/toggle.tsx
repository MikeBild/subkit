import { cn } from "@ui/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";
import { Toggle as TogglePrimitive } from "radix-ui";
import type * as React from "react";

const toggleVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-control text-sm font-medium cursor-pointer transition-colors hover:bg-muted hover:text-muted-foreground disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed data-[state=on]:bg-segment-selected data-[state=on]:text-segment-selected-foreground data-[state=on]:shadow-sm data-[state=on]:inset-ring data-[state=on]:inset-ring-segment-selected-ring [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline:
          "border border-input bg-transparent shadow-sm hover:bg-secondary hover:text-secondary-foreground",
      },
      size: {
        default: "h-10 px-3 min-w-10",
        sm: "h-10 px-2 min-w-10 text-xs",
        lg: "h-10 px-4 min-w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Toggle({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof TogglePrimitive.Root> & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive.Root
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Toggle, toggleVariants };
