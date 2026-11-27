"use client";

import { useState } from "react";

import { cn } from "@/lib/utils/cn";

import { setNotificationPreferenceAction } from "../actions";
import { CATEGORY_LABELS, type NotificationCategory } from "../logic";

/** Per-category in-app switches. Saved at once; enforced by the database when notifications are created. */
export function PreferencesForm({ initial }: { initial: { category: NotificationCategory; inApp: boolean }[] }) {
  const [values, setValues] = useState(initial);
  const [busy, setBusy] = useState<NotificationCategory | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function toggle(category: NotificationCategory, inApp: boolean) {
    setBusy(category);
    setMessage(null);
    setValues((current) => current.map((entry) => (entry.category === category ? { ...entry, inApp } : entry)));
    const result = await setNotificationPreferenceAction(category, inApp).catch(() => ({ ok: false as const, error: "The setting could not be saved. Try again." }));
    setBusy(null);
    if (result.ok) {
      setMessage({ tone: "success", text: `${CATEGORY_LABELS[category].label} ${inApp ? "on" : "off"}.` });
    } else {
      setValues((current) => current.map((entry) => (entry.category === category ? { ...entry, inApp: !inApp } : entry)));
      setMessage({ tone: "error", text: result.error });
    }
  }

  return (
    <div className="space-y-3">
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
        {values.map(({ category, inApp }) => {
          const id = `pref-${category}`;
          return (
            <li key={category} className="flex items-center gap-4 p-4 sm:px-5">
              <div className="min-w-0 flex-1">
                <label htmlFor={id} className="text-sm font-medium">{CATEGORY_LABELS[category].label}</label>
                <p id={`${id}-hint`} className="mt-0.5 text-xs text-text-secondary">{CATEGORY_LABELS[category].description}</p>
              </div>
              <button id={id} type="button" role="switch" aria-checked={inApp} aria-describedby={`${id}-hint`} disabled={busy === category}
                onClick={() => void toggle(category, !inApp)}
                className={cn("relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-60", inApp ? "bg-primary" : "bg-border-strong")}>
                <span className="sr-only">{inApp ? "On" : "Off"}</span>
                <span aria-hidden="true" className={cn("inline-block size-5 rounded-full bg-surface shadow transition-transform", inApp ? "translate-x-5.5" : "translate-x-0.5")} />
              </button>
            </li>
          );
        })}
      </ul>
      <p aria-live="polite" className={cn("min-h-5 text-sm", message?.tone === "error" ? "text-danger" : "text-success")}>{message?.text}</p>
    </div>
  );
}
