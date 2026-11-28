import type { Metadata } from "next";

import {
  ActivityWidget, AttentionWidget, DashboardHeader, EmployeeOverviewWidget, MyWorkWidget, NotificationsWidget,
  ProjectOverviewWidget, ProjectsWidget, ReviewsWidget, SprintsWidget,
} from "@/features/dashboard/components/widgets";
import { loadDashboard } from "@/features/dashboard/queries.server";

export const metadata: Metadata = { title: "Dashboard | CYCLO" };

/** Role-aware home (Phase 8H Part 1), built only from existing, permission-scoped reads. */
export default async function DashboardPage() {
  const data = await loadDashboard();

  return (
    <main className="mx-auto w-full max-w-[88rem] space-y-6 px-4 py-6 sm:px-6 lg:py-8">
      <DashboardHeader data={data} />

      {data.role === "SUPER_ADMIN" && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <ProjectOverviewWidget data={data} />
          <EmployeeOverviewWidget data={data} />
          <ReviewsWidget data={data} className="md:col-span-2 xl:col-span-1" />
          <AttentionWidget data={data} className="md:col-span-2" />
          <SprintsWidget data={data} className="md:col-span-2 xl:col-span-1" />
          <ActivityWidget data={data} wide className="md:col-span-2 xl:col-span-3" />
        </div>
      )}

      {data.role === "PROJECT_MANAGER" && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <ProjectsWidget data={data} title="Managed projects" />
          <ReviewsWidget data={data} />
          <SprintsWidget data={data} className="md:col-span-2 xl:col-span-1" />
          <ActivityWidget data={data} title="Team and project activity" wide className="md:col-span-2 xl:col-span-3" />
        </div>
      )}

      {data.role === "DEVELOPER" && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <MyWorkWidget data={data} className="md:col-span-2" />
          <SprintsWidget data={data} />
          <ProjectsWidget data={data} title="My projects" />
          <NotificationsWidget data={data} className="md:col-span-2" />
          <ActivityWidget data={data} wide className="md:col-span-2 xl:col-span-3" />
        </div>
      )}
    </main>
  );
}
