'use client';

// The four value pickers of /providers/[id], plus the control row they share.
//
// They live in a module of their own because TWO deferred tabs need them —
// Preferences (all four) and Sites & Credentials (TagInput, for a credential's
// skill tags). Copying TagInput into both is exactly the failure this codebase
// keeps paying for: two chip editors that agree today and drift the first time
// one of them learns a new rule. One definition, imported twice.
//
// It is deliberately NOT imported by page.tsx, only by the two dynamic tabs,
// so webpack keeps it out of the route's initial chunk.

import { useState } from 'react';
import { Button, type BadgeTone } from '@/components/ui';
import { fieldLabelStyle, fieldInputStyle, ChipRow, RemovableChip } from './ui';

// The four value pickers below share one shape: a control row (input or
// select + Add) and a run of removable chips beneath it. They used to build
// their own chip tint by concatenating an alpha onto a raw hex `accent`
// (`${accent}20` / `${accent}30`), which meant four dark-theme colours painted
// onto the light default. They now take a semantic tone and get their colours
// from the kit's BADGE_TONES.
//
// `accent` survives ONLY where it crosses into SiteShiftTypePicker and
// CalendarMultiPicker: those are shared components used by other pages, and
// they concatenate the alpha themselves, so they require a literal hex.

function PickerControls({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'stretch' }}>{children}</div>;
}

export function TagInput({ label, values, onChange, placeholder, tone = 'info' }: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  tone?: BadgeTone;
}) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const v = draft.trim();
    if (!v || values.includes(v)) { setDraft(''); return; }
    onChange([...values, v]);
    setDraft('');
  };

  return (
    <div>
      <label style={fieldLabelStyle}>{label}</label>
      <PickerControls>
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder={placeholder}
          className="fr-field"
          style={{ ...fieldInputStyle, flex: 1 }}
        />
        <Button variant="secondary" onClick={add} disabled={!draft.trim()}>Add</Button>
      </PickerControls>
      {values.length > 0 && (
        <ChipRow>
          {values.map(v => (
            <RemovableChip key={v} label={v} tone={tone} onRemove={() => onChange(values.filter(x => x !== v))} />
          ))}
        </ChipRow>
      )}
    </div>
  );
}

export function OptionPicker({
  label, values, onChange, options, excludeOptions = [], tone = 'info',
}: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  options: readonly string[];
  // Options to hide from the dropdown (but still show in selected tags if
  // present). Used e.g. to exclude the primary fellowship from the
  // additional-fellowships picker.
  excludeOptions?: string[];
  tone?: BadgeTone;
}) {
  const [sel, setSel] = useState('');
  const available = options.filter(o => !values.includes(o) && !excludeOptions.includes(o));

  const add = () => {
    if (!sel || values.includes(sel)) return;
    onChange([...values, sel]);
    setSel('');
  };

  return (
    <div>
      <label style={fieldLabelStyle}>{label}</label>
      <PickerControls>
        <select value={sel} onChange={e => setSel(e.target.value)} className="fr-field" style={{ ...fieldInputStyle, flex: 1 }}>
          <option value="">Select...</option>
          {available.map(o => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
        <Button variant="secondary" onClick={add} disabled={!sel}>Add</Button>
      </PickerControls>
      {values.length > 0 && (
        <ChipRow>
          {values.map(v => (
            <RemovableChip
              key={v}
              label={v}
              tone={tone}
              // A value no longer in the canonical list is kept and marked
              // rather than dropped, so loading a legacy row can't wipe it.
              note={(options as readonly string[]).includes(v) ? undefined : '(legacy)'}
              onRemove={() => onChange(values.filter(x => x !== v))}
            />
          ))}
        </ChipRow>
      )}
    </div>
  );
}

export function SitePicker({ label, values, onChange, sites, tone = 'info' }: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  sites: Array<{ id: string; name: string; short_name: string | null }>;
  tone?: BadgeTone;
}) {
  const [sel, setSel] = useState('');
  const available = sites.filter(s => !values.includes(s.id));

  const add = () => {
    if (!sel) return;
    onChange([...values, sel]);
    setSel('');
  };

  const nameOf = (id: string) => sites.find(s => s.id === id)?.name || id;

  return (
    <div>
      <label style={fieldLabelStyle}>{label}</label>
      <PickerControls>
        <select value={sel} onChange={e => setSel(e.target.value)} className="fr-field" style={{ ...fieldInputStyle, flex: 1 }}>
          <option value="">Select a site...</option>
          {available.map(s => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <Button variant="secondary" onClick={add} disabled={!sel}>Add</Button>
      </PickerControls>
      {values.length > 0 && (
        <ChipRow>
          {values.map(id => (
            <RemovableChip
              key={id}
              label={nameOf(id)}
              tone={tone}
              onRemove={() => onChange(values.filter(x => x !== id))}
            />
          ))}
        </ChipRow>
      )}
    </div>
  );
}

export function DateListEditor({ values, onChange }: { values: string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState('');

  const add = () => {
    if (!draft || values.includes(draft)) { setDraft(''); return; }
    onChange([...values, draft].sort());
    setDraft('');
  };

  return (
    <div>
      <PickerControls>
        <input
          type="date"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          className="fr-field"
          style={{ ...fieldInputStyle, flex: 1 }}
        />
        <Button variant="secondary" onClick={add} disabled={!draft}>Add Date</Button>
      </PickerControls>
      {values.length > 0 && (
        <ChipRow>
          {values.map(d => (
            <RemovableChip
              key={d}
              label={d}
              tone="neutral"
              onRemove={() => onChange(values.filter(x => x !== d))}
            />
          ))}
        </ChipRow>
      )}
    </div>
  );
}
