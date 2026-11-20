import { Upload } from "lucide-react";
import { type DragEvent, useId, useState } from "react";
import { reportFailure } from "@/lib/action-failure";
import { LOCALE_TAGS } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";
import { fileRefusal, formatBytes } from "./file-kinds";

export function FileDrop({
  onFiles,
  accept,
  maxBytes,
  multiple = false,
  disabled,
  label,
  hint,
  compact = false,
  testId,
}: {
  onFiles(files: File[]): void;
  accept?: string;
  maxBytes?: number;
  multiple?: boolean;
  disabled?: boolean;
  label?: string;
  hint?: string;
  compact?: boolean;
  testId?: string;
}) {
  const { t, locale } = useI18n();
  const inputId = useId();
  const [over, setOver] = useState(false);

  const take = (list: FileList | null) => {
    const files = [...(list ?? [])].slice(0, multiple ? undefined : 1);
    const taken: File[] = [];
    for (const file of files) {
      const refusal = fileRefusal(file, { accept, maxBytes });
      if (refusal === "size" && maxBytes !== undefined)
        reportFailure(
          t("platform.file.tooLarge", {
            name: file.name,
            max: formatBytes(maxBytes, LOCALE_TAGS[locale]),
          }),
        );
      else if (refusal === "type") reportFailure(t("platform.file.wrongType", { name: file.name }));
      else taken.push(file);
    }
    if (taken.length > 0) onFiles(taken);
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setOver(false);
    if (!disabled) take(event.dataTransfer.files);
  };

  return (
    <label
      htmlFor={inputId}
      data-slot="file-drop"
      data-testid={testId}
      data-dragging={over ? "true" : undefined}
      aria-disabled={disabled ? true : undefined}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-lg border border-dashed text-sm text-muted-foreground transition-colors duration-(--sk-dur-fast) focus-within:ring-2 focus-within:ring-ring hover:bg-muted/40",
        compact ? "min-h-10 px-3 py-2" : "flex-col justify-center px-4 py-8 text-center",
        over && "border-accent bg-accent/5 text-foreground",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      <Upload aria-hidden="true" className="size-5 shrink-0" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium text-foreground">{label ?? t("platform.file.drop")}</span>
        {hint ? <span className="text-xs">{hint}</span> : null}
      </span>
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
