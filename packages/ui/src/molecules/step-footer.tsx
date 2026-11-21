import { Button } from "@ui/atoms/button";
import { cn } from "@ui/lib/utils";
import { createContext, useContext } from "react";
import { createPortal } from "react-dom";

export const FooterSlot = createContext<HTMLDivElement | null>(null);

export function StepFooter({
  next,
  disabled = false,
  label,
  skip,
  skipLabel,
  backOnly = false,
  back,
  backLabel,
  nextLabel,
  testId = "step",
}: {
  next?: (() => void) | undefined;
  disabled?: boolean;
  label?: string | undefined;
  skip?: (() => void) | undefined;
  skipLabel?: string | undefined;
  backOnly?: boolean;
  back?: (() => void) | undefined;
  backLabel: string;
  nextLabel: string;
  testId?: string;
}) {
  const slot = useContext(FooterSlot);
  const footer = (
    <footer className="flex flex-wrap items-center justify-between gap-2">
      <Button
        data-testid={`${testId}-back`}
        variant="ghost"
        onClick={back}
        className={cn(!back && "invisible")}
        tabIndex={back ? undefined : -1}
        aria-hidden={!back}
      >
        {backLabel}
      </Button>
      {!backOnly && (
        <div className="ml-auto flex flex-wrap gap-2">
          {skip && skipLabel && (
            <Button data-testid={`${testId}-skip`} variant="ghost" onClick={skip}>
              {skipLabel}
            </Button>
          )}
          <Button data-testid={`${testId}-next`} disabled={disabled || !next} onClick={next}>
            {label ?? nextLabel}
          </Button>
        </div>
      )}
    </footer>
  );
  return slot ? createPortal(footer, slot) : footer;
}
