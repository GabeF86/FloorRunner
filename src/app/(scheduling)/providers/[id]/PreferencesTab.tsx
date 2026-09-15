'use client';

// Preferences & Specialties tab of /providers/[id] — fellowships, skills, the
// preferred/undesired assignment and site pairs, and permanently blocked dates.
//
// DYNAMICALLY IMPORTED by page.tsx, like every tab but Profile: only one tab is
// ever on screen, so the four pickers and the canonical option lists below no
// longer ride along on opens that never leave the Profile tab.
//
// The pickers themselves are in ./pickers — shared with the Sites tab, never
// copied into it.

import { useState, useEffect } from 'react';
import { Card } from '@/components/ui';
import type { EmploymentProfile } from './profileShared';
import {
  fieldLabelStyle, fieldInputStyle,
  SaveButton, Hint, Stack, TabStack, SaveBar,
} from './ui';
import { TagInput, OptionPicker, SitePicker, DateListEditor } from './pickers';

// Canonical lists used by the Preferences tab. Kept in this file for now —
// when we want them to be admin-configurable they should move into the
// organization settings and be fetched.
const FELLOWSHIP_OPTIONS = [
  'Cardiac', 'Pediatric', 'Regional', 'Chronic Pain', 'Neuro', 'Obstetrics',
] as const;

const ASSIGNMENT_OPTIONS = [
  'GI', 'OB', 'Ortho', 'Neuro', 'Peds', 'ENT', 'General Surgery',
  'Thoracic', 'Cardiac', 'EP', 'Neuro Lap', 'EP Lab', 'Trauma',
] as const;

export function PreferencesTab({ profile, sites, saveState, onSave }: {
  profile: EmploymentProfile;
  sites: Array<{ id: string; name: string; short_name: string | null }>;
  saveState: 'idle' | 'saving' | 'saved';
  onSave: (u: Record<string, unknown>) => void;
}) {
  const [fellowshipPrimary, setFellowshipPrimary] = useState(profile.fellowship_primary || '');
  const [fellowships, setFellowships] = useState<string[]>(profile.fellowships);
  const [skills, setSkills] = useState<string[]>(profile.skills);
  const [preferredAssignments, setPreferredAssignments] = useState<string[]>(profile.preferred_assignments);
  const [undesiredAssignments, setUndesiredAssignments] = useState<string[]>(profile.undesired_assignments);
  const [preferredSites, setPreferredSites] = useState<string[]>(profile.preferred_sites);
  const [undesiredSites, setUndesiredSites] = useState<string[]>(profile.undesired_sites);
  const [blockedDates, setBlockedDates] = useState<string[]>(profile.blocked_dates);

  useEffect(() => {
    setFellowshipPrimary(profile.fellowship_primary || '');
    setFellowships(profile.fellowships);
    setSkills(profile.skills);
    setPreferredAssignments(profile.preferred_assignments);
    setUndesiredAssignments(profile.undesired_assignments);
    setPreferredSites(profile.preferred_sites);
    setUndesiredSites(profile.undesired_sites);
    setBlockedDates(profile.blocked_dates);
  }, [profile]);

  const handleSave = () => {
    onSave({
      fellowship_primary: fellowshipPrimary.trim() || null,
      fellowships, skills,
      preferred_assignments: preferredAssignments,
      undesired_assignments: undesiredAssignments,
      preferred_sites: preferredSites,
      undesired_sites: undesiredSites,
      blocked_dates: blockedDates,
    });
  };

  return (
    <TabStack>
      <Card title="Specialties">
        <Stack>
          <div>
            <label style={fieldLabelStyle}>Primary Fellowship / Subspecialty</label>
            <select
              value={fellowshipPrimary}
              onChange={e => setFellowshipPrimary(e.target.value)}
              className="fr-field"
              style={fieldInputStyle}
            >
              <option value="">— None —</option>
              {FELLOWSHIP_OPTIONS.map(f => (
                <option key={f} value={f}>{f}</option>
              ))}
              {fellowshipPrimary && !(FELLOWSHIP_OPTIONS as readonly string[]).includes(fellowshipPrimary) && (
                // Preserve any legacy free-text value so it isn't wiped on load.
                <option value={fellowshipPrimary}>{fellowshipPrimary} (legacy)</option>
              )}
            </select>
          </div>
          <OptionPicker
            label="Additional Fellowships"
            values={fellowships}
            onChange={setFellowships}
            options={FELLOWSHIP_OPTIONS}
            excludeOptions={fellowshipPrimary ? [fellowshipPrimary] : []}
          />
          <TagInput label="Skills" values={skills} onChange={setSkills} placeholder="Add a skill (e.g. TEE, regional, ultrasound)..." />
        </Stack>
      </Card>

      {/* Preferred vs undesired is the one place on this page where colour
          carries the meaning rather than decorating it, so the two pickers are
          --ok and --danger tones and sit in the same card as a matched pair. */}
      <Card title="Assignment preferences">
        <Hint>
          Soft preferences used by the scheduler. Pick from the list of case / service assignments.
        </Hint>
        <Stack>
          <OptionPicker
            label="Preferred Assignments"
            values={preferredAssignments}
            onChange={setPreferredAssignments}
            options={ASSIGNMENT_OPTIONS}
            tone="ok"
          />
          <OptionPicker
            label="Undesired Assignments"
            values={undesiredAssignments}
            onChange={setUndesiredAssignments}
            options={ASSIGNMENT_OPTIONS}
            tone="danger"
          />
        </Stack>
      </Card>

      <Card title="Site preferences">
        <Stack>
          <SitePicker label="Preferred Sites" values={preferredSites} onChange={setPreferredSites} sites={sites} tone="ok" />
          <SitePicker label="Undesired Sites" values={undesiredSites} onChange={setUndesiredSites} sites={sites} tone="danger" />
        </Stack>
      </Card>

      <Card title="Permanently blocked dates">
        <Hint>
          For one-off time off, use the Availability tab. This is for recurring hard-blocks like a standing academic day.
        </Hint>
        <DateListEditor values={blockedDates} onChange={setBlockedDates} />
      </Card>

      <SaveBar>
        <SaveButton onClick={handleSave} canSave={true} saveState={saveState} />
      </SaveBar>
    </TabStack>
  );
}
