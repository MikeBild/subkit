import type { ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function StandaloneStatus({
  layout,
  title,
  icon,
  variant = "default",
  testId,
  children,
}: {
  layout: "centered" | "reading";
  title: ReactNode;
  icon?: ReactNode;
  variant?: "default" | "destructive";
  testId?: string;
  children: ReactNode;
}) {
  const notice = (
    <Alert
      className={layout === "centered" ? "max-w-2xl" : undefined}
      variant={variant}
      data-testid={testId}
    >
      {icon}
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
  return layout === "centered" ? (
    <main className="flex min-h-full items-start justify-center bg-background px-4 py-6 md:px-8">
      {notice}
    </main>
  ) : (
    <main className="min-h-full bg-background px-4 py-6 md:px-8">
      <div className="mx-auto max-w-lg py-16">{notice}</div>
    </main>
  );
}
