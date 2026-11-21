import { ErrorNotice, type Remedy } from "@ui/components/proto/ErrorNotice";
import { VersionChips } from "@ui/components/proto/VersionChips";
import { ConnectionGraphic, IconTile, SubKitMark } from "@ui/components/proto/visual";
import { Laptop, LockKeyhole } from "lucide-react";

export function ConnectionOk({ title, chip }: { title: string; chip: string | null }) {
  return (
    <div className="connection-result flex flex-col gap-1.5">
      <ConnectionGraphic
        className="p-3"
        tone="success"
        via={LockKeyhole}
        from={<IconTile icon={Laptop} size="md" variant="outline" />}
        to={<SubKitMark size="md" />}
        state={title}
      />
      {chip && (
        <div className="flex flex-wrap items-center gap-2">
          <VersionChips chips={[{ text: chip, tone: "success" }]} />
        </div>
      )}
    </div>
  );
}

export interface ConnectionProblemProps {
  tone: "warning" | "danger";
  code: string;
  meta: string;
  title: string;
  body: string;
  rows: [string, string][];
  primary: Remedy;
  secondary: Remedy | null;
}

export function ConnectionProblem(props: ConnectionProblemProps) {
  const { tone, code, meta, title, body, rows, primary, secondary } = props;
  return (
    <ErrorNotice
      tone={tone}
      kind={code}
      meta={meta || undefined}
      title={title}
      body={body}
      rows={rows}
      testId="connect-problem"
      layout="inline"
      primary={primary}
      secondary={secondary ?? undefined}
    />
  );
}
