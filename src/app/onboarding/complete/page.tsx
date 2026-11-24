import { redirect } from "next/navigation";
import { requireOnboarding } from "@/features/invitations/onboarding.server";
import { OnboardingForm } from "@/features/invitations/forms";
export const metadata = { title: "Complete onboarding | CYCLO" };
export default async function CompleteOnboardingPage() {
  const { invitation } = await requireOnboarding();
  if (invitation.status !== "ONBOARDING") redirect("/onboarding");
  return <><h1 className="text-2xl font-semibold">Complete your profile</h1><p className="mt-2 text-sm text-text-secondary">Confirm your full name to activate your account.</p><OnboardingForm step="profile" fullName={invitation.fullName} /></>;
}
