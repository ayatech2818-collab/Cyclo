/**
 * Application-level error codes for employee operations.
 *
 * Database errors are mapped to these codes so raw SQL messages, constraint
 * names or Auth responses never reach the UI.
 */
export type EmployeeErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "invalid_input"
  | "unavailable"
  | "unexpected";

export class EmployeeError extends Error {
  readonly code: EmployeeErrorCode;

  constructor(code: EmployeeErrorCode) {
    super(EMPLOYEE_ERROR_MESSAGES[code]);
    this.name = "EmployeeError";
    this.code = code;
  }
}

export const EMPLOYEE_ERROR_MESSAGES: Record<EmployeeErrorCode, string> = {
  unauthenticated: "Your session has expired. Please sign in again.",
  forbidden: "You do not have permission to view this information.",
  not_found: "Employee not found.",
  invalid_input: "The request contained invalid values.",
  unavailable: "Employee data is temporarily unavailable. Please try again.",
  unexpected: "Something went wrong. Please try again.",
};

type DatabaseErrorLike = { code?: string | null; message?: string | null };

/** Maps a PostgREST/Postgres error from the employee RPCs to a safe application code. */
export function mapDatabaseError(error: DatabaseErrorLike | null | undefined): EmployeeErrorCode {
  if (!error) return "unexpected";
  switch (error.code) {
    case "42501":
      return error.message === "unauthenticated" ? "unauthenticated" : "forbidden";
    case "22023": // invalid_parameter_value raised by the RPC input checks
    case "22P02": // invalid enum/uuid text representation
      return "invalid_input";
    case "PGRST301": // JWT could not be verified
    case "PGRST302":
      return "unauthenticated";
    case "08000":
    case "08003":
    case "08006":
    case "57P01":
    case "57P03":
    case "53300":
      return "unavailable";
    default:
      return "unexpected";
  }
}
