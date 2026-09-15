'use client';

// Every site in its own box, each split physician / CRNA (Gabriel 2026-09-15).
//
// Sites with no schedules still get a box. Six of the eight are in that state,
// and that is precisely what the board is for: an empty Physician column at
// Riddle is the fact worth seeing, whereas dropping the site makes it look as
// though Riddle is not part of the group.

import Link from 'next/link';
import { Card, Badge, Button, Banner, scheduleStatusTone, scheduleStatusLabel } from '@/components/ui';
import {
  buildScheduleBoard, boxSummary, GROUP_LABELS,
  type BoardGroup, type BoardSchedule, type BoardSite,
} from '@/lib/scheduleBoard';

interface Props {
  sites: BoardSite[];
  schedules: BoardSchedule[];
  /** Opens the create modal with the site and group already chosen. */
  onCreate: (siteId: string, group: BoardGroup) => void;
}

function formatRange(start: string, end: string): string {
  const fmt = (d: string) => {
    const dt = new Date(d + 'T12:00:00');
    return Number.isNaN(dt.getTime())
      ? d
      : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  return `${fmt(start)} – ${fmt(end)}`;
}

function ScheduleLink({ s }: { s: BoardSchedule }) {
  return (
    <Link
      href={`/schedules/${s.id}`}
      className="fr-chip"
      style={{
        display: 'block', padding: '7px 9px', borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--border)', background: 'var(--bg-deep)',
        textDecoration: 'none', marginBottom: 5,
      }}
    >
      <div style={{
        fontSize: 'var(--fs-sm)', fontWeight: 700, color: 'var(--text)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {s.schedule_name}
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
          {formatRange(s.date_start, s.date_end)}
        </span>
        <Badge tone={scheduleStatusTone(s.status)}>{scheduleStatusLabel(s.status)}</Badge>
      </div>
    </Link>
  );
}

function GroupColumn({
  group, rows, siteId, onCreate,
}: {
  group: BoardGroup;
  rows: BoardSchedule[];
  siteId: string;
  onCreate: Props['onCreate'];
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{
        fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: 1,
        color: 'var(--text-dim)', fontWeight: 700,
        paddingBottom: 5, marginBottom: 'var(--space-2)',
        borderBottom: '1px solid var(--border-faint)',
      }}>
        {GROUP_LABELS[group]}
        {rows.length > 0 && (
          <span style={{ color: 'var(--text-faint)', marginLeft: 6 }}>{rows.length}</span>
        )}
      </div>

      {rows.length === 0 ? (
        <div style={{
          fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', fontStyle: 'italic',
          marginBottom: 'var(--space-2)',
        }}>
          None yet.
        </div>
      ) : (
        rows.map(s => <ScheduleLink key={s.id} s={s} />)
      )}

      <Button variant="ghost" size="sm" onClick={() => onCreate(siteId, group)}>
        + New
      </Button>
    </div>
  );
}

export function SiteScheduleBoard({ sites, schedules, onCreate }: Props) {
  const { boxes, orphans } = buildScheduleBoard(sites, schedules);

  return (
    <div style={{ marginBottom: 'var(--space-5)' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
          gap: 'var(--space-4)',
        }}
      >
        {boxes.map(box => (
          <Card
            key={box.site.id}
            title={box.site.name}
            actions={
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
                  {boxSummary(box.total)}
                </span>
                <Link href={`/dashboard/${box.site.id}`} style={{ textDecoration: 'none' }}>
                  <Button variant="ghost" size="sm">Dashboard</Button>
                </Link>
              </div>
            }
          >
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)',
            }}>
              <GroupColumn group="physician" rows={box.byGroup.physician} siteId={box.site.id} onCreate={onCreate} />
              <GroupColumn group="crna" rows={box.byGroup.crna} siteId={box.site.id} onCreate={onCreate} />
            </div>

            {/* Combined appears only when something is in it — an empty third
                column on every box would be noise, and a schedule with an
                unrecognised group lands here so it is visible rather than
                quietly filed under Physician. */}
            {box.byGroup.both.length > 0 && (
              <div style={{ marginTop: 'var(--space-4)' }}>
                <GroupColumn group="both" rows={box.byGroup.both} siteId={box.site.id} onCreate={onCreate} />
              </div>
            )}
          </Card>
        ))}
      </div>

      {orphans.length > 0 && (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <Banner tone="warn">
            {orphans.length} schedule{orphans.length === 1 ? '' : 's'} could not be
            matched to a site and {orphans.length === 1 ? 'is' : 'are'} listed only
            in the table below: {orphans.map(o => o.schedule_name).join(', ')}.
          </Banner>
        </div>
      )}
    </div>
  );
}
