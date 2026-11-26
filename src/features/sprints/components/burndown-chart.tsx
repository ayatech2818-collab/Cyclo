"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import { formatProjectDate } from "@/features/projects/format";
import { cn } from "@/lib/utils/cn";

import type { Burndown, BurndownPoint } from "../burndown";
import { formatPoints } from "../logic";

const HEIGHT = 240;
const PAD = { top: 16, right: 64, bottom: 28, left: 40 };

function niceMax(value: number): number {
  if (value <= 0) return 5;
  const step = 10 ** Math.floor(Math.log10(value));
  for (const factor of [1, 2, 2.5, 5, 10]) if (value <= factor * step) return factor * step;
  return 10 * step;
}

function shortDate(day: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
}

/** Splits a series into drawable runs; null values (no data / future) break the line. */
function runs(points: readonly BurndownPoint[], value: (point: BurndownPoint) => number | null): { index: number; value: number }[][] {
  const result: { index: number; value: number }[][] = [];
  let current: { index: number; value: number }[] = [];
  points.forEach((point, index) => {
    const v = value(point);
    if (v === null) {
      if (current.length) result.push(current);
      current = [];
    } else current.push({ index, value: v });
  });
  if (current.length) result.push(current);
  return result;
}

/**
 * Sprint burndown: actual remaining points (solid, from database history) and
 * the ideal reference (dashed). Days without history are hatched and break the
 * line; days that have not happened yet show only the ideal line.
 */
export function BurndownChart({ burndown }: { burndown: Burndown }) {
  const id = useId();
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.round(entry.contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { points, latest } = burndown;
  const max = useMemo(() => niceMax(Math.max(0, ...points.map((point) => Math.max(point.ideal ?? 0, point.actual ?? 0, point.scope ?? 0)))), [points]);
  if (points.length === 0) return null;

  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const step = points.length > 1 ? plotW / (points.length - 1) : 0;
  const x = (index: number) => PAD.left + (points.length > 1 ? index * step : plotW / 2);
  const y = (value: number) => PAD.top + plotH - (value / max) * plotH;
  const path = (run: { index: number; value: number }[]) => run.map((p, i) => `${i ? "L" : "M"}${x(p.index).toFixed(1)},${y(p.value).toFixed(1)}`).join("");
  const band = Math.max(step, 6);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(plotW / 64))));

  const actualRuns = runs(points, (point) => point.actual);
  const idealRuns = runs(points, (point) => point.ideal);
  const latestIndex = latest ? points.findIndex((point) => point.day === latest.day) : -1;
  const lastIdeal = idealRuns.at(-1)?.at(-1) ?? null;
  const hovered = hover === null ? null : points[hover];

  const onMove = (event: React.PointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const relative = ((event.clientX - box.left) / box.width) * plotW;
    setHover(Math.min(points.length - 1, Math.max(0, Math.round(points.length > 1 ? relative / step : 0))));
  };

  return (
    <div className="space-y-3">
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-secondary" aria-label="Legend">
        <li className="inline-flex items-center gap-1.5"><svg aria-hidden="true" width="18" height="8"><line x1="0" y1="4" x2="18" y2="4" stroke="var(--chart-actual)" strokeWidth="2" /></svg>Actual remaining</li>
        <li className="inline-flex items-center gap-1.5"><svg aria-hidden="true" width="18" height="8"><line x1="0" y1="4" x2="18" y2="4" stroke="var(--chart-ideal)" strokeWidth="2" strokeDasharray="4 3" /></svg>Ideal (working days)</li>
        <li className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="size-3 rounded-sm bg-surface-muted" />Weekend</li>
        {burndown.missingDays > 0 && (
          <li className="inline-flex items-center gap-1.5">
            <svg aria-hidden="true" width="12" height="12"><rect width="12" height="12" fill={`url(#${id}-hatch)`} /></svg>No history recorded
          </li>
        )}
      </ul>

      <div ref={frame} className="relative">
        <svg width={width} height={HEIGHT} role="img" aria-labelledby={`${id}-desc`} className="block overflow-visible">
          <desc id={`${id}-desc`}>
            Burndown from {shortDate(points[0].day)} to {shortDate(points.at(-1)!.day)}.
            {latest ? ` ${formatPoints(latest.actual ?? 0)} points remaining on ${shortDate(latest.day)}.` : " No history yet."}
            {" "}A table view follows the chart.
          </desc>
          <defs>
            <pattern id={`${id}-hatch`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--text-muted)" strokeWidth="1.5" strokeOpacity="0.5" />
            </pattern>
          </defs>

          {points.map((point, index) => point.weekend && (
            <rect key={`w-${point.day}`} x={x(index) - band / 2} y={PAD.top} width={band} height={plotH} fill="var(--surface-muted)" />
          ))}
          {points.map((point, index) => point.status === "missing" && (
            <rect key={`m-${point.day}`} x={x(index) - band / 2} y={PAD.top} width={band} height={plotH} fill={`url(#${id}-hatch)`} />
          ))}

          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={PAD.left} x2={PAD.left + plotW} y1={y(tick)} y2={y(tick)} stroke="var(--border)" strokeWidth="1" />
              <text x={PAD.left - 8} y={y(tick)} dy="0.32em" textAnchor="end" className="fill-text-muted text-[11px] tabular-nums">{formatPoints(Math.round(tick * 10) / 10)}</text>
            </g>
          ))}
          {points.map((point, index) => (index % labelEvery === 0 || index === points.length - 1) && (index === points.length - 1 || points.length - 1 - index >= labelEvery / 2) && (
            <text key={`x-${point.day}`} x={x(index)} y={HEIGHT - 8} textAnchor="middle" className="fill-text-muted text-[11px]">{shortDate(point.day)}</text>
          ))}

          {idealRuns.map((run) => (
            <path key={`i-${run[0].index}`} d={path(run)} fill="none" stroke="var(--chart-ideal)" strokeWidth="2" strokeDasharray="5 4" strokeLinejoin="round" />
          ))}
          {actualRuns.map((run) => (
            <g key={`a-${run[0].index}`}>
              <path d={path(run)} fill="none" stroke="var(--chart-actual)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
              {/* An isolated day between gaps still needs a visible mark. */}
              {run.length === 1 && <circle cx={x(run[0].index)} cy={y(run[0].value)} r="4" fill="var(--chart-actual)" stroke="var(--surface)" strokeWidth="2" />}
            </g>
          ))}

          {latest && latestIndex >= 0 && latest.actual !== null && (
            <g>
              <circle cx={x(latestIndex)} cy={y(latest.actual)} r="4.5" fill="var(--chart-actual)" stroke="var(--surface)" strokeWidth="2" />
              <text x={x(latestIndex) + 9} y={y(latest.actual)} dy="0.32em" className="fill-text-primary text-[11px] font-semibold tabular-nums">{formatPoints(latest.actual)} left</text>
            </g>
          )}
          {lastIdeal && (latestIndex < 0 || lastIdeal.index !== latestIndex) && (
            <text x={x(lastIdeal.index) + 8} y={y(lastIdeal.value)} dy="-0.4em" className="fill-text-secondary text-[11px]">Ideal</text>
          )}

          {hovered && hover !== null && (
            <g pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--text-muted)" strokeWidth="1" />
              {hovered.ideal !== null && <circle cx={x(hover)} cy={y(hovered.ideal)} r="4" fill="var(--chart-ideal)" stroke="var(--surface)" strokeWidth="2" />}
              {hovered.actual !== null && <circle cx={x(hover)} cy={y(hovered.actual)} r="4.5" fill="var(--chart-actual)" stroke="var(--surface)" strokeWidth="2" />}
            </g>
          )}
          <rect x={PAD.left - band / 2} y={PAD.top} width={plotW + band} height={plotH} fill="transparent"
            onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} />
        </svg>

        {hovered && hover !== null && (
          <div
            role="status"
            className="pointer-events-none absolute top-2 z-10 w-48 rounded-lg border border-border bg-surface p-2.5 text-xs shadow-lg"
            style={{ left: Math.min(Math.max(0, x(hover) + 12), width - 200) }}
          >
            <p className="font-semibold text-text-primary">{formatProjectDate(hovered.day)}{hovered.weekend && <span className="font-normal text-text-muted"> · weekend</span>}</p>
            <dl className="mt-1.5 space-y-1">
              <Row swatch="actual" label="Actual" value={hovered.status === "data" ? `${formatPoints(hovered.actual ?? 0)} pts` : hovered.status === "missing" ? "No history" : "Not yet"} />
              <Row swatch="ideal" label="Ideal" value={hovered.ideal === null ? "—" : `${formatPoints(hovered.ideal)} pts`} />
              {hovered.status === "data" && (
                <>
                  <Row label="Scope" value={`${formatPoints(hovered.scope ?? 0)} pts`} />
                  <Row label="Completed" value={`${formatPoints(hovered.completed ?? 0)} pts`} />
                  <Row label="Open items" value={`${hovered.remainingItems ?? 0}${hovered.unestimatedItems ? ` (${hovered.unestimatedItems} unestimated)` : ""}`} />
                </>
              )}
            </dl>
          </div>
        )}
      </div>

      <details className="text-sm">
        <summary className="cursor-pointer text-xs font-medium text-text-secondary hover:text-text-primary">Show as table</summary>
        <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-border">
          <table className="w-full text-xs">
            <caption className="sr-only">Burndown by day</caption>
            <thead className="sticky top-0 bg-surface-muted text-left text-text-secondary">
              <tr><th scope="col" className="px-3 py-2 font-medium">Day</th><th scope="col" className="px-3 py-2 text-right font-medium">Remaining</th><th scope="col" className="px-3 py-2 text-right font-medium">Ideal</th><th scope="col" className="px-3 py-2 text-right font-medium">Scope</th><th scope="col" className="px-3 py-2 text-right font-medium">Completed</th></tr>
            </thead>
            <tbody className="divide-y divide-border tabular-nums">
              {points.map((point) => (
                <tr key={point.day} className={cn(point.weekend && "bg-surface-muted/50")}>
                  <th scope="row" className="px-3 py-1.5 text-left font-normal">{formatProjectDate(point.day)}{point.weekend && <span className="text-text-muted"> (weekend)</span>}</th>
                  <td className="px-3 py-1.5 text-right">{point.status === "data" ? formatPoints(point.actual ?? 0) : <span className="text-text-muted">{point.status === "missing" ? "No history" : "—"}</span>}</td>
                  <td className="px-3 py-1.5 text-right text-text-secondary">{point.ideal === null ? "—" : formatPoints(point.ideal)}</td>
                  <td className="px-3 py-1.5 text-right text-text-secondary">{point.scope === null ? "—" : formatPoints(point.scope)}</td>
                  <td className="px-3 py-1.5 text-right text-text-secondary">{point.completed === null ? "—" : formatPoints(point.completed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function Row({ label, value, swatch }: { label: string; value: string; swatch?: "actual" | "ideal" }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="inline-flex items-center gap-1.5 text-text-secondary">
        {swatch && <span aria-hidden="true" className={cn("h-0.5 w-3", swatch === "actual" ? "bg-chart-actual" : "bg-chart-ideal")} />}
        {label}
      </dt>
      <dd className="font-semibold text-text-primary tabular-nums">{value}</dd>
    </div>
  );
}
