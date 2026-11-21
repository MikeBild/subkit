import { cn } from "@ui/lib/utils";
import type * as React from "react";
import type { ReactNode } from "react";

const base = "animate-pulse rounded-md bg-muted motion-reduce:animate-none";
export const Skel = {
  Line: ({ className }: { className?: string }) => (
    <span aria-hidden className={cn(base, "block h-4 w-full", className)} />
  ),
  Block: ({ className }: { className?: string }) => (
    <span aria-hidden className={cn(base, "block h-24 w-full rounded-xl", className)} />
  ),
  Circle: ({ className }: { className?: string }) => (
    <span aria-hidden className={cn(base, "block size-8 shrink-0 rounded-full", className)} />
  ),
  Row: () => (
    <div aria-hidden className="flex h-12 items-center gap-3 border-b px-3 last:border-b-0">
      <span className={cn(base, "size-7 shrink-0")} />
      <span className={cn(base, "h-4 w-1/3")} />
      <span className={cn(base, "ml-auto h-4 w-20")} />
    </div>
  ),
  Card: ({ className }: { className?: string }) => (
    <div aria-hidden className={cn("rounded-xl border p-6", className)}>
      <div className="flex items-center gap-3">
        <span className={cn(base, "size-8")} />
        <span className={cn(base, "h-4 w-1/2")} />
      </div>
      <span className={cn(base, "mt-4 block h-6 w-1/3")} />
      <span className={cn(base, "mt-3 block h-8 w-full")} />
    </div>
  ),
  Header: () => (
    <div aria-hidden className="mb-6 flex min-h-10 items-center gap-3">
      <span className={cn(base, "size-9")} />
      <div className="flex-1 space-y-2">
        <span className={cn(base, "block h-6 w-1/3")} />
        <span className={cn(base, "block h-4 w-1/2")} />
      </div>
      <span className={cn(base, "h-10 w-28")} />
    </div>
  ),
  Strip: () => <span aria-hidden className={cn(base, "mb-6 block h-10 w-full rounded-lg")} />,
  Connection: () => (
    <div aria-hidden className="flex h-full flex-col justify-center gap-3 rounded-xl border p-4">
      <div className="flex items-center gap-2">
        <span className={cn(base, "size-8")} />
        <span className={cn(base, "h-px flex-1")} />
        <span className={cn(base, "size-6 rounded-full")} />
        <span className={cn(base, "h-px flex-1")} />
        <span className={cn(base, "size-8")} />
      </div>
      <span className={cn(base, "block h-4 w-2/3")} />
    </div>
  ),
};

export function PageSkeleton({
  shape,
}: {
  shape: "list" | "detail" | "overview" | "chat" | "chart";
}) {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">…</span>
      {shape === "detail" ? (
        <>
          <Skel.Line className="mb-3 h-8 w-24" />
          <Skel.Header />
          <Skel.Strip />
          <Skel.Line className="mb-6 h-10 w-80" />
          <Skel.Block className="h-64" />
        </>
      ) : (
        <Skel.Header />
      )}
      {shape === "list" && (
        <>
          <div className="mb-4 flex gap-2">
            <Skel.Line className="h-10 w-64" />
            <Skel.Line className="h-6 w-16 self-center rounded-full" />
            <Skel.Line className="h-6 w-16 self-center rounded-full" />
          </div>
          <div className="rounded-xl border">
            {Array.from({ length: 6 }, (_, i) => (
              <Skel.Row key={i} />
            ))}
          </div>
        </>
      )}
      {shape === "overview" && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skel.Card key={i} />
            ))}
          </div>
          <div className="mt-8 rounded-xl border">
            {Array.from({ length: 3 }, (_, i) => (
              <Skel.Row key={i} />
            ))}
          </div>
        </>
      )}
      {shape === "chart" && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skel.Card key={i} />
            ))}
          </div>
          <Skel.Block className="mt-8 h-56" />
        </>
      )}
      {shape === "chat" && (
        <div className="space-y-3 rounded-xl border p-4">
          {[2, 3, 1].map((w, i) => (
            <div key={i} className={cn("flex gap-3", i === 1 && "justify-end")}>
              {i !== 1 && <Skel.Circle className="size-7 rounded-md" />}
              <Skel.Line
                className={cn("h-12 rounded-xl", w === 3 ? "w-1/2" : w === 2 ? "w-2/3" : "w-1/3")}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function BubbleSkeleton() {
  return (
    <div aria-hidden className="w-64 max-w-full space-y-2 py-0.5">
      <Skel.Line />
      <Skel.Line className="w-5/6" />
      <Skel.Line className="w-2/3" />
    </div>
  );
}

export function FadeIn({ children }: { children: ReactNode }) {
  return <div className="animate-in fade-in duration-200">{children}</div>;
}

export function Skeleton({
  className,
  testId,
  ...props
}: React.ComponentProps<"span"> & { testId?: string | undefined }) {
  return (
    <span
      aria-hidden="true"
      data-slot="skeleton"
      data-testid={testId}
      className={cn(base, "block", className)}
      {...props}
    />
  );
}
