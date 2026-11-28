"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";

import type { AppRole } from "@/features/auth/access";
import { cn } from "@/lib/utils/cn";

import type { AccountSummary } from "./account-menu";
import { Sidebar } from "./sidebar";

/**
 * Phone navigation: a menu button and a slide-out drawer holding the full
 * sidebar. Escape, the overlay and any navigation close it; focus is kept
 * inside while open and returns to the button afterwards.
 */
export function MobileNav({ role, account }: { role: AppRole; account: AccountSummary }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const [path, setPath] = useState(pathname);
  if (path !== pathname) {
    setPath(pathname);
    if (open) setOpen(false);
  }
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // The header uses backdrop-blur, which makes it the containing block for
  // fixed descendants; portal the drawer to <body> so it covers the viewport.
  const mounted = useSyncExternalStore(subscribeNothing, () => true, () => false);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const element = panel.current;
    element?.querySelector<HTMLElement>("a, button")?.focus();
    const button = trigger.current;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        return;
      }
      if (event.key !== "Tab" || !element) return;
      const focusable = [...element.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
      button?.focus();
    };
  }, [open]);

  return (
    <>
      <button ref={trigger} type="button" onClick={() => setOpen(true)} aria-label="Open navigation" aria-expanded={open} aria-controls="mobile-navigation"
        className="inline-flex size-9 items-center justify-center rounded-full text-text-secondary hover:bg-surface-muted hover:text-text-primary md:hidden">
        <Menu aria-hidden="true" className="size-5" />
      </button>

      {mounted && createPortal(
      <div className={cn("fixed inset-0 z-50 md:hidden", open ? "pointer-events-auto" : "pointer-events-none")} aria-hidden={!open}>
        <div onClick={() => setOpen(false)}
          className={cn("absolute inset-0 bg-black/40 transition-opacity duration-300 motion-reduce:transition-none", open ? "opacity-100" : "opacity-0")} />
        <div ref={panel} id="mobile-navigation" role="dialog" aria-modal="true" aria-label="Navigation" inert={!open}
          className={cn(
            "absolute inset-y-0 left-0 flex w-[min(20rem,86vw)] flex-col bg-surface p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-lg transition-transform duration-300 motion-reduce:transition-none",
            open ? "translate-x-0" : "-translate-x-full",
          )}>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close navigation"
            className="absolute top-3 right-3 z-10 inline-flex size-9 items-center justify-center rounded-full text-text-secondary hover:bg-surface-muted hover:text-text-primary">
            <X aria-hidden="true" className="size-5" />
          </button>
          {open && <Sidebar role={role} account={account} mode="drawer" onNavigate={() => setOpen(false)} />}
        </div>
      </div>,
      document.body,
      )}
    </>
  );
}

const subscribeNothing = () => () => {};
