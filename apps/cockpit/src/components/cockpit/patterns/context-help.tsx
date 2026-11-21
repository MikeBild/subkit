import { IconButton } from "@ui/molecules/icon-button";
import { CircleHelp } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

export function ContextHelp({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const descriptionId = useId();
  return (
    <>
      <IconButton
        type="button"
        variant="ghost"
        size="icon-sm"
        label={label}
        tooltip={<span className="max-w-72 text-pretty">{children}</span>}
        tooltipOpen={open}
        onTooltipOpenChange={setOpen}
        {...(open ? {} : { "aria-describedby": descriptionId })}
        data-testid={testId}
        className="shrink-0 text-muted-foreground"
        onPointerDown={(event) => {
          if (event.pointerType !== "touch") return;
          event.preventDefault();
          setOpen((current) => !current);
        }}
        onClick={(event) => {
          if ((event.nativeEvent as PointerEvent).pointerType === "touch") event.preventDefault();
        }}
      >
        <CircleHelp />
      </IconButton>
      {open ? null : (
        <span id={descriptionId} hidden data-help-description="">
          {children}
        </span>
      )}
    </>
  );
}
