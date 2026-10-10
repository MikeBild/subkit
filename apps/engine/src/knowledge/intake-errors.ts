export class IntakeNotFoundError extends Error {
  constructor(kind: "collection" | "item" | "proposal", id: string) {
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
