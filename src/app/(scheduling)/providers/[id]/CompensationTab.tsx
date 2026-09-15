'use client';

// Compensation tab of /providers/[id] — salary, stipends, bonuses, employer
// benefit costs, and the live totals panel over them.
//
// DYNAMICALLY IMPORTED by page.tsx. This is the strongest case on the route
// for deferring: the tab is ADMIN ONLY, so the large majority of opens never
// render it at all, yet its form and totals arithmetic used to be parsed and
// shipped on every single load of any provider's profile.

import { useState, useEffect } from 'react';
import { Banner, Button, Card, Spinner } from '@/components/ui';
import {
  fieldLabelStyle, fieldInputStyle, textAreaStyle,
  FormGrid, TabStack, SaveBar,
} from './ui';

interface Compensation {
  base_salary: number | null;
  fellowship_stipend: number | null;
  admin_stipend: number | null;
  retention_bonus: number | null;
  retention_bonus_end_date: string | null;
  health_insurance_cost: number | null;
  malpractice_cost: number | null;
  retirement_401k_contribution: number | null;
  profit_share: number | null;
  notes: string | null;
}

const EMPTY_COMP: Compensation = {
  base_salary: null,
  fellowship_stipend: null,
  admin_stipend: null,
  retention_bonus: null,
  retention_bonus_end_date: null,
  health_insurance_cost: null,
  malpractice_cost: null,
  retirement_401k_contribution: null,
  profit_share: null,
  notes: null,
};

export function CompensationTab({ providerId }: { providerId: string }) {
  const [comp, setComp] = useState<Compensation>(EMPTY_COMP);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/scheduling/providers/${providerId}/compensation`);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error || `Failed (${res.status})`);
          setLoading(false);
          return;
        }
        // API returns {} when no comp row exists.
        setComp({ ...EMPTY_COMP, ...(data || {}) });
        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load');
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [providerId]);

  const patch = <K extends keyof Compensation>(k: K, v: Compensation[K]) => {
    setComp(prev => ({ ...prev, [k]: v }));
    setSavedAt(null);
  };

  const save = async () => {
    setSaving(true); setError(null);
    try {
      const res = await fetch(`/api/scheduling/providers/${providerId}/compensation`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(comp),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Failed (${res.status})`);
        return;
      }
      setComp({ ...EMPTY_COMP, ...data });
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', padding: 'var(--space-5) 0', color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>
        <Spinner /> Loading compensation…
      </div>
    );
  }

  return (
    <TabStack>
      {/* The admin notice was a bespoke amber box with its own tint, border and
          inline ADMIN ONLY chip. It is an inline alert, which the kit has. */}
      <Banner tone="warn">
        <strong>Admin only.</strong> Sensitive compensation data. All values are current-snapshot only — no
        history is retained today. Once authentication and role-based access are wired up, this tab will be
        restricted to admin users.
      </Banner>

      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}

      <Card title="Salary & stipends">
        <FormGrid cols="1fr 1fr">
          <MoneyField label="Base Salary" value={comp.base_salary} onChange={v => patch('base_salary', v)} />
          <MoneyField label="Fellowship Stipend" value={comp.fellowship_stipend} onChange={v => patch('fellowship_stipend', v)} />
          <MoneyField label="Admin Stipend" value={comp.admin_stipend} onChange={v => patch('admin_stipend', v)} />
        </FormGrid>
      </Card>

      <Card title="Bonuses & profit share">
        <FormGrid cols="1fr 1fr">
          <MoneyField label="Retention Bonus" value={comp.retention_bonus} onChange={v => patch('retention_bonus', v)} />
          <div style={{ minWidth: 0 }}>
            <label style={fieldLabelStyle}>Retention Bonus End Date</label>
            <input
              type="date"
              value={comp.retention_bonus_end_date ?? ''}
              onChange={e => patch('retention_bonus_end_date', e.target.value || null)}
              className="fr-field"
              style={fieldInputStyle}
            />
          </div>
          <MoneyField label="Profit Share" value={comp.profit_share} onChange={v => patch('profit_share', v)} />
        </FormGrid>
      </Card>

      <Card title="Benefits & employer costs">
        <FormGrid cols="1fr 1fr">
          <MoneyField label="Health Insurance Cost" value={comp.health_insurance_cost} onChange={v => patch('health_insurance_cost', v)} hint="Annual employer cost" />
          <MoneyField label="Malpractice Cost" value={comp.malpractice_cost} onChange={v => patch('malpractice_cost', v)} hint="Annual employer cost" />
          <MoneyField label="401(k) Contribution" value={comp.retirement_401k_contribution} onChange={v => patch('retirement_401k_contribution', v)} hint="Annual employer contribution" />
        </FormGrid>
      </Card>

      <CompensationTotals comp={comp} />

      <Card title="Notes">
        <textarea
          value={comp.notes ?? ''}
          onChange={e => patch('notes', e.target.value || null)}
          placeholder="Offer letter terms, upcoming raises, special arrangements..."
          aria-label="Compensation notes"
          className="fr-field"
          style={textAreaStyle}
        />
      </Card>

      <SaveBar>
        <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save Changes'}</Button>
        {savedAt && <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--ok)' }}>Saved at {savedAt}</span>}
      </SaveBar>
    </TabStack>
  );
}

// Live-computed totals panel shown between the Benefits section and Notes.
// Reads directly from the draft state so edits are reflected as the admin
// types. Retention bonus + profit share are conceptually lumpy (one-time
// vs. variable) — noted in the footnote rather than excluded, because
// hiding them would surprise admins who just typed them into the form.
//
// It is a Card with a footnote rather than a blue-tinted box: it is the one
// READ-ONLY panel on this tab, and the money is set in mono so the three
// figures align on the decimal.
function CompensationTotals({ comp }: { comp: Compensation }) {
  const sum = (...vals: (number | null)[]) => vals.reduce<number>((a, v) => a + (v ?? 0), 0);
  const providerTotal = sum(
    comp.base_salary,
    comp.fellowship_stipend,
    comp.admin_stipend,
    comp.retention_bonus,
    comp.profit_share,
  );
  const employerExtras = sum(
    comp.health_insurance_cost,
    comp.malpractice_cost,
    comp.retirement_401k_contribution,
  );
  const employerTotal = providerTotal + employerExtras;
  const fmt = (n: number) => n === 0 ? '—' : `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

  const rowStyle: React.CSSProperties = {
    display: 'flex', justifyContent: 'space-between', gap: 'var(--space-4)',
    fontSize: 'var(--fs-sm)', marginBottom: 'var(--space-2)',
  };
  const moneyStyle: React.CSSProperties = {
    fontFamily: 'var(--font-mono), ui-monospace, monospace',
    whiteSpace: 'nowrap',
    // Three figures stacked flush-right that must agree on the decimal.
    fontVariantNumeric: 'tabular-nums',
  };

  return (
    <Card
      title="Totals"
      footer="Retention bonus is typically one-time; profit share varies by year. Adjust with context in the notes field."
    >
      <div style={rowStyle}>
        <span style={{ color: 'var(--text-muted)' }}>Provider Total Compensation</span>
        <span style={{ ...moneyStyle, color: 'var(--text)', fontWeight: 700 }}>{fmt(providerTotal)}</span>
      </div>
      <div style={rowStyle}>
        <span style={{ color: 'var(--text-dim)' }}>+ Employer Costs (health, malpractice, 401k)</span>
        <span style={{ ...moneyStyle, color: 'var(--text-muted)' }}>{fmt(employerExtras)}</span>
      </div>
      <div style={{
        borderTop: '1px solid var(--border-faint)', paddingTop: 'var(--space-3)', marginTop: 'var(--space-3)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 'var(--space-4)',
      }}>
        <span style={{ color: 'var(--text-strong)', fontWeight: 700, fontSize: 'var(--fs-sm)' }}>Total Cost to Employer</span>
        <span style={{ ...moneyStyle, color: 'var(--text-strong)', fontWeight: 700, fontSize: 'var(--fs-lg)' }}>
          {fmt(employerTotal)}
        </span>
      </div>
    </Card>
  );
}

function MoneyField({ label, value, onChange, hint }: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  hint?: string;
}) {
  // Keep a local string so the user can clear the field or type `-` / `.`
  // without React snapping the value to something weird.
  const [raw, setRaw] = useState(value == null ? '' : String(value));
  useEffect(() => { setRaw(value == null ? '' : String(value)); }, [value]);

  return (
    <div style={{ minWidth: 0 }}>
      <label style={fieldLabelStyle}>{label}</label>
      <div style={{ position: 'relative' }}>
        <span aria-hidden="true" style={{
          position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
          color: 'var(--text-dim)', fontSize: 'var(--fs-md)', pointerEvents: 'none',
        }}>$</span>
        <input
          value={raw}
          inputMode="decimal"
          onChange={e => {
            const next = e.target.value;
            setRaw(next);
            if (next === '') { onChange(null); return; }
            const n = Number(next);
            if (Number.isFinite(n)) onChange(n);
          }}
          className="fr-field"
          style={{
            ...fieldInputStyle,
            paddingLeft: 24, // clears the absolutely-positioned $ at left: 10
            fontFamily: 'var(--font-mono), ui-monospace, monospace',
            // It is an inputMode=decimal text field, so the global
            // input[type=number] tabular rule does not reach it.
            fontVariantNumeric: 'tabular-nums',
          }}
        />
      </div>
      {hint && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 'var(--space-1)' }}>{hint}</div>}
    </div>
  );
}
