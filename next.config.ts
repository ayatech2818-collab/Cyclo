import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev-only: invitation emails link to http://127.0.0.1:<port> while next dev
  // announces localhost; allow its dev resources (HMR, fonts) from that host.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
