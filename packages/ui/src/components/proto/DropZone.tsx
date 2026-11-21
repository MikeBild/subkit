import { hasFiles } from "@ui/lib/drag";
import { cn } from "@ui/lib/utils";
import { Upload } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

export function DropZone({
  title,
  hint,
  accept,
  multiple,
  onFiles,
  compact,
  children,
}: {
  title: string;
  hint: string;
  accept?: string;
  multiple?: boolean;
  onFiles: (f: FileList) => void;
  compact?: boolean;
  children?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${title} – ${hint}`}
      onClick={() => input.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          input.current?.click();
        }
      }}
      onDragOver={(e) => {
        if (hasFiles(e)) {
          e.preventDefault();
          e.stopPropagation();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
      }}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-center transition-colors hover:bg-secondary/60 focus-visible:outline-2 focus-visible:outline-ring",
        compact ? "p-6" : "p-8",
        over && "border-primary bg-primary/5",
      )}
    >
      <span className="flex size-12 items-center justify-center rounded-full bg-muted">
        <Upload className="size-5 text-muted-foreground" aria-hidden />
      </span>
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
      {children}
      <input
        ref={input}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        {...(accept ? { accept } : {})}
        {...(multiple ? { multiple } : {})}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}
