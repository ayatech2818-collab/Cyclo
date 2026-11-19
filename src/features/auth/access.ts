import type { SupabaseClient, User } from "@supabase/supabase-js";

export type AppRole = "SUPER_ADMIN" | "PROJECT_MANAGER" | "DEVELOPER";

// Projection of public.profiles in the existing Phase 1A migration.
export type ActiveProfile = {
  id: string;
  full_name: string | null;
  email: string | null;
  role: AppRole;
  is_active: true;
};

export type AccessResult =
  | { status: "authorized"; user: User; profile: ActiveProfile }
  | { status: "anonymous" | "denied" | "unavailable" };

export function isActiveProfile(value: unknown, userId: string): value is ActiveProfile {
  if (typeof value !== "object" || value === null) return false;
  const profile = value as Record<string, unknown>;
  return (
    profile.id === userId &&
    profile.is_active === true &&
    (profile.role === "SUPER_ADMIN" || profile.role === "PROJECT_MANAGER" || profile.role === "DEVELOPER") &&
    (profile.full_name === null || typeof profile.full_name === "string") &&
    (profile.email === null || typeof profile.email === "string")
  );
}

/** Server callers only. No persistent cache: deactivation takes effect on the next check. */
export async function getAccess(supabase: SupabaseClient): Promise<AccessResult> {
  try {
    // Unlike cookie state, getUser verifies the session with Supabase Auth.
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error) {
      return { status: error.status && error.status < 500 ? "anonymous" : "unavailable" };
    }
    if (!user) return { status: "anonymous" };

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id, full_name, email, role, is_active")
      .eq("id", user.id)
      .maybeSingle();

    if (profileError) return { status: "unavailable" };
    if (!isActiveProfile(profile, user.id)) return { status: "denied" };
    return { status: "authorized", user, profile };
  } catch {
    // Network failures must never grant access or disclose backend details.
    return { status: "unavailable" };
  }
}
