import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils/cn";

import { panel } from "./styles";

const PADDING = { none: "", sm: "p-4", md: "p-5 sm:p-6" } as const;

/** Page section / card surface (border, soft shadow, large radius). */
export function Panel({ padding = "md", className, children, ...props }: HTMLAttributes<HTMLElement> & { padding?: keyof typeof PADDING; children: ReactNode }) {
  return (
    <section className={cn(panel, PADDING[padding], className)} {...props}>
      {children}
    </section>
  );
}
