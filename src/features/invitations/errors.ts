export class InvitationError extends Error {}
export function invitationFailure(error: { code?: string | null; message?: string | null }): InvitationError {
  const messages: Record<string, string> = {
    employee_exists: "An employee account already uses this email.",
    invitation_exists: "An active invitation already exists for this email.",
    resend_too_soon: "Please wait a minute before resending this invitation.",
    invalid_invitation: "This invitation is expired, revoked or unavailable. Ask your administrator for help.",
    invitation_replayed: "This invitation step has already been completed.",
    invalid_invitation_state: "This invitation cannot be used for that action.",
    password_required: "Set your password before completing onboarding.",
  };
  if (error.code === "42501" && error.message !== "invalid_invitation") return new InvitationError("You do not have permission to perform this action.");
  return new InvitationError(messages[error.message ?? ""] ?? (error.code === "22023" || error.code === "22P02" ? "The request contains invalid values." : "Invitations are temporarily unavailable. Please try again."));
}
