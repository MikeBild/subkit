import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@ui/molecules/card";
import type { ReactNode } from "react";
import { useId } from "react";
import { type Fact, FactList } from "./fact-list";

export function ChatCard({
  title,
  line,
  facts,
  action,
  secondary,
  testId,
  children,
}: {
  title: ReactNode;
  line?: ReactNode;
  facts?: readonly Fact[];
  action: ReactNode;
  secondary?: ReactNode;
  testId?: string;
  children?: ReactNode;
}) {
  const heading = useId();
  const body = (facts && facts.length > 0) || children;
  return (
    <Card data-slot="chat-card" data-testid={testId} role="group" aria-labelledby={heading}>
      <CardHeader>
        <CardTitle id={heading}>{title}</CardTitle>
        {line ? <p className="text-sm text-muted-foreground">{line}</p> : null}
      </CardHeader>
      {body ? (
        <CardContent className="flex flex-col gap-3">
          {facts && facts.length > 0 ? <FactList items={facts} /> : null}
          {children}
        </CardContent>
      ) : null}
      <CardFooter className="flex flex-wrap justify-end gap-2">
        {secondary}
        {action}
      </CardFooter>
    </Card>
  );
}
