import { cn } from "@/lib/utils/cn";

import type { SprintProgress } from "@/features/work-items/execution";

import { formatPoints } from "../logic";

/** Progress from private.sprint_progress (cancelled work never counts as completed). */
export function ProgressSummary({ progress }: { progress: SprintProgress }) {
  const { total } = progress;
  const byPoints = total.totalPoints > 0;
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-3xl font-semibold tabular-nums">{total.completionPercent}%</p>
        <p className="text-xs text-text-secondary">complete by {byPoints ? "story points" : "item count"}</p>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-muted" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={total.completionPercent} aria-label="Sprint completion">
        <div className="h-full rounded-full bg-success" style={{ width: `${total.completionPercent}%` }} />
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <Stat label="Completed" value={`${total.completedItems} / ${total.totalItems} items`} />
        <Stat label="Remaining" value={`${total.remainingItems} item${total.remainingItems === 1 ? "" : "s"}`} />
        <Stat label="Points done" value={`${formatPoints(total.completedPoints)} / ${formatPoints(total.totalPoints)}`} />
        <Stat label="Points left" value={formatPoints(total.remainingPoints)} />
      </dl>
      {(total.unestimatedItems > 0 || total.cancelledItems > 0) && (
        <p className="text-xs text-text-muted">
          {total.unestimatedItems > 0 && `${total.unestimatedItems} item${total.unestimatedItems === 1 ? " is" : "s are"} not estimated. `}
          {total.cancelledItems > 0 && `${total.cancelledItems} cancelled item${total.cancelledItems === 1 ? " is" : "s are"} excluded.`}
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-text-secondary">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

export function DeveloperProgress({ progress, viewerId }: { progress: SprintProgress; viewerId: string }) {
  if (progress.byAssignee.length === 0) return <p className="px-5 py-4 text-sm text-text-muted">No work in this sprint yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Progress by developer</caption>
        <thead className="border-b border-border text-left text-xs text-text-secondary">
          <tr>
            <th scope="col" className="px-5 py-2.5 font-medium">Developer</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Done</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Remaining</th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">Points</th>
            <th scope="col" className="w-36 px-5 py-2.5 font-medium">Completion</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border tabular-nums">
          {progress.byAssignee.map((row) => (
            <tr key={row.assigneeId ?? "unassigned"}>
              <th scope="row" className={cn("px-5 py-2.5 text-left font-medium", !row.assigneeId && "text-text-muted")}>
                {row.assigneeName ?? "Unassigned"}{row.assigneeId === viewerId && <span className="font-normal text-text-muted"> (you)</span>}
              </th>
              <td className="px-3 py-2.5 text-right">{row.completedItems}/{row.totalItems}</td>
              <td className="px-3 py-2.5 text-right">{row.remainingItems}</td>
              <td className="px-3 py-2.5 text-right">
                {formatPoints(row.completedPoints)}/{formatPoints(row.totalPoints)}
                {row.unestimatedItems > 0 && <span className="text-warning" title={`${row.unestimatedItems} not estimated`}> · {row.unestimatedItems}?</span>}
              </td>
              <td className="px-5 py-2.5">
                <div className="flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-muted" aria-hidden="true">
                    <div className="h-full rounded-full bg-success" style={{ width: `${row.completionPercent}%` }} />
                  </div>
                  <span className="w-9 text-right text-xs">{row.completionPercent}%</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
