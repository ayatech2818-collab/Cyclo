/**
 * Which Supabase project and application origin the invitation Admin client
 * may use. Pure and framework-free so every rule is unit tested.
 *
 * Exactly two pairings are allowed:
 *
 *   local       Supabase on a loopback host (http or https, any port) and an
 *               application origin on a loopback host. CYCLO_APP_URL defaults
 *               to http://127.0.0.1:3000 as before.
 *
 *   production  Supabase at https://<project-ref>.supabase.co (default port)
 *               and an explicitly configured https application origin on a
 *               public DNS name (default port). CYCLO_APP_URL is required.
 *
 * Anything else is rejected: arbitrary or look-alike Supabase hosts, http in
 * production, explicit ports in production, IP-literal production origins,
 * credentials, paths, queries, fragments, and mixed pairings (a hosted project
 * emailing links to a loopback app, or a local project emailing production links).
 * Messages never echo the configured values.
 */

export type InvitationTargets = {
  mode: "local" | "production";
  /** Origin the Admin client connects to. */
  supabaseOrigin: string;
  /** Exact Auth redirect target written into invitation emails. */
  callbackUrl: string;
};

export class InvitationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvitationConfigError";
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const DEFAULT_LOCAL_APP_URL = "http://127.0.0.1:3000";
// Supabase project refs are 20 lowercase alphanumerics.
const HOSTED_SUPABASE_HOST = /^[a-z0-9]{20}\.supabase\.co$/;
// Lowercase DNS name with at least one dot; labels 1–63 chars, no leading/trailing hyphen.
const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function parseOrigin(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvitationConfigError(`${label} is not a valid URL.`);
  }
  // Only a bare origin is accepted: "https://host[:port]" with an optional "/".
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new InvitationConfigError(`${label} must be a bare origin without credentials, path, query or fragment.`);
  }
  if (value.trim() !== value || /[\\\s]/.test(value)) {
    throw new InvitationConfigError(`${label} must not contain whitespace or backslashes.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvitationConfigError(`${label} must use http or https.`);
  }
  return url;
}

const isLoopback = (url: URL) => LOOPBACK_HOSTS.has(url.hostname);

function assertProductionOrigin(url: URL, label: string) {
  if (url.protocol !== "https:") throw new InvitationConfigError(`${label} must use https in production.`);
  if (url.port !== "") throw new InvitationConfigError(`${label} must use the default https port in production.`);
}

export function resolveInvitationTargets(supabaseUrl: string | undefined, appUrl: string | undefined): InvitationTargets {
  if (!supabaseUrl) throw new InvitationConfigError("NEXT_PUBLIC_SUPABASE_URL is required.");
  const supabase = parseOrigin(supabaseUrl, "NEXT_PUBLIC_SUPABASE_URL");

  if (isLoopback(supabase)) {
    const app = parseOrigin(appUrl ?? DEFAULT_LOCAL_APP_URL, "CYCLO_APP_URL");
    if (!isLoopback(app)) {
      throw new InvitationConfigError("A local Supabase project may only send invitation links to a local application origin.");
    }
    return { mode: "local", supabaseOrigin: supabase.origin, callbackUrl: `${app.origin}/auth/confirm` };
  }

  assertProductionOrigin(supabase, "NEXT_PUBLIC_SUPABASE_URL");
  if (!HOSTED_SUPABASE_HOST.test(supabase.hostname)) {
    throw new InvitationConfigError("NEXT_PUBLIC_SUPABASE_URL must be a hosted Supabase project URL (https://<project-ref>.supabase.co).");
  }

  if (!appUrl) throw new InvitationConfigError("CYCLO_APP_URL is required in production.");
  const app = parseOrigin(appUrl, "CYCLO_APP_URL");
  if (isLoopback(app)) {
    throw new InvitationConfigError("A hosted Supabase project must not send invitation links to a local application origin.");
  }
  assertProductionOrigin(app, "CYCLO_APP_URL");
  if (!DNS_NAME.test(app.hostname)) {
    throw new InvitationConfigError("CYCLO_APP_URL must use a public DNS host name in production.");
  }
  return { mode: "production", supabaseOrigin: supabase.origin, callbackUrl: `${app.origin}/auth/confirm` };
}

/** Accepts the modern secret key, or a legacy service-role JWT for the local stack only. */
export function isAcceptableSecretKey(secret: string | undefined, mode: InvitationTargets["mode"]): secret is string {
  if (!secret) return false;
  if (/^sb_secret_[A-Za-z0-9_-]{8,}$/.test(secret)) return true;
  return mode === "local" && secret.split(".").length === 3;
}
