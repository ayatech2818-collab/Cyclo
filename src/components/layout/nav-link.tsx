"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils/cn";

/** Highlights the current section. Purely presentational; access is enforced server-side. */
export function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "rounded-md px-3 py-1.5 text-sm font-medium",
        active ? "bg-primary/10 text-primary" : "text-text-secondary hover:bg-background hover:text-text-primary",
      )}
    >
      {children}
    </Link>
  );
}
