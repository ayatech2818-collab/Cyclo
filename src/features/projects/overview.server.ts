import "server-only";

import { getBacklogSummary } from "@/features/backlog/queries.server";
import type { BacklogSummary } from "@/features/backlog/types";
import { listSprints } from "@/features/sprints/queries.server";
import type { Sprint } from "@/features/sprints/types";

import type { ActivityEntry } from "./activity";
import { listProjectActivity, listProjectMembers } from "./queries.server";
import type { ProjectMember } from "./types";

/*
 * Project overview data (Phase 8H Part 2). Existing, permission-scoped reads
 * only, run in parallel. A read that fails leaves its section out (null).
 */

export const OVERVIEW_ACTIVITY = 6;

export type ProjectOverviewData = {
  /** Open (not done or cancelled), non-epic work. */
  work: BacklogSummary | null;
  /** The running sprint, else the next planned one. */
  sprint: { sprint: Sprint; state: "active" | "planned" } | null | undefined;
  members: ProjectMember[] | null;
  activity: ActivityEntry[] | null;
};

async function safe<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    console.error(`[project-overview] read failed: ${error instanceof Error ? error.name : "unknown"}`);
    return null;
  }
}

export async function loadProjectOverview(projectId: string): Promise<ProjectOverviewData> {
  const [work, sprints, members, activity] = await Promise.all([
    safe(() => getBacklogSummary(projectId)),
    safe(() => listSprints(projectId, "open", 1, 20)),
    safe(() => listProjectMembers(projectId)),
    safe(async () => (await listProjectActivity(projectId)).entries.slice(0, OVERVIEW_ACTIVITY)),
  ]);

  let sprint: ProjectOverviewData["sprint"] = undefined; // undefined: the read failed
  if (sprints) {
    const active = sprints.sprints.find((entry) => entry.status === "ACTIVE");
    const planned = sprints.sprints.find((entry) => entry.status === "PLANNING");
    sprint = active ? { sprint: active, state: "active" } : planned ? { sprint: planned, state: "planned" } : null;
  }
  return { work, sprint, members, activity };
}
