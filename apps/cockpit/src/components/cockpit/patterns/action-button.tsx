import { isValidElement, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { PendingButton } from "./pending-button";

/**
 * The action grammar a page may use (§5): `primary` is the one filled action
 * of a page or a state, `outline` every visible secondary one, `destructive`
 * a removal. Pages take buttons from here, never from the primitives.
 */
export type ActionVariant = "primary" | "outline" | "ghost" | "destructive";

const VARIANT = {
  primary: "default",
  outline: "outline",
  ghost: "ghost",
  destructive: "destructive",
} as const;

/** An action stated as data, for the `action` slot of `PageHeader` and `StatusStrip`. */
export interface ActionSpec {
  label: ReactNode;
  variant?: ActionVariant;
  onClick?(): void;
  /** A link instead of a button: the address, router-absolute. */
  href?: string;
  pending?: boolean;
  disabled?: boolean;
  testId?: string;
  data?: Readonly<Record<`data-${string}`, string>>;
}

/** One button in the action grammar, with the pending state built in. */
export function ActionButton({
  variant = "outline",
  size = "default",
  pending,
  disabled,
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
  onClick?(): void;
  type?: "button" | "submit";
  testId?: string;
  data?: Readonly<Record<`data-${string}`, string>>;
  className?: string;
  children: ReactNode;
}) {
  return (
    <PendingButton
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
    </PendingButton>
  );
}

function isSpec(value: unknown): value is ActionSpec {
  return typeof value === "object" && value !== null && !isValidElement(value) && "label" in value;
}

/** A slot's action: an element as given, or a spec drawn as an `ActionButton`. */
export function renderAction(action: ReactNode | ActionSpec): ReactNode {
  if (!isSpec(action)) return action;
  if (action.href)
    return (
      <Button variant={VARIANT[action.variant ?? "outline"]} asChild>
        <a href={action.href} data-testid={action.testId} {...action.data}>
          {action.label}
        </a>
      </Button>
    );
  return (
    <ActionButton
      variant={action.variant}
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
