export class IntakeNotFoundError extends Error {
  constructor(
    kind:
      | "collection"
      | "item"
      | "proposal"
      | "skill"
      | "connector"
      | "workflow"
      | "knowledge_source",
    id: string,
  ) {
    super(`${kind} '${id}' was not found`);
    this.name = "IntakeNotFoundError";
  }
}

export class IntakeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakeConflictError";
  }
}

export class IntakeProposalConflictError extends IntakeConflictError {
  constructor(message: string) {
    super(message);
    this.name = "IntakeProposalConflictError";
  }
}

export class IntakeSecondPersonRequiredError extends Error {
  constructor() {
    super(
      "this workspace asks for a second person: someone other than the author must confirm this proposal",
    );
    this.name = "IntakeSecondPersonRequiredError";
  }
}

export class IntakeConfirmationActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakeConfirmationActorError";
  }
}
