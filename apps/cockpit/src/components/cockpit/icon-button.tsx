import type { ComponentProps, ReactElement, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type IconButtonProps = Omit<
  ComponentProps<typeof Button>,
  "aria-label" | "asChild" | "children" | "data-testid" | "size"
> & {
  label: string;
  children: ReactElement;
  "data-testid": string;
  size?: "icon-xs" | "icon-sm" | "icon" | "icon-lg";
  tooltip?: ReactNode;
};

export function IconButton({
  children,
  label,
  size = "icon-sm",
  tooltip,
  variant = "ghost",
  "data-testid": testId,
  ...props
}: IconButtonProps) {
  const button = (
    <Button aria-label={label} data-testid={testId} size={size} variant={variant} {...props}>
      <span aria-hidden="true" data-icon="icon">
        {children}
      </span>
    </Button>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {props.disabled ? <span className="inline-flex">{button}</span> : button}
      </TooltipTrigger>
      <TooltipContent>{tooltip ?? label}</TooltipContent>
    </Tooltip>
  );
}
