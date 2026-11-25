import { tooOldCopy } from "../../../shared/server-too-old.ts";
import type { Command, NoticeAction, Problem, Screen } from "../../domain/index.ts";
import { SIGN_IN_ERRORS } from "../../domain/index.ts";
import type { Translate } from "../../lib/text.ts";

type ConnectScreen = Extract<Screen, { kind: "connect" }>;

export interface ConnectActions {
  setUrl: (url: string) => void;
  check: (url: string) => void;
  next: (() => void) | undefined;
  act: (action: NoticeAction) => void;
  back: (() => void) | undefined;
  startLocal: () => void;
}

export function connectActions(
  s: ConnectScreen,
  dispatch: (command: Command) => void,
): ConnectActions {
  return {
    setUrl: (address) => dispatch({ type: "EditAddress", address }),
    check: (address) => dispatch({ type: "CheckServer", address }),
    next: s.canContinue ? () => dispatch({ type: "ContinueToSignIn" }) : undefined,
    act: (action) => dispatch({ type: "ActOnNotice", action }),
    back: s.back ? () => dispatch({ type: "GoBack" }) : undefined,
    startLocal: () => dispatch({ type: "StartLocalSetup" }),
  };
}

export function problemCode(problem: Problem): string {
  return SIGN_IN_ERRORS[problem.error].code;
}

export type AskOutcome = "idle" | "copied" | "failed";

export const askAdmin = (
  message: string,
  copyText: (text: string) => Promise<boolean>,
): Promise<AskOutcome> =>
  copyText(message).then(
    (copied): AskOutcome => (copied ? "copied" : "failed"),
    (): AskOutcome => "failed",
  );

export const askLine = (outcome: AskOutcome, t: Translate): string | null =>
  outcome === "copied" ? t("notice.asked") : outcome === "failed" ? t("notice.askFailed") : null;

export function adminMessage(problem: Problem, t: Translate): string | null {
  return problem.ask ? tooOldCopy(problem.ask, t).message : null;
}
