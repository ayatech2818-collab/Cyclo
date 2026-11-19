/**
 * Centralised validation for the public Supabase configuration.
 *
 * Only the Project URL and the publishable key are used. Both are safe to
 * expose to the browser; access is enforced by Row Level Security.
 * A service-role / secret key must never be referenced here.
 *
 * NEXT_PUBLIC_* variables are inlined at build time only when accessed
 * statically (process.env.NAME), so they are read explicitly below.
 */

type SupabaseEnv = {
  url: string;
  publishableKey: string;
};

function missingVariableError(name: string): Error {
  return new Error(
    `[supabase] Missing environment variable ${name}. ` +
      "Add it to .env.local (see .env.example) and restart the dev server.",
  );
}

export function getSupabaseEnv(): SupabaseEnv {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url) throw missingVariableError("NEXT_PUBLIC_SUPABASE_URL");
  if (!publishableKey) {
    throw missingVariableError("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  }

  try {
    new URL(url);
  } catch {
    throw new Error(
      "[supabase] NEXT_PUBLIC_SUPABASE_URL is not a valid URL.",
    );
  }

  return { url, publishableKey };
}
