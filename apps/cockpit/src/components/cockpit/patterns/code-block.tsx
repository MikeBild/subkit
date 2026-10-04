import { Copy } from "lucide-react";
import { IconButton } from "@/components/cockpit/icon-button";
import { useI18n } from "@/lib/i18n-context";
import { useCopy } from "./copy-field";

export function CodeBlock({
  code,
  lang,
  label,
  testId,
}: {
  code: string;
  lang?: string;
  label?: string;
  testId?: string;
}) {
  const { t } = useI18n();
  const copy = useCopy();
  return (
    <div
      data-slot="code-block"
      data-lang={lang}
      data-testid={testId}
      className="relative rounded-lg border bg-muted/40"
    >
      {label ? (
        <div className="border-b px-3 py-1.5 text-xs text-muted-foreground">{label}</div>
      ) : null}
      <pre className="max-h-96 overflow-auto p-3 pr-10 font-mono text-xs leading-5 whitespace-pre">
        <code>{code}</code>
      </pre>
      <IconButton
        label={t("common.copy")}
        size="icon-xs"
        className="absolute right-1.5 bottom-1.5"
        data-testid={`${testId ?? "code-block"}-copy`}
        onClick={() => void copy(code)}
      >
        <Copy />
      </IconButton>
    </div>
  );
}
