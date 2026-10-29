import { ConflictError } from "../http/errors.ts";

export class KnowledgeSourceSlugTakenError extends ConflictError {
  constructor(readonly slug: string) {
    super(`a knowledge source with slug "${slug}" already exists; choose a different slug`, {
      slug,
    });
    this.name = "KnowledgeSourceSlugTakenError";
  }
}

export function isKnowledgeSlugViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const e = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (e.code === "23505" && e.constraint === "knowledge_sources_tenant_slug_key") return true;
    current = e.cause;
  }
  return false;
}

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

export class KnowledgeBundleRequiredError extends Error {
  constructor(readonly source_type: string) {
    super("knowledge source must be a bundle");
    this.name = "KnowledgeBundleRequiredError";
  }
}

export class KnowledgeDocumentPathExistsError extends Error {
  constructor(readonly path: string) {
    super("knowledge document path already exists");
    this.name = "KnowledgeDocumentPathExistsError";
  }
}

export class KnowledgeDocumentPathInvalidError extends Error {
  constructor() {
    super("knowledge document path is invalid");
    this.name = "KnowledgeDocumentPathInvalidError";
  }
}

export class KnowledgeBundleDocumentLimitError extends Error {
  constructor(readonly max_documents: number) {
    super(`knowledge bundle cannot contain more than ${max_documents} documents`);
    this.name = "KnowledgeBundleDocumentLimitError";
  }
}

export class KnowledgeVersionAlreadyCurrentError extends Error {
  readonly code = "version_already_current";
  constructor(readonly version: number) {
    super(`version ${version} is already the current content of this knowledge source`);
    this.name = "KnowledgeVersionAlreadyCurrentError";
  }
}
