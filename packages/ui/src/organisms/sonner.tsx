import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

function safeOffset(space: string) {
  return {
    top: `calc(${space} + env(safe-area-inset-top))`,
    right: `calc(${space} + env(safe-area-inset-right))`,
    bottom: `calc(${space} + env(safe-area-inset-bottom))`,
    left: `calc(${space} + env(safe-area-inset-left))`,
  };
}

const SAFE_OFFSET = safeOffset("24px");
const SAFE_MOBILE_OFFSET = safeOffset("16px");

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      className="toaster group"
      offset={SAFE_OFFSET}
      mobileOffset={SAFE_MOBILE_OFFSET}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
