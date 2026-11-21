import { EmployeeError } from "./errors";
import { isAppRole, isUuid } from "./validation";
import { isValidEmployeeAvatarUrl } from "./avatar-url-policy";

function invalid(): never { throw new EmployeeError("invalid_input"); }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : invalid(); }
export function validateEmployeeId(value: unknown): string { return isUuid(value) ? value : invalid(); }
export function validateEmployeeDetails(fullName: unknown, avatarUrl: unknown) {
  const name = text(fullName);
  // Unlike names/codes, URL whitespace must be rejected rather than repaired.
  if (avatarUrl !== null && typeof avatarUrl !== "string") invalid();
  const avatar = avatarUrl as string | null;
  if (!name || [...name].length > 200) invalid();
  if (!isValidEmployeeAvatarUrl(avatar)) invalid();
  return { fullName: name, avatarUrl: avatar || null };
}
/** Existing schema accepts any text up to 32 characters; uniqueness is case-sensitive. */
export function validateEmployeeCode(value: unknown): string | null {
  const code = value === null ? "" : text(value);
  if ([...code].length > 32) invalid();
  return code || null;
}
export function validateEmployeeRole(value: unknown) { return isAppRole(value) ? value : invalid(); }
export function validateEmployeeBoolean(value: unknown): boolean { return typeof value === "boolean" ? value : invalid(); }
