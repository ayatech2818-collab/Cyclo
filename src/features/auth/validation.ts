export function validateCredentials(formData: FormData): { error: string } | { email: string; password: string } {
  const rawEmail = formData.get("email");
  const password = formData.get("password");
  const email = typeof rawEmail === "string" ? rawEmail.trim() : "";

  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "Enter a valid email address." } as const;
  }
  // Do not trim passwords or enforce a new password-creation policy at login.
  if (typeof password !== "string" || password.length === 0 || password.length > 4096) {
    return { error: "Enter your password (up to 4096 characters)." } as const;
  }

  return { email, password } as const;
}
