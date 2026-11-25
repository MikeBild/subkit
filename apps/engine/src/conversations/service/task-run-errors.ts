import { HttpError } from "../../http/errors.ts";

export class TaskRunWriteForbiddenError extends HttpError {
  constructor() {
    super(
      403,
      "task_run_write_forbidden",
      "Only the owner of this task or an admin can write in its run conversation.",
    );
    this.name = "TaskRunWriteForbiddenError";
  }
}

export class TaskRunLockedError extends HttpError {
  constructor(what: string) {
    super(409, "task_run_locked", `${what} is not available in a task run conversation.`);
    this.name = "TaskRunLockedError";
  }
}

export class TaskRunApprovalForbiddenError extends HttpError {
  constructor() {
    super(
      403,
      "task_run_approval_owner_only",
      "Only the owner of this task or an admin can decide this. Nothing was changed. Ask one of them to answer, or abort the run.",
    );
    this.name = "TaskRunApprovalForbiddenError";
  }
}

export class TaskRunApprovalUnavailableError extends HttpError {
  constructor() {
    super(
      409,
      "task_run_approval_unavailable",
      "These held changes can no longer be released with the rights of the run: the owner is unavailable, the task is paused or the run ended. Nothing was changed. Abort the run or start it again.",
    );
    this.name = "TaskRunApprovalUnavailableError";
  }
}

/** A conversation the caller may not read: answered as not found so its existence stays hidden. */
export class ConversationHiddenError extends HttpError {
  constructor() {
    super(404, "not_found", "conversation not found");
    this.name = "ConversationHiddenError";
  }
}

export class ConversationReadOnlyError extends HttpError {
  constructor() {
    super(
      403,
      "conversation_read_only",
      "Only the owner writes in this conversation. Fork it to continue on your own.",
    );
    this.name = "ConversationReadOnlyError";
  }
}
