/** Colour theme preference. "system" follows the operating system setting. */
export type ThemePreference = "light" | "dark" | "system";

export const THEME_COOKIE = "cyclo-theme";
export const THEME_PREFERENCES = ["system", "light", "dark"] as const satisfies readonly ThemePreference[];

/** Untrusted cookie value -> preference. Anything unexpected means "system". */
export function parseThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

/** Value for the <html data-theme> attribute; undefined lets CSS follow the OS. */
export function themeAttribute(preference: ThemePreference): "light" | "dark" | undefined {
  return preference === "system" ? undefined : preference;
}

/** Order used by the compact toggle: System -> Light -> Dark -> System. */
export function nextThemePreference(current: ThemePreference): ThemePreference {
  const index = THEME_PREFERENCES.indexOf(current);
  return THEME_PREFERENCES[(index + 1) % THEME_PREFERENCES.length];
}

/** A non-sensitive UI preference: readable by the page, valid for one year. */
export function themeCookie(preference: ThemePreference): string {
  return `${THEME_COOKIE}=${preference}; Path=/; Max-Age=31536000; SameSite=Lax`;
}
