import type { AppRole } from "@/features/auth/access";

export const INVITATION_STATUSES = ["PENDING", "ACCEPTED", "ONBOARDING", "COMPLETED", "EXPIRED", "REVOKED"] as const;
export type InvitationStatus = typeof INVITATION_STATUSES[number];
export type Invitation = {
  id: string; email: string; fullName: string; role: AppRole;
  authUserId: string | null;
  status: InvitationStatus; expiresAt: string; createdAt: string;
  lastSentAt: string | null; deliveryFailed: boolean;
};
export type InvitationFormState = { error: string | null; success: string | null };
