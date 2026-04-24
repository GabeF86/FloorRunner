import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';

// GET /api/scheduling/schedules/:id/versions — list all versions
// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: scheduleId } = await params;
  const sb = sbSchedulingServer();

  const { data, error } = await sb
    .from('schedule_versions')
    .select('*')
    .eq('schedule_id', scheduleId)
    .order('version_number', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// POST /api/scheduling/schedules/:id/versions — create a new version by
// duplicating all slots and assignments from the current latest version.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: scheduleId } = await params;
  const sb = sbSchedulingServer();
  const body = await req.json();

  // Get the current latest version
  const { data: latest, error: latestErr } = await sb
    .from('schedule_versions')
    .select('id, version_number')
    .eq('schedule_id', scheduleId)
    .order('version_number', { ascending: false })
    .limit(1)
    .single();
  if (latestErr) return NextResponse.json({ error: latestErr.message }, { status: 500 });

  const newVersionNumber = (latest?.version_number || 0) + 1;

  // Create the new version row
  const { data: newVersion, error: verErr } = await sb
    .from('schedule_versions')
    .insert({
      schedule_id: scheduleId,
      version_number: newVersionNumber,
      version_status: 'draft',
      notes: body.notes || `Version ${newVersionNumber}`,
    })
    .select()
    .single();
  if (verErr) return NextResponse.json({ error: verErr.message }, { status: 500 });

  // Copy slots from the source version (default: latest)
  const sourceVersionId = body.source_version_id || latest?.id;
  if (sourceVersionId) {
    const { data: srcSlots } = await sb
      .from('schedule_slots')
      .select('*')
      .eq('schedule_version_id', sourceVersionId);

    if (srcSlots && srcSlots.length > 0) {
      // Map old slot IDs to new ones for assignment copying
      const slotIdMap = new Map<string, string>();

      for (const srcSlot of srcSlots as Array<Record<string, unknown>>) {
        const { id: _oldId, schedule_version_id: _svid, created_at: _ca, updated_at: _ua, ...fields } = srcSlot;
        void _oldId; void _svid; void _ca; void _ua;
        const { data: newSlot } = await sb
          .from('schedule_slots')
          .insert({ ...fields, schedule_version_id: newVersion.id })
          .select('id')
          .single();
        if (newSlot) slotIdMap.set(srcSlot.id as string, (newSlot as { id: string }).id);
      }

      // Copy assignments
      const { data: srcAssignments } = await sb
        .from('assignments')
        .select('*')
        .in('schedule_slot_id', Array.from(slotIdMap.keys()));

      if (srcAssignments && srcAssignments.length > 0) {
        const newAssignments = (srcAssignments as Array<Record<string, unknown>>)
          .map(a => {
            const newSlotId = slotIdMap.get(a.schedule_slot_id as string);
            if (!newSlotId) return null;
            const { id: _id, schedule_slot_id: _ssid, created_at: _ca, updated_at: _ua, ...fields } = a;
            void _id; void _ssid; void _ca; void _ua;
            return { ...fields, schedule_slot_id: newSlotId };
          })
          .filter(Boolean);

        if (newAssignments.length > 0) {
          await sb.from('assignments').insert(newAssignments);
        }
      }
    }
  }

  // Update the schedule's current_version_number
  await sb
    .from('schedules')
    .update({ current_version_number: newVersionNumber })
    .eq('id', scheduleId);

  return NextResponse.json(newVersion);
}
