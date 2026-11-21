import { Tooltip, TooltipContent, TooltipTrigger } from "@ui/molecules/tooltip";
import { isValidElement, type ReactNode } from "react";
import { Button } from "./button";

export type ActionVariant = "primary" | "outline" | "ghost" | "destructive";

const VARIANT = {
  primary: "default",
  outline: "outline",
  ghost: "ghost",
  destructive: "destructive",
} as const;

export interface ActionSpec {
  label: ReactNode;
  variant?: ActionVariant;
  size?: "default" | "sm";
  onClick?(): void;
  href?: string;
  pending?: boolean;
  disabled?: boolean;
  testId?: string;
  data?: Readonly<Record<`data-${string}`, string>>;
}

export function ActionButton({
  variant = "outline",
  size = "default",
  pending,
  disabled,
  disabledReason,
  onClick,
  type = "button",
  testId,
  data,
  className,
  children,
}: {
  variant?: ActionVariant;
  size?: "default" | "sm";
  pending?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onClick?(): void;
  type?: "button" | "submit";
  testId?: string;
  data?: Readonly<Record<`data-${string}`, string>>;
  className?: string;
  children: ReactNode;
}) {
  const button = (
    <Button
      type={type}
      variant={VARIANT[variant]}
      size={size}
      pending={pending}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className={className}
      {...data}
    >
      {children}
    </Button>
  );
  if (!disabled || !disabledReason) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex" data-testid={testId ? `${testId}-blocked` : undefined}>
          {button}
        </span>
      </TooltipTrigger>
      <TooltipContent>{disabledReason}</TooltipContent>
    </Tooltip>
  );
}

function isSpec(value: unknown): value is ActionSpec {
  return typeof value === "object" && value !== null && !isValidElement(value) && "label" in value;
}

export function renderAction(action: ReactNode | ActionSpec): ReactNode {
  if (!isSpec(action)) return action;
  if (action.href)
    return (
      <Button variant={VARIANT[action.variant ?? "outline"]} size={action.size} asChild>
        <a href={action.href} data-testid={action.testId} {...action.data}>
          {action.label}
        </a>
      </Button>
    );
  return (
    <ActionButton
      variant={action.variant}
      size={action.size}
      pending={action.pending}
      disabled={action.disabled}
      onClick={action.onClick}
      testId={action.testId}
      data={action.data}
    >
      {action.label}
    </ActionButton>
  );
}
