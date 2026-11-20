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

export class TaskRunPermissionModeError extends HttpError {
  constructor() {
    super(
      400,
      "task_run_permission_mode_rejected",
      "A task run always asks before it changes something. This mode is not available here.",
    );
    this.name = "TaskRunPermissionModeError";
  }
}

export class TaskRunLockedError extends HttpError {
  constructor(what: string) {
    super(409, "task_run_locked", `${what} is not available in a task run conversation.`);
    this.name = "TaskRunLockedError";
  }
}

export class TaskRunApprovalOwnerOnlyError extends HttpError {
  constructor() {
    super(
      403,
      "task_run_approval_owner_only",
      "Only the owner of this task can decide this: the held changes were prepared in the owner's name. Nothing was changed. Ask the owner to answer, or abort the run.",
    );
    this.name = "TaskRunApprovalOwnerOnlyError";
  }
}
