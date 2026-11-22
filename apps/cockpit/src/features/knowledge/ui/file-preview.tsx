import { MarkdownDocument, CodeBlock as SourceCode } from "@ui/organisms/markdown-document";
import { filePreview } from "@/features/knowledge/model/add-source-model";
import { useI18n } from "@/lib/i18n-context";

export function FilePreview({ name, text }: { name: string; text: string | null }) {
  const { t } = useI18n();
  const preview = filePreview(name, text);
  if (preview.kind === "none")
    return <p className="text-sm text-muted-foreground">{t("kn.sources.noPreview")}</p>;
  if (preview.kind === "markdown")
    return <MarkdownDocument text={preview.text} toolbar={false} toc={false} compact />;
  if (preview.kind === "table")
    return (
      <div className="md-doc">
        <div className="md-table">
          <table>
            <tbody>
              {preview.rows.map((r, i) => (
                <tr key={`${i}-${r.join()}`}>
                  {r.map((c, j) =>
                    i === 0 ? <th key={`${j}-${c}`}>{c}</th> : <td key={`${j}-${c}`}>{c}</td>,
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  return <SourceCode code={preview.code} lang={preview.lang} />;
}
