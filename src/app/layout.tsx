import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { getThemePreference } from "@/lib/theme/server";
import { themeAttribute } from "@/lib/theme/theme";

import "@/app/globals.css";

export const metadata: Metadata = {
  title: "CYCLO | Engineering Delivery Management",
  description: "Engineering Delivery Management by AyaTech. Plan. Build. Review. Deliver.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7f9" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0c10" },
  ],
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  // Rendered on the server from the saved cookie, so the first paint already
  // uses the right theme; "system" leaves the choice to CSS (no script needed).
  const theme = themeAttribute(await getThemePreference());

  return (
    <html lang="en" data-theme={theme}>
      <body>{children}</body>
    </html>
  );
}
