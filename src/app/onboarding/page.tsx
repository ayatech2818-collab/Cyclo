import { redirect } from "next/navigation";
import { requireOnboarding } from "@/features/invitations/onboarding.server";
import { OnboardingForm } from "@/features/invitations/forms";
export const metadata = { title: "Set your password | CYCLO" };
export default async function OnboardingPage() {
  const { invitation } = await requireOnboarding();
  if (invitation.status === "ONBOARDING") redirect("/onboarding/complete");
  if (invitation.status !== "ACCEPTED") return <p role="alert">This invitation is expired, revoked or has not been accepted. Open your invitation email or contact your administrator.</p>;
  return <><h1 className="text-2xl font-semibold">Welcome to CYCLO</h1><p className="mt-2 text-sm text-text-secondary">Your email is verified. Set a password to continue.</p><OnboardingForm step="password" /></>;
}
