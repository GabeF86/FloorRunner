'use client';

import { Dispatch, SetStateAction, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import {
  Site, StaffMember, Assignment, Break, ReliefEntry,
  DailyDesignation, DailyShift, MDDesignation, ShiftHours,
} from '@/types';

// State setters the realtime listeners write into. Typed as the React
// useState dispatchers so callers pass their setters verbatim — including
// setAssignments, which the assignments listener drives with the functional
// updater form to preserve optimistic ('opt-') rows (a no-op for the wall,
// which never creates optimistic entries).
export interface BoardRealtimeSetters {
  setSites:          Dispatch<SetStateAction<Site[]>>;
  setStaff:          Dispatch<SetStateAction<StaffMember[]>>;
  setAssignments:    Dispatch<SetStateAction<Assignment[]>>;
  setActiveStaffIds: Dispatch<SetStateAction<Set<string>>>;
  setDesignations:   Dispatch<SetStateAction<Record<string, MDDesignation>>>;
  setDailyShifts:    Dispatch<SetStateAction<Record<string, ShiftHours>>>;
  setBreaks:         Dispatch<SetStateAction<Break[]>>;
  setReliefLog:      Dispatch<SetStateAction<ReliefEntry[]>>;
}

// Board realtime subscription, shared by BoardClient and the wall display.
// Extracted verbatim from BoardClient (pure move) so the wall reuses the exact
// same table listeners, refetch wiring, and — critically — the unique-topic
// channel pattern below. Only runs when isToday (planning/past dates don't
// subscribe). Deps are [today, isToday] exactly as in the original: the setters
// come from useState and are stable, so they need not be dependencies — keeping
// them out prevents the object literal callers pass from re-subscribing every
// render (which would defeat the pure move).
export function useBoardRealtime(today: string, isToday: boolean, setters: BoardRealtimeSetters) {
  const {
    setSites, setStaff, setAssignments, setActiveStaffIds,
    setDesignations, setDailyShifts, setBreaks, setReliefLog,
  } = setters;

  useEffect(() => {
    if (!isToday) return;

    async function refreshSites() {
      const { data } = await supabase.from('sites').select('*, rooms(*)').order('position').order('position', { referencedTable: 'rooms' });
      if (data) setSites(data as Site[]);
    }

    // Unique topic per mount: supabase-js returns the SAME channel instance
    // for a repeated topic name, so under React StrictMode's dev double-mount
    // the second subscribe() lands on a channel the first cleanup is already
    // tearing down — leaving the tab with NO live subscription. A fresh topic
    // guarantees a fresh channel; cleanup still removes it by reference.
    const channel = supabase.channel(`board-rt-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'assignments' }, async () => {
        const res = await supabase.from('assignments').select('*, staff(*)').eq('board_date', today);
        if (res.data) {
          setAssignments((prev) => {
            // Keep any optimistic (unconfirmed) entries not yet reflected in DB
            const confirmedPairs = new Set((res.data as Assignment[]).map((a) => `${a.room_id}:${a.staff_id}`));
            const opts = prev.filter((a) => a.id.startsWith('opt-') && !confirmedPairs.has(`${a.room_id}:${a.staff_id}`));
            return [...(res.data as Assignment[]), ...opts];
          });
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'staff' }, async () => {
        const { data } = await supabase.from('staff').select('*').order('role').order('name');
        if (data) setStaff(data as StaffMember[]);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'daily_active' }, async () => {
        const res = await fetch('/api/daily-active?date=' + today);
        const data: { staff_id: string }[] = await res.json();
        setActiveStaffIds(new Set(data.map((r) => r.staff_id)));
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'daily_designations' }, async () => {
        const res  = await fetch('/api/designations?date=' + today);
        const data: DailyDesignation[] = await res.json();
        const m: Record<string, MDDesignation> = {};
        data.forEach((d) => { m[d.staff_id] = d.designation; });
        setDesignations(m);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'daily_shifts' }, async () => {
        const res  = await fetch('/api/daily-shifts?date=' + today);
        const data: DailyShift[] = await res.json();
        const m: Record<string, ShiftHours> = {};
        data.forEach((s) => { m[s.staff_id] = s.hours; });
        setDailyShifts(m);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'breaks' }, async () => {
        const res = await fetch('/api/breaks?date=' + today);
        setBreaks(await res.json());
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'relief_log' }, async () => {
        const res = await fetch('/api/relief?date=' + today);
        setReliefLog(await res.json());
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sites' }, refreshSites)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' }, refreshSites)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [today, isToday]); // eslint-disable-line react-hooks/exhaustive-deps
}
