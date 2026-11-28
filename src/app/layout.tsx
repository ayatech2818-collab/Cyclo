import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import type { ReactNode } from "react";

import { getThemePreference } from "@/lib/theme/server";
import { themeAttribute } from "@/lib/theme/theme";

import "@/app/globals.css";

// Self-hosted by next/font at build time (no runtime request to Google).
const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter" });

export const metadata: Metadata = {
  title: "CYCLO | Engineering Delivery Management",
  description: "Engineering Delivery Management by AyaTech. Plan. Build. Review. Deliver.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f5f4" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0a09" },
  ],
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  // Rendered on the server from the saved cookie, so the first paint already
  // uses the right theme; "system" leaves the choice to CSS (no script needed).
  const theme = themeAttribute(await getThemePreference());

  return (
    <html lang="en" data-theme={theme} className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
