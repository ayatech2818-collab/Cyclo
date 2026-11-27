"use client";

import { useEffect, useRef, useState } from "react";

import { isUuid } from "@/features/projects/validation";
import { createClient } from "@/lib/supabase/client";

export type LiveStatus = "connecting" | "live" | "reconnecting";

type Handlers = {
  /** Comments that were created or changed (ids only; re-read them through the server). */
  onChanged: (ids: string[]) => void;
  /** A row was removed (hard deletes do not happen in practice; handled for completeness). */
  onRemoved: (id: string) => void;
  /** The subscription is (re)established: catch up on anything missed. */
  onResync: () => void;
};

const BATCH_DELAY = 150;
const BATCH_MAX = 50;

/**
 * Live discussion updates over Supabase Realtime (Postgres Changes) for ONE
 * work item. The browser client uses the publishable key and the employee's
 * own session; Realtime checks every change against the table's SELECT
 * policies for that session, so other projects' discussions never arrive.
 * Event payloads are used for ids only: the rows are re-read through the
 * server, with the same access checks as the page. Unsubscribes on unmount or
 * when the work item changes.
 */
export function useLiveComments(workItemId: string, handlers: Handlers): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    const supabase = createClient();
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<string>();

    const flush = () => {
      timer = undefined;
      if (!active || pending.size === 0) return;
      const ids = [...pending].slice(0, BATCH_MAX);
      ids.forEach((id) => pending.delete(id));
      latest.current.onChanged(ids);
      if (pending.size) timer = setTimeout(flush, BATCH_DELAY);
    };

    const channel = supabase
      .channel(`work-item-comments:${workItemId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "work_item_comments", filter: `work_item_id=eq.${workItemId}` },
        (payload) => {
          if (!active) return;
          const row = (payload.eventType === "DELETE" ? payload.old : payload.new) as { id?: unknown; work_item_id?: unknown };
          if (!isUuid(row?.id)) return;
          if (payload.eventType === "DELETE") {
            latest.current.onRemoved(row.id.toLowerCase());
            return;
          }
          if (row.work_item_id !== workItemId) return; // defence in depth; the server filter already applies
          pending.add(row.id.toLowerCase());
          if (!timer) timer = setTimeout(flush, BATCH_DELAY);
        },
      )
      // The server confirms the Postgres Changes subscription after each (re)join.
      .on("system", {}, (payload: { extension?: string; status?: string }) => {
        if (!active || payload.extension !== "postgres_changes") return;
        if (payload.status === "ok") {
          setStatus("live");
          latest.current.onResync();
        } else {
          setStatus("reconnecting");
        }
      });

    // Hand the current session token to Realtime before joining (refreshes follow automatically).
    void supabase.realtime.setAuth().finally(() => {
      if (!active) return;
      channel.subscribe((state) => {
        if (!active) return;
        if (state === "CHANNEL_ERROR" || state === "TIMED_OUT" || state === "CLOSED") setStatus("reconnecting");
      });
    });

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [workItemId]);

  return status;
}
