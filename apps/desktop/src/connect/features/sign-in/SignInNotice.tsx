import type { SignInModel } from "../../domain/index.ts";
import { SIGN_IN_ERRORS } from "../../domain/index.ts";
import { factRows, type Translate } from "../../lib/text.ts";
import { ErrorNotice, StatusStrip } from "../../ui/index.ts";

export function SignInNotice({ model, t }: { model: SignInModel; t: Translate }) {
  if (model.phase !== "failed") return null;
  const title = t(model.strip.title, model.strip.vars);
  if (model.facts.length === 0) {
    return (
      <StatusStrip tone={model.strip.tone} className="mt-4 mb-0">
        {title}
      </StatusStrip>
    );
  }
  return (
    <ErrorNotice
      testId="signin-failure"
      className="mt-4"
      kind={SIGN_IN_ERRORS[model.error].code}
      tone={model.strip.tone}
      title={title}
      body=""
      rows={factRows(model.facts, t)}
      layout="inline"
    />
  );
}
