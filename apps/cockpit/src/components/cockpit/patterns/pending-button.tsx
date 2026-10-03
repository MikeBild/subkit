import { Loader2 } from "lucide-react";
import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n-context";
import { cn } from "@/lib/utils";

/**
 * A button whose action is under way: the label stays where it is, hidden,
 * and a spinner sits over it — so the button keeps its width and the row it
 * stands in does not shift. It cannot be pressed twice.
 */
export function PendingButton({
  pending,
  disabled,
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "asChild"> & { pending?: boolean }) {
  const { t } = useI18n();
  return (
    <Button
      {...props}
      disabled={disabled || pending}
      aria-busy={pending ? true : undefined}
      data-pending={pending ? "true" : undefined}
      className={cn("relative", className)}
    >
      <span className={cn("inline-flex items-center gap-[inherit]", pending && "invisible")}>
        {children}
      </span>
      {pending ? (
        <span className="absolute inset-0 flex items-center justify-center" role="status">
          <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
          <span className="sr-only">{t("platform.inProgress")}</span>
        </span>
      ) : null}
    </Button>
  );
}
