export class KnowledgeVersionConflictError extends Error {
  constructor(
    readonly expected_version: string,
    readonly current_version: string,
  ) {
    super("knowledge source version changed");
    this.name = "KnowledgeVersionConflictError";
  }
}

export class KnowledgeContentReadOnlyError extends Error {
  constructor() {
    super("knowledge source content is read-only");
    this.name = "KnowledgeContentReadOnlyError";
  }
}
