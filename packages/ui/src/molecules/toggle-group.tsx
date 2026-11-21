"use client";

import { toggleVariants } from "@ui/atoms/toggle";
import { cn } from "@ui/lib/utils";
import type { VariantProps } from "class-variance-authority";
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";
import * as React from "react";

type ToggleGroupLayout = VariantProps<typeof toggleVariants> & {
  spacing?: number;
  orientation?: "horizontal" | "vertical";
};

const ToggleGroupContext = React.createContext<ToggleGroupLayout>({
  size: "default",
  variant: "default",
  spacing: 1,
  orientation: "horizontal",
});

function ToggleGroup({
  className,
  variant,
  size,
  spacing = 1,
  orientation = "horizontal",
  children,
  style,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root> & ToggleGroupLayout) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      data-spacing={spacing}
      data-orientation={orientation}
      orientation={orientation}
      style={{ "--gap": spacing, ...style } as React.CSSProperties}
      className={cn(
        "group/toggle-group flex w-fit items-center gap-[calc(var(--spacing)*var(--gap))] rounded-control data-[orientation=vertical]:flex-col data-[orientation=vertical]:items-stretch",
        className,
      )}
      {...props}
    >
      <ToggleGroupContext.Provider value={{ variant, size, spacing, orientation }}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  );
}

function ToggleGroupItem({
  className,
  children,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item> & VariantProps<typeof toggleVariants>) {
  const context = React.useContext(ToggleGroupContext);
  const itemVariant = context.variant || variant;
  const itemSize = context.size || size;
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      data-variant={itemVariant}
      data-size={itemSize}
      data-spacing={context.spacing}
      className={cn(
        "shrink-0 focus:z-10 focus-visible:z-10 group-data-[spacing=0]/toggle-group:rounded-none group-data-[spacing=0]/toggle-group:first:rounded-l-control group-data-[spacing=0]/toggle-group:last:rounded-r-control",
        toggleVariants({ variant: itemVariant, size: itemSize }),
        className,
      )}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Item>
  );
}

export { ToggleGroup, ToggleGroupItem };
