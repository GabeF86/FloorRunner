'use client';

// Sites & Credentials tab of /providers/[id] — one Card per site the provider
// is credentialed at, its four call permissions, and the expandable detail
// panel (effective dates, allowed/excluded shift types, skill tags, notes).
//
// DYNAMICALLY IMPORTED by page.tsx. It is also the heaviest non-Availability
// tab by dependency: the expanded panel pulls in SiteShiftTypePicker, which
// fetches and renders a whole site's shift-type list and has no business being
// in the initial chunk of a route that opens on the Profile tab.
//
// TagInput comes from ./pickers, shared with the Preferences tab — the skill-tag
// editor here IS that editor, not a second copy of it.

import { useState } from 'react';
import { SiteShiftTypePicker } from '@/components/ShiftTypePicker';
import { Banner, Button, Card, EmptyState } from '@/components/ui';
import type { SiteCredential } from './profileShared';
import {
  fieldLabelStyle, fieldInputStyle,
  Toggle, FormGrid, Stack, TabStack,
} from './ui';
import { TagInput } from './pickers';

export function SitesTab({ providerId, credentials, sites, onChanged }: {
  providerId: string;
  credentials: SiteCredential[];
  sites: Array<{ id: string; name: string; short_name: string | null }>;
  onChanged: () => void;
}) {
  const [addSiteId, setAddSiteId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const credentialedSiteIds = new Set(credentials.map(c => c.site_id));
  const availableSites = sites.filter(s => !credentialedSiteIds.has(s.id));

  const post = async (body: Record<string, unknown>) => {
    const res = await fetch(`/api/scheduling/providers/${providerId}/site-credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Failed (${res.status})`);
    }
  };

  const addSite = async () => {
    if (!addSiteId) return;
    setBusy(true); setError(null);
    try {
      await post({ site_id: addSiteId, credentialed: true, is_active: true });
      setAddSiteId('');
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add');
    } finally { setBusy(false); }
  };

  // Send ONLY what changed. This used to post the whole row, rebuilt from the
  // `cred` prop — and that prop does not refresh until onChanged() completes a
  // refetch, so two toggles clicked before it landed both read the same stale
  // base and the second silently reverted the first. Sending just the patch
  // makes that structurally impossible: the client never transmits a value it
  // did not itself just set. The endpoint does the merge (route.helpers.ts).
  const updateCred = async (siteId: string, patch: Partial<SiteCredential>) => {
    setBusy(true); setError(null);
    try {
      await post({ site_id: siteId, ...patch });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update');
    } finally { setBusy(false); }
  };

  const removeSite = async (siteId: string) => {
    if (!confirm('Remove this site credential?')) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/scheduling/providers/${providerId}/site-credentials?site_id=${siteId}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to remove');
      }
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove');
    } finally { setBusy(false); }
  };

  return (
    <TabStack>
      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}

      {/* Add new site */}
      {availableSites.length > 0 && (
        <Card>
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'stretch' }}>
            <select
              value={addSiteId}
              onChange={e => setAddSiteId(e.target.value)}
              aria-label="Credential at a new site"
              className="fr-field"
              style={{ ...fieldInputStyle, flex: 1 }}
            >
              <option value="">+ Credential at a new site...</option>
              {availableSites.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <Button onClick={addSite} disabled={!addSiteId || busy}>Add</Button>
          </div>
        </Card>
      )}

      {credentials.length === 0 ? (
        <Card pad={false}>
          <EmptyState
            icon="⬡"
            title="No site credentials yet"
            hint="Credential this provider at a hospital or surgery center to make them schedulable there."
          />
        </Card>
      ) : (
        // One Card per site. Each site is a self-contained unit of decisions
        // (credentialed / active / four call permissions, plus an optional
        // detail panel), so it earns its own surface — where the availability
        // rows, which are one-line facts, deliberately do not.
        credentials.map(c => (
          <Card
            key={c.id}
            title={c.sites?.name || c.site_id}
            actions={
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setExpanded(expanded === c.id ? null : c.id)}
                  disabled={busy}
                  ariaExpanded={expanded === c.id}
                >
                  {expanded === c.id ? 'Less' : 'More'}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => removeSite(c.site_id)}
                  disabled={busy}
                >
                  Remove
                </Button>
              </>
            }
          >
            <FormGrid cols="repeat(auto-fit, minmax(180px, 1fr))" style={{ gap: 'var(--space-2)' }}>
              <Toggle label="Credentialed" checked={c.credentialed} onChange={v => updateCred(c.site_id, { credentialed: v })} />
              <Toggle label="Active" checked={c.is_active} onChange={v => updateCred(c.site_id, { is_active: v })} />
              <Toggle label="Can Take Call" checked={c.can_take_call} onChange={v => updateCred(c.site_id, { can_take_call: v })} />
              <Toggle label="Weekend Call" checked={c.can_take_weekend_call} onChange={v => updateCred(c.site_id, { can_take_weekend_call: v })} />
              <Toggle label="Holiday Call" checked={c.can_take_holiday_call} onChange={v => updateCred(c.site_id, { can_take_holiday_call: v })} />
              <Toggle label="Backup Call" checked={c.can_take_backup_call} onChange={v => updateCred(c.site_id, { can_take_backup_call: v })} />
            </FormGrid>

            {expanded === c.id && (
              <div style={{ marginTop: 'var(--space-4)', paddingTop: 'var(--space-4)', borderTop: '1px solid var(--border-faint)' }}>
                <Stack>
                  <FormGrid cols="1fr 1fr">
                    <div style={{ minWidth: 0 }}>
                      <label style={fieldLabelStyle}>Effective Start</label>
                      <input
                        type="date"
                        value={c.effective_start_date || ''}
                        onChange={e => updateCred(c.site_id, { effective_start_date: e.target.value || null })}
                        className="fr-field"
                        style={fieldInputStyle}
                      />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <label style={fieldLabelStyle}>Effective End</label>
                      <input
                        type="date"
                        value={c.effective_end_date || ''}
                        onChange={e => updateCred(c.site_id, { effective_end_date: e.target.value || null })}
                        className="fr-field"
                        style={fieldInputStyle}
                      />
                    </div>
                  </FormGrid>
                  {/* accent stays a literal hex here: SiteShiftTypePicker is
                      shared with other pages and builds its own tints by
                      concatenating an alpha onto this string. */}
                  <SiteShiftTypePicker
                    siteId={c.site_id}
                    label="Allowed Shift Types (if set, ONLY these are allowed)"
                    values={c.allowed_shift_types}
                    onChange={next => updateCred(c.site_id, { allowed_shift_types: next })}
                    accent="var(--ok)"
                  />
                  <SiteShiftTypePicker
                    siteId={c.site_id}
                    label="Excluded Shift Types"
                    values={c.excluded_shift_types}
                    onChange={next => updateCred(c.site_id, { excluded_shift_types: next })}
                    accent="var(--danger)"
                  />
                  <TagInput
                    label="Skill Tags"
                    values={c.skill_tags}
                    onChange={next => updateCred(c.site_id, { skill_tags: next })}
                    placeholder="e.g. trauma-level-1, pediatric..."
                    tone="info"
                  />
                  <div>
                    <label style={fieldLabelStyle}>Notes</label>
                    <input
                      value={c.notes || ''}
                      onChange={e => updateCred(c.site_id, { notes: e.target.value || null })}
                      placeholder="Site-specific notes..."
                      className="fr-field"
                      style={fieldInputStyle}
                    />
                  </div>
                </Stack>
              </div>
            )}
          </Card>
        ))
      )}
    </TabStack>
  );
}
