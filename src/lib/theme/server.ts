import "server-only";

import { cookies } from "next/headers";
import { cache } from "react";

import { THEME_COOKIE, parseThemePreference, type ThemePreference } from "./theme";

/** The signed-in browser's saved theme, read once per request. */
export const getThemePreference = cache(async (): Promise<ThemePreference> => {
  const store = await cookies();
  return parseThemePreference(store.get(THEME_COOKIE)?.value);
});
