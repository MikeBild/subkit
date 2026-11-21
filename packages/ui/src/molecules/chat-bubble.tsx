import { AppMark } from "@ui/atoms/app-mark";
import { useUi } from "@ui/lib/ui-context";
import { cn } from "@ui/lib/utils";
import type { ReactNode } from "react";

export function ChatBubble({
  children,
  answer = false,
  continued = false,
  className,
}: {
  children: ReactNode;
  answer?: boolean;
  continued?: boolean;
  className?: string | undefined;
}) {
  const { appName } = useUi();
  const bubble = cn(
    "min-w-0 max-w-[75%] rounded-xl px-4 py-3 text-sm leading-5",
    answer ? "bg-accent text-accent-foreground" : "bg-secondary text-foreground",
    className,
  );
  if (answer)
    return (
      <div className={cn("flex justify-end", continued ? "mt-1" : "mt-3")}>
        <div className={bubble}>{children}</div>
      </div>
    );
  return (
    <div className={cn("flex items-start gap-3", continued ? "mt-1" : "mt-3")}>
      {continued ? (
        <span aria-hidden className="w-7 shrink-0" />
      ) : (
        <AppMark size="sm" className="mt-2" />
      )}
      <div className={bubble}>
        {appName && <span className="sr-only">{appName}: </span>}
        {children}
      </div>
    </div>
  );
}
