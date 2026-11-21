import { cn } from "@ui/lib/utils";
import { Switch as SwitchPrimitives } from "radix-ui";
import type * as React from "react";

function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitives.Root> & { size?: "sm" | "default" }) {
  return (
    <SwitchPrimitives.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch relative inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors after:absolute after:-inset-x-3 after:-inset-y-2 pointer-coarse:after:-inset-y-3.5 disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-5 data-[size=default]:w-9 data-[size=sm]:h-4 data-[size=sm]:w-7 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
        className,
      )}
      {...props}
    >
      <SwitchPrimitives.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block rounded-full bg-background shadow-lg ring-0 transition-transform group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 group-data-[size=default]/switch:data-[state=checked]:translate-x-4 group-data-[size=sm]/switch:data-[state=checked]:translate-x-3 data-[state=unchecked]:translate-x-0"
      />
    </SwitchPrimitives.Root>
  );
}

export { Switch };
