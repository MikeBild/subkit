import { cn } from "@ui/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot as SlotPrimitive } from "radix-ui";
import type * as React from "react";

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80",
        outline: "text-foreground",
        ghost: "border-transparent hover:bg-muted hover:text-muted-foreground",
        link: "border-transparent text-primary underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

interface BadgeProps extends React.ComponentProps<"span">, VariantProps<typeof badgeVariants> {
  asChild?: boolean;
  dot?: boolean;
}

function Badge({
  className,
  variant = "default",
  asChild = false,
  dot = false,
  children,
  ...props
}: BadgeProps) {
  const Comp = asChild ? SlotPrimitive.Slot : "span";
  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    >
      {asChild || !dot ? (
        children
      ) : (
        <>
          <span
            aria-hidden="true"
            data-slot="status-dot"
            className="size-1.5 shrink-0 rounded-full bg-current opacity-70"
          />
          {children}
        </>
      )}
    </Comp>
  );
}

export { Badge, type BadgeProps, badgeVariants };
