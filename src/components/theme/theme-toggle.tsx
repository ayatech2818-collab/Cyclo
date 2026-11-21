"use client";

import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useState } from "react";

import {
  THEME_PREFERENCES,
  nextThemePreference,
  themeAttribute,
  themeCookie,
  type ThemePreference,
} from "@/lib/theme/theme";
import { cn } from "@/lib/utils/cn";

const OPTIONS: Record<ThemePreference, { label: string; icon: LucideIcon }> = {
  system: { label: "System", icon: Monitor },
  light: { label: "Light", icon: Sun },
  dark: { label: "Dark", icon: Moon },
};

function applyTheme(preference: ThemePreference) {
  const value = themeAttribute(preference);
  if (value) document.documentElement.dataset.theme = value;
  else delete document.documentElement.dataset.theme;
  // UI preference only; the server reads it to render the right theme first time.
  document.cookie = themeCookie(preference);
}

/**
 * Theme switcher. `segmented` shows all three options (login page);
 * `compact` is a single button that cycles, for the narrow app header.
 */
export function ThemeToggle({ initial, variant = "segmented" }: { initial: ThemePreference; variant?: "segmented" | "compact" }) {
  const [preference, setPreference] = useState(initial);

  function choose(next: ThemePreference) {
    setPreference(next);
    applyTheme(next);
  }

  if (variant === "compact") {
    const current = OPTIONS[preference];
    const next = nextThemePreference(preference);
    const Icon = current.icon;
    return (
      <button
        type="button"
        onClick={() => choose(next)}
        aria-label={`Colour theme: ${current.label}. Switch to ${OPTIONS[next].label}.`}
        title={`Theme: ${current.label}`}
        className="inline-flex size-9 items-center justify-center rounded-md text-text-secondary hover:bg-surface-muted hover:text-text-primary"
      >
        <Icon aria-hidden="true" className="size-4" />
      </button>
    );
  }

  return (
    <div role="group" aria-label="Colour theme" className="inline-flex rounded-lg border border-border bg-surface-muted p-0.5">
      {THEME_PREFERENCES.map((option) => {
        const { label, icon: Icon } = OPTIONS[option];
        const selected = option === preference;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={selected}
            onClick={() => choose(option)}
            title={label}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium",
              selected ? "bg-surface text-text-primary shadow-sm" : "text-text-secondary hover:text-text-primary",
            )}
          >
            <Icon aria-hidden="true" className="size-3.5" />
            <span className="sr-only sm:not-sr-only">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
