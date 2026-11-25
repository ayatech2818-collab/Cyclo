import type { NextConfig } from "next";

/**
 * Security headers for every response (pages, route handlers, redirects).
 *
 * The CSP is deliberately limited to directives that cannot break Next.js
 * hydration, Supabase Auth or signed avatar images:
 *   - frame-ancestors 'none'  : no framing anywhere (clickjacking)
 *   - base-uri 'self'         : no <base> hijacking of relative URLs
 *   - form-action 'self'      : forms and Server Actions post to this origin only
 *   - object-src 'none'       : no plugins
 * script-src / img-src / connect-src are not restricted yet: Next.js inline
 * bootstrap scripts need nonces, and avatars come from the Supabase origin.
 * HSTS belongs to the hosted deployment and is not set here.
 */
export const securityHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), browsing-topics=()",
  },
] as const;

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Dev-only: invitation emails link to http://127.0.0.1:<port> while next dev
  // announces localhost; allow its dev resources (HMR, fonts) from that host.
  allowedDevOrigins: ["127.0.0.1"],
  experimental: {
    serverActions: {
      // Avatar uploads are at most 2 MB (checked again in the action and by the
      // Storage bucket); this leaves room for multipart overhead only.
      bodySizeLimit: "3mb",
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: [...securityHeaders] }];
  },
};

export default nextConfig;
