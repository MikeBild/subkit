import { Button } from "@ui/atoms/button";
import { Checkbox } from "@ui/atoms/checkbox";
import { Label } from "@ui/atoms/label";
import { Textarea } from "@ui/atoms/textarea";
import { Alert, AlertDescription, AlertTitle } from "@ui/molecules/alert";
import { BusyButton } from "@ui/molecules/busy-button";
import { CircleCheck, Copy, Download, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { REPORT_MESSAGE_MAX, type ReportView } from "../../../shared/problem-report.ts";
import { useSignIn } from "../../adapter/index.ts";
import { type ReportNotice, reportModel } from "./report-model.ts";

function Notice({ notice }: { notice: ReportNotice }) {
  const { t } = useSignIn();
  const Icon = notice.tone === "success" ? CircleCheck : TriangleAlert;
  return (
    <Alert
      data-testid={`report-notice-${notice.tone}`}
      role={notice.tone === "success" ? "status" : "alert"}
      variant={notice.tone === "danger" ? "destructive" : "default"}
      className="mt-3"
    >
      <Icon className="size-4" aria-hidden />
      <AlertTitle>{t(notice.title, notice.vars)}</AlertTitle>
      <AlertDescription>
        <p>{t(notice.body, notice.vars)}</p>
        {notice.reference && (
          <p data-testid="report-reference" className="mt-1">
            {t(notice.reference.label)}:{" "}
            <span className="select-all font-mono text-xs">{notice.reference.value}</span>
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}

export function Report({ report }: { report: ReportView }) {
  const { main, t, dispatch } = useSignIn();
  const [message, setMessage] = useState("");
  const [attach, setAttach] = useState(report.attachDefault);
  const model = reportModel(report, main?.locale ?? "en");
  const submit = () => dispatch({ type: "SubmitReport", input: { message, attach } });
  return (
    <div className="flex flex-col">
      <h1 className="text-2xl font-semibold">{t("report.title")}</h1>
      {model.lead && (
        <p className="mt-2 text-sm text-muted-foreground">{t(model.lead.key, model.lead.vars)}</p>
      )}
      {model.notice && <Notice notice={model.notice} />}
      {model.form && (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="report-message">{t("report.description")}</Label>
            <Textarea
              data-testid="report-message"
              id="report-message"
              rows={4}
              maxLength={REPORT_MESSAGE_MAX}
              value={message}
              disabled={model.sending}
              placeholder={t("report.description.placeholder")}
              aria-describedby="report-message-hint"
              onChange={(e) => setMessage(e.target.value)}
            />
            <p id="report-message-hint" className="text-xs text-muted-foreground">
              {t("report.description.hint")}
            </p>
          </div>
          <div className="flex items-start gap-2">
            <Checkbox
              data-testid="report-attach"
              id="report-attach"
              className="mt-0.5"
              checked={attach}
              disabled={model.sending}
              aria-describedby="report-attach-hint"
              onCheckedChange={(value) => setAttach(value === true)}
            />
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="report-attach">{t("report.attach")}</Label>
              <p id="report-attach-hint" className="text-xs text-muted-foreground">
                {t("report.attach.hint")}
              </p>
            </div>
          </div>
          {attach && report.preview.length > 0 && (
            <details
              data-testid="report-preview"
              open={model.notice === null}
              className="rounded-control border px-3 py-2 text-xs"
            >
              <summary className="cursor-pointer font-semibold">{t("report.preview")}</summary>
              <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                {report.preview.map((fact) => (
                  <div key={fact.label} className="contents">
                    <dt className="text-muted-foreground">{t(fact.label)}</dt>
                    <dd className="min-w-0 truncate font-mono">{fact.value}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-1 text-xs text-muted-foreground">{t("report.preview.more")}</p>
            </details>
          )}
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          data-testid="report-copy"
          variant="outline"
          size="sm"
          onClick={() => dispatch({ type: "CopyDiagnostics" })}
        >
          <Copy className="size-4" aria-hidden />
          {t("report.copy")}
        </Button>
        <Button
          data-testid="report-save"
          variant="outline"
          size="sm"
          onClick={() => dispatch({ type: "SaveDiagnostics" })}
        >
          <Download className="size-4" aria-hidden />
          {t("report.save")}
        </Button>
      </div>
      <footer className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <Button
          data-testid="report-close"
          variant="ghost"
          onClick={() => dispatch({ type: "CloseReport" })}
        >
          {t(model.close)}
        </Button>
        {model.send && (
          <BusyButton
            data-testid="report-send"
            busy={model.sending}
            busyLabel={t("report.sending")}
            onClick={submit}
          >
            {t(model.send)}
          </BusyButton>
        )}
      </footer>
    </div>
  );
}
