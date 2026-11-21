import { hasFiles } from "@ui/lib/drag";
import { cn } from "@ui/lib/utils";
import { Upload } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

export function DropZone({
  title,
  hint,
  accept,
  multiple = false,
  disabled = false,
  compact = false,
  testId,
  onFiles,
  children,
}: {
  title: string;
  hint?: string | undefined;
  accept?: string | undefined;
  multiple?: boolean;
  disabled?: boolean | undefined;
  compact?: boolean;
  testId?: string | undefined;
  onFiles: (files: File[]) => void;
  children?: ReactNode;
}) {
  const inputId = useId();
  const [over, setOver] = useState(false);
  const take = (list: FileList | null) => {
    const files = [...(list ?? [])].slice(0, multiple ? undefined : 1);
    if (files.length > 0) onFiles(files);
  };
  return (
    <label
      htmlFor={inputId}
      data-slot="drop-zone"
      data-testid={testId}
      data-dragging={over ? "true" : undefined}
      aria-disabled={disabled ? true : undefined}
      onDragOver={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        if (!disabled) take(event.dataTransfer.files);
      }}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-center transition-colors focus-within:outline-2 focus-within:outline-ring hover:bg-secondary/60",
        compact ? "p-6" : "p-8",
        over && "border-primary bg-primary/5",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      <span className="flex size-12 items-center justify-center rounded-full bg-muted">
        <Upload className="size-5 text-muted-foreground" aria-hidden />
      </span>
      <span className="text-sm font-medium">{title}</span>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      {children}
      <input
        id={inputId}
        type="file"
        className="sr-only"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        data-testid={testId ? `${testId}-input` : undefined}
        onChange={(event) => {
          take(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
    </label>
  );
}
