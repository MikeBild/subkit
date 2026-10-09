export class KnowledgeSourceAddressConflictError extends Error {
  constructor() {
    super("knowledge source address changed while refreshing");
    this.name = "KnowledgeSourceAddressConflictError";
  }
}

export class KnowledgeSourceAddressReadOnlyError extends Error {
  constructor() {
    super("only URL knowledge sources have an editable source address");
    this.name = "KnowledgeSourceAddressReadOnlyError";
  }
}

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

export class KnowledgeVersionAlreadyCurrentError extends Error {
  readonly code = "version_already_current";
  constructor(readonly version: number) {
    super(`version ${version} is already the current content of this knowledge source`);
    this.name = "KnowledgeVersionAlreadyCurrentError";
  }
}
