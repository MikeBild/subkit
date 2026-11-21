import {
  APICallError,
  NoObjectGeneratedError,
  NoSuchToolError,
  ToolChoiceViolationError,
} from "ai";

export type ProviderCallError = APICallError;
export type ToolChoiceViolation = ToolChoiceViolationError;

export function isProviderCallError(error: unknown): error is ProviderCallError {
  return APICallError.isInstance(error);
}

export function isNoObjectGenerated(error: unknown): error is NoObjectGeneratedError {
  return NoObjectGeneratedError.isInstance(error);
}

export function isNoSuchTool(error: unknown): error is NoSuchToolError {
  return NoSuchToolError.isInstance(error);
}

export function isToolChoiceViolation(error: unknown): error is ToolChoiceViolation {
  return ToolChoiceViolationError.isInstance(error);
}
