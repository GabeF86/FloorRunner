// "What the engine actually does", per site.
//
// A server component on purpose: everything here is derived from live data and
// nothing about it is interactive, so it needs no JavaScript at all. The site
// picker is links, not state.
//
// The framing matters as much as the content. A chief reading this needs to
// know that what they are looking at is the REAL contract — not a description
// someone wrote once and forgot to update — which is why every statement
// carries the field it came from.

import Link from 'next/link';
import { Card, Banner } from '@/components/ui';
import { describeSchedulingLogic, type ShiftTypeFacts } from '@/lib/schedulingLogic';
import type { CallPatternDoc } from '@/lib/rulesEngine/callPattern';

export interface SchedulingLogicCardProps {
  sites: Array<{ id: string; name: string }>;
  selectedSiteId: string | null;
  selectedSiteName: string | null;
  doc: CallPatternDoc | null;
  /** True when the stored doc failed validation and CLASSIC is being shown. */
  usingFallback: boolean;
  patternName: string | null;
  shiftTypes: ShiftTypeFacts[];
  parLevel: number | null;
  error: string | null;
}

export default function SchedulingLogicCard(p: SchedulingLogicCardProps) {
  return (
    <Card
      title="How this site schedules"
      actions={
        p.patternName ? (
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
            {p.patternName}
            {p.parLevel ? ` · par ${p.parLevel}` : ''}
          </span>
        ) : undefined
      }
    >
      <p style={{
        fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', lineHeight: 1.6,
        marginBottom: 'var(--space-4)',
      }}>
        Everything below is read from the live call pattern and shift types — it is the
        contract the generator obeys, not a description of it. If a sentence here is
        wrong, the schedule is wrong too.
      </p>

      {p.sites.length > 1 && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1)',
          marginBottom: 'var(--space-4)',
        }}>
          {p.sites.map(s => {
            const on = s.id === p.selectedSiteId;
            return (
              <Link
                key={s.id}
                href={`/rules?site=${s.id}`}
                className={on ? 'fr-seg' : 'fr-seg fr-focus'}
                style={{
                  padding: '4px 10px', borderRadius: 999, textDecoration: 'none',
                  fontSize: 'var(--fs-xs)', fontWeight: on ? 700 : 500,
                  // The selected chip paints its own colour and therefore wins
                  // over .fr-seg's hover, which is the intended arrangement.
                  ...(on
                    ? { background: 'var(--blue)', color: 'var(--on-accent)', border: '1px solid var(--blue)' }
                    : {}),
                }}
              >
                {s.name}
              </Link>
            );
          })}
        </div>
      )}

      {p.error && <Banner tone="error">{p.error}</Banner>}

      {p.usingFallback && (
        <Banner tone="warn">
          This site&rsquo;s stored call pattern did not pass validation, so the engine falls
          back to the built-in classic pattern. What you see below is that fallback — the
          stored document is not being used.
        </Banner>
      )}

      {!p.error && !p.doc && (
        <Banner tone="info">
          This site has no active call pattern, so the engine uses its built-in classic
          structure. Define a pattern under Block Prep to change how it builds.
        </Banner>
      )}

      {p.doc && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
          {describeSchedulingLogic({
            doc: p.doc, shiftTypes: p.shiftTypes, parLevel: p.parLevel,
          }).map(section => (
            <section key={section.key}>
              <h3 style={{
                fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: 1,
                color: 'var(--text-dim)', fontWeight: 700,
                paddingBottom: 5, marginBottom: 'var(--space-2)',
                borderBottom: '1px solid var(--border-faint)',
              }}>
                {section.title}
              </h3>

              {section.statements.length === 0 ? (
                <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', fontStyle: 'italic' }}>
                  {section.emptyNote}
                </p>
              ) : (
                <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                  {section.statements.map((s, i) => (
                    <li key={i} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline' }}>
                      <span aria-hidden="true" style={{
                        color: 'var(--border-strong)', fontSize: 9, flexShrink: 0, lineHeight: 1.9,
                      }}>
                        ●
                      </span>
                      <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text)', lineHeight: 1.55 }}>
                        {s.text}
                        {s.source && (
                          // The provenance is what makes this checkable rather
                          // than merely readable: a wrong sentence names the
                          // field to go and look at.
                          <span style={{
                            marginLeft: 6, fontSize: 'var(--fs-xs)', color: 'var(--text-faint)',
                            fontFamily: 'var(--font-mono), ui-monospace, monospace',
                          }}>
                            {s.source}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}
