"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

import { getProjectSummaryAction, type ProjectSummary } from "@/features/projects/switcher-actions";

import { LAST_PROJECT_COOKIE, lastProjectValue, projectIdFromPath } from "./navigation";

type CurrentProjectValue = {
  project: ProjectSummary | null;
  /** True while the project in the URL is being looked up. */
  loading: boolean;
  select: (project: ProjectSummary) => void;
};

const CurrentProjectContext = createContext<CurrentProjectValue | null>(null);

export function useCurrentProject(): CurrentProjectValue {
  const value = useContext(CurrentProjectContext);
  if (!value) throw new Error("useCurrentProject must be used inside CurrentProjectProvider");
  return value;
}

function remember(userId: string, projectId: string | null) {
  document.cookie = projectId
    ? `${LAST_PROJECT_COOKIE}=${lastProjectValue(userId, projectId)}; Path=/; Max-Age=31536000; SameSite=Lax`
    : `${LAST_PROJECT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}

/**
 * The project the sidebar's Current project group shows: the one in the URL
 * inside /projects/[id]/…, otherwise the last one you opened (cookie, checked
 * on the server against your access on every full load). Read through the
 * existing project RPC, so a project you lost access to is simply dropped.
 */
export function CurrentProjectProvider({ userId, initial, children }: { userId: string; initial: ProjectSummary | null; children: ReactNode }) {
  const pathname = usePathname();
  const [project, setProject] = useState<ProjectSummary | null>(initial);
  const [loading, setLoading] = useState(false);
  const requested = useRef<string | null>(initial?.id ?? null);

  useEffect(() => {
    const id = projectIdFromPath(pathname);
    if (!id || id === requested.current) return;
    requested.current = id;
    let active = true;
    setLoading(true);
    void getProjectSummaryAction(id).then((summary) => {
      if (!active) return;
      setLoading(false);
      // A project you cannot see 404s on its own page; keep the previous selection then.
      if (summary) {
        setProject(summary);
        remember(userId, summary.id);
      }
    }, () => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [pathname, userId]);

  // The server dropped a remembered project you can no longer access: clear the cookie too.
  useEffect(() => {
    if (!initial) remember(userId, null);
  }, [initial, userId]);

  const select = useCallback((next: ProjectSummary) => {
    requested.current = next.id;
    setProject(next);
    remember(userId, next.id);
  }, [userId]);

  const value = useMemo(() => ({ project, loading, select }), [project, loading, select]);
  return <CurrentProjectContext.Provider value={value}>{children}</CurrentProjectContext.Provider>;
}
