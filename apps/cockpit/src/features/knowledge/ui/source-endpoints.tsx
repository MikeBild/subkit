import { cn } from "@ui/lib/utils";
import { Search } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/cockpit/patterns/controls";
import {
  type ApiEndpoint,
  matchesEndpoint,
} from "@/features/knowledge/model/knowledge-sources-model";
import { ENDPOINT_METHOD_CLASS } from "@/features/knowledge/model/source-detail-model";
import { useI18n } from "@/lib/i18n-context";
import { NoMatch, Row } from "../shell";

export function SourceEndpoints({
  endpoints,
  onOpen,
}: {
  endpoints: ApiEndpoint[];
  onOpen: (key: string) => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const list = endpoints.filter((e) => matchesEndpoint(e, q));
  return (
    <div className="flex flex-col gap-4">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground"
          aria-hidden
        />
        <Input
          data-testid="kn-sources-endpointSearch"
          aria-label={t("kn.sources.endpointSearch")}
          placeholder={t("kn.sources.endpointSearch")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="pl-8"
        />
      </div>
      <p className="text-sm text-muted-foreground">
        {t("kn.sources.endpointsOf", { n: list.length, total: endpoints.length })}
      </p>
      {list.length ? (
        <div className="overflow-x-auto rounded-lg ring-1 ring-inset ring-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                {[
                  t("kn.sources.ep.method"),
                  t("kn.sources.ep.path"),
                  t("kn.sources.ep.purpose"),
                ].map((h) => (
                  <th
                    key={h}
                    className="h-10 px-3 text-left text-xs font-medium text-muted-foreground first:pl-4 last:pr-4"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.map((e) => (
                <Row
                  key={e.key}
                  testId="kn-sources-endpoint"
                  label={`${e.method} ${e.path}`}
                  onOpen={() => onOpen(e.key)}
                >
                  <td
                    className={cn(
                      "w-24 font-mono text-xs font-semibold",
                      ENDPOINT_METHOD_CLASS[e.method],
                    )}
                  >
                    {e.method}
                  </td>
                  <td className="font-mono text-xs">{e.path}</td>
                  <td className="text-muted-foreground">{e.purpose}</td>
                </Row>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <NoMatch />
      )}
    </div>
  );
}
