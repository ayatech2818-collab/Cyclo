import { isAppRole } from "@/features/employees/validation";

export function validateInvitation(input: { email: unknown; fullName: unknown; role: unknown }) {
  if (typeof input.email !== "string" || typeof input.fullName !== "string" || !isAppRole(input.role)) throw new Error("Enter a name, email and valid role.");
  const email = input.email.trim().toLowerCase();
  const fullName = input.fullName.trim();
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(email) || email.length > 254) throw new Error("Enter a valid employee email.");
  if (!fullName || [...fullName].length > 200) throw new Error("Full name must contain 1–200 characters.");
  return { email, fullName, role: input.role };
}

export function validateOnboardingPassword(password: unknown, confirmation: unknown): string {
  if (typeof password !== "string" || password.length < 12 || new TextEncoder().encode(password).length > 72) throw new Error("Use a password of at least 12 characters and at most 72 UTF-8 bytes.");
  if (password !== confirmation) throw new Error("Passwords do not match.");
  return password;
}
