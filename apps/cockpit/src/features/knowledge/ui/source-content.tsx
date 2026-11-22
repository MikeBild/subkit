import { MarkdownDocument } from "@ui/organisms/markdown-document";
import { Braces, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/cockpit/patterns/controls";
import { sectionTarget } from "@/features/knowledge/model/knowledge";
import { useI18n } from "@/lib/i18n-context";
import { useSearchParamState } from "@/lib/use-search-param-state";
import type { KnowledgeSource } from "../hooks/use-source";
import { useSourceSections } from "../hooks/use-source-sections";
import { BackTo } from "./back-to";
import { EndpointDetail } from "./endpoint-detail";
import { RawText } from "./raw-text";
import { SourceEndpoints } from "./source-endpoints";
import { SourceSections } from "./source-sections";

export function SourceContent({ src }: { src: KnowledgeSource }) {
  const { t } = useI18n();
  const [picked, setPicked] = useSearchParamState("section", "");
  const [raw, setRaw] = useState(false);
  const { loading, sections, endpoints, rawText } = useSourceSections(src);
  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <RefreshCw className="size-4 animate-spin" aria-hidden />
        {t("kn.sources.noSections")}
      </p>
    );
  }
  if (!sections.length)
    return <p className="text-sm text-muted-foreground">{t("kn.sources.empty")}</p>;
  const open = sectionTarget(picked, endpoints, sections);
  const close = () => setPicked("");
  if (open?.kind === "endpoint") return <EndpointDetail endpoint={open.endpoint} onBack={close} />;
  const only = sections.length === 1 ? sections[0] : undefined;
  const section = open?.kind === "section" ? open.section : only;
  return (
    <div className="flex flex-col gap-4">
      <Button
        data-testid="kn-sources-raw"
        variant="ghost"
        size="sm"
        className="-ml-3 self-start"
        aria-pressed={raw}
        onClick={() => setRaw((v) => !v)}
      >
        <Braces className="size-4" aria-hidden />
        {t("knowledge.raw.label")}
      </Button>
      {raw ? (
        <RawText
          text={rawText.text}
          label={t(rawText.truncated ? "knowledge.raw.truncated" : "knowledge.raw.label")}
        />
      ) : endpoints.length ? (
        <SourceEndpoints endpoints={endpoints} onOpen={setPicked} />
      ) : section ? (
        <>
          {sections.length > 1 && <BackTo label={t("kn.sources.allSections")} onClick={close} />}
          <div className="rounded-xl border p-6" data-testid="knowledge-section">
            <MarkdownDocument text={section.content} underTitle={section.title} />
          </div>
        </>
      ) : (
        <SourceSections sections={sections} onOpen={setPicked} />
      )}
    </div>
  );
}
