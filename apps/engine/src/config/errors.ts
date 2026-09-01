export class ConfigLoaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigLoaderError";
  }
}

export class ScopeViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeViolationError";
  }
}

export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly path: string[],
    public readonly expected: string,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

export class RestartRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestartRequiredError";
  }
}
