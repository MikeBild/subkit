import { cn } from "@ui/lib/utils";
import type { ApiEndpoint } from "@/features/knowledge/model/knowledge-sources-model";
import { ENDPOINT_METHOD_CLASS } from "@/features/knowledge/model/source-detail-model";
import { useI18n } from "@/lib/i18n-context";
import { BackTo } from "./back-to";
import { RawText } from "./raw-text";

export function EndpointDetail({
  endpoint,
  onBack,
}: {
  endpoint: ApiEndpoint;
  onBack: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-4" data-testid="knowledge-endpoint">
      <BackTo label={t("kn.sources.allEndpoints")} onClick={onBack} />
      <p className="flex flex-wrap items-baseline gap-3">
        <span
          className={cn("font-mono text-xs font-semibold", ENDPOINT_METHOD_CLASS[endpoint.method])}
        >
          {endpoint.method}
        </span>
        <span className="break-all font-mono text-sm">{endpoint.path}</span>
      </p>
      {endpoint.purpose && <p className="text-sm text-muted-foreground">{endpoint.purpose}</p>}
      <RawText
        text={JSON.stringify(endpoint.operation, null, 2)}
        label={t("knowledge.raw.label")}
      />
    </div>
  );
}
