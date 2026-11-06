import type { DraftClock } from "./core/draft.ts";
import * as draftCore from "./core/draft.ts";
import type { DraftDocument, WorkflowDraftDocument } from "./types.ts";

export {
  createEmptyWorkflowDraft,
  hasInProgressWorkflowDraft,
  WORKFLOW_BINDING_TOOL,
} from "./core/draft.ts";

type ClockFree<F> = F extends (now: DraftClock, ...rest: infer A) => unknown ? A : never;

const systemClock: DraftClock = () => new Date().toISOString();

export function createEmptyDraftDocument(
  ...args: ClockFree<typeof draftCore.createEmptyDraftDocument>
): DraftDocument {
  return draftCore.createEmptyDraftDocument(systemClock, ...args);
}

export function refreshDraftSummary(
  ...args: ClockFree<typeof draftCore.refreshDraftSummary>
): DraftDocument {
  return draftCore.refreshDraftSummary(systemClock, ...args);
}

export function normalizeDraftDocument(
  ...args: ClockFree<typeof draftCore.normalizeDraftDocument>
): DraftDocument {
  return draftCore.normalizeDraftDocument(systemClock, ...args);
}

export function getWorkflowDraft(
  ...args: ClockFree<typeof draftCore.getWorkflowDraft>
): WorkflowDraftDocument {
  return draftCore.getWorkflowDraft(systemClock, ...args);
}

export function withWorkflowDraft(
  ...args: ClockFree<typeof draftCore.withWorkflowDraft>
): DraftDocument {
  return draftCore.withWorkflowDraft(systemClock, ...args);
}

export function startNewWorkflowDraft(
  ...args: ClockFree<typeof draftCore.startNewWorkflowDraft>
): DraftDocument {
  return draftCore.startNewWorkflowDraft(systemClock, ...args);
}

export function withConnectorDraft(
  ...args: ClockFree<typeof draftCore.withConnectorDraft>
): DraftDocument {
  return draftCore.withConnectorDraft(systemClock, ...args);
}

export function withAuthoringFocus(
  ...args: ClockFree<typeof draftCore.withAuthoringFocus>
): DraftDocument {
  return draftCore.withAuthoringFocus(systemClock, ...args);
}

export function withJudgeBreaker(
  ...args: ClockFree<typeof draftCore.withJudgeBreaker>
): DraftDocument {
  return draftCore.withJudgeBreaker(systemClock, ...args);
}

export function withLatestPreview(
  ...args: ClockFree<typeof draftCore.withLatestPreview>
): DraftDocument {
  return draftCore.withLatestPreview(systemClock, ...args);
}

export function withConnectorInspection(
  ...args: ClockFree<typeof draftCore.withConnectorInspection>
): DraftDocument {
  return draftCore.withConnectorInspection(systemClock, ...args);
}

export function withWorkflowInspection(
  ...args: ClockFree<typeof draftCore.withWorkflowInspection>
): DraftDocument {
  return draftCore.withWorkflowInspection(systemClock, ...args);
}

export function withConnectorValidation(
  ...args: ClockFree<typeof draftCore.withConnectorValidation>
): DraftDocument {
  return draftCore.withConnectorValidation(systemClock, ...args);
}

export function withWorkflowValidation(
  ...args: ClockFree<typeof draftCore.withWorkflowValidation>
): DraftDocument {
  return draftCore.withWorkflowValidation(systemClock, ...args);
}

export function withConnectorAuthenticated(
  ...args: ClockFree<typeof draftCore.withConnectorAuthenticated>
): DraftDocument {
  return draftCore.withConnectorAuthenticated(systemClock, ...args);
}

export function withConnectorProbe(
  ...args: ClockFree<typeof draftCore.withConnectorProbe>
): DraftDocument {
  return draftCore.withConnectorProbe(systemClock, ...args);
}

export function withConnectorPersisted(
  ...args: ClockFree<typeof draftCore.withConnectorPersisted>
): DraftDocument {
  return draftCore.withConnectorPersisted(systemClock, ...args);
}

export function withWorkflowPersisted(
  ...args: ClockFree<typeof draftCore.withWorkflowPersisted>
): DraftDocument {
  return draftCore.withWorkflowPersisted(systemClock, ...args);
}

export function withWorkflowSaveError(
  ...args: ClockFree<typeof draftCore.withWorkflowSaveError>
): DraftDocument {
  return draftCore.withWorkflowSaveError(systemClock, ...args);
}

export function bindPersistedWorkflow(
  ...args: ClockFree<typeof draftCore.bindPersistedWorkflow>
): DraftDocument {
  return draftCore.bindPersistedWorkflow(systemClock, ...args);
}

export function withWorkflowExecution(
  ...args: ClockFree<typeof draftCore.withWorkflowExecution>
): DraftDocument {
  return draftCore.withWorkflowExecution(systemClock, ...args);
}

export function withFocusedExecution(
  ...args: ClockFree<typeof draftCore.withFocusedExecution>
): DraftDocument {
  return draftCore.withFocusedExecution(systemClock, ...args);
}

export function withWorkflowDiagnosis(
  ...args: ClockFree<typeof draftCore.withWorkflowDiagnosis>
): DraftDocument {
  return draftCore.withWorkflowDiagnosis(systemClock, ...args);
}
