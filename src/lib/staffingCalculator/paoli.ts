// Paoli Hospital staffing calculator.
// Ported verbatim (TypeScript) from the standalone "UAS Staff Optimizer"
// prototype (~/Desktop/UAS Staff Optimizer/index.html). Algorithm details
// are Paoli-specific — Floor Runner role (capped at 3 CRNAs), Endo/OB
// always staffed, EP/Neuro toggles, TEEs handled by Endo MD's CRNAs, and
// the MD Solo Priority flag. Don't generalize without verifying each
// branch against the original.

import {
  AvailableStaff,
  CalculatorConfig,
  CalculatorOutput,
  ConfigField,
  Contingency,
  FacilityCalculator,
  StaffAssignment,
} from './types';

const FR_MAX = 3; // Floor Runner hard cap on supervised CRNAs

const SCHEMA: ConfigField[] = [
  // MAIN OR
  { key: 'mainORCount', label: 'Main ORs',          section: 'Main OR (4th Floor)', kind: 'number', defaultValue: 7, min: 0, max: 11, accentColor: '#4A90D9' },
  { key: 'addOnRooms',  label: 'Add-on rooms',      section: 'Main OR (4th Floor)', kind: 'number', defaultValue: 0, min: 0, max: 3,  accentColor: '#E8C854' },
  // OFF-SITE TOGGLES
  { key: 'epLab',       label: 'EP Lab',            section: 'Off-sites',           kind: 'toggle', defaultValue: false, accentColor: '#29B6F6' },
  { key: 'neuroLab',    label: 'Neuro Lab',         section: 'Off-sites',           kind: 'toggle', defaultValue: false, helpText: 'Neurointerventional', accentColor: '#FFD93D' },
  { key: 'tees',        label: 'TEEs / Cardio',     section: 'Off-sites',           kind: 'toggle', defaultValue: false, helpText: 'Float CRNAs + Endo MD coverage', accentColor: '#CE93D8' },
  // OPTIONS
  { key: 'soloPri',     label: 'MD Solo Priority',  section: 'Options',             kind: 'toggle', defaultValue: false, helpText: 'Use solo MDs in EP / Neuro instead of supervised CRNAs', accentColor: '#B06AE8' },
];

const DEFAULT_CONFIG: CalculatorConfig = Object.fromEntries(
  SCHEMA.map((f) => [f.key, f.defaultValue]),
);

interface MutableAssignment extends StaffAssignment {
  supervises: string[];
}

function calculatePaoli(cfgIn: CalculatorConfig, avail: AvailableStaff): CalculatorOutput {
  const cfg = {
    mainORCount: Number(cfgIn.mainORCount ?? 0),
    addOnRooms:  Number(cfgIn.addOnRooms ?? 0),
    epLab:       Boolean(cfgIn.epLab ?? false),
    neuroLab:    Boolean(cfgIn.neuroLab ?? false),
    tees:        Boolean(cfgIn.tees ?? false),
    soloPri:     Boolean(cfgIn.soloPri ?? false),
  };

  const totalORs = cfg.mainORCount + cfg.addOnRooms;
  const asgn: MutableAssignment[] = [];
  let mdt = 0, crt = 0;
  const contingencies: Contingency[] = [];
  const push = (o: MutableAssignment) => { asgn.push(o); return o; };

  // ── Always-on roles ──
  const obMD = push({ id: `md-${mdt++}`, type: 'MD', role: 'OB MD', site: 'OB',
    supervises: [], isSolo: true,
    notes: 'Covers L&D, epidurals, C-sections. Can float when not busy.' });

  const endoMD = push({ id: `md-${mdt++}`, type: 'MD', role: 'Endo MD', site: 'Endoscopy',
    supervises: [], isSolo: true,
    notes: 'Covers GI solo. Supervises float CRNAs for TEEs.' });

  const floor = push({ id: `md-${mdt++}`, type: 'MD', role: 'Floor Runner', site: 'Main OR',
    supervises: [], isSolo: false, isFloorRunner: true,
    notes: `Schedule mgmt, intubations, epidurals. Max ${FR_MAX} CRNAs.` });

  // ── Solo-priority off-sites ──
  if (cfg.epLab && cfg.soloPri) {
    push({ id: `md-${mdt++}`, type: 'MD', role: 'EP Lab MD', site: 'EP Lab',
      supervises: [], isSolo: true, notes: 'EP solo (MD Priority).' });
  }
  if (cfg.neuroLab && cfg.soloPri) {
    push({ id: `md-${mdt++}`, type: 'MD', role: 'Neuro Lab MD', site: 'Neuro Lab',
      supervises: [], isSolo: true, notes: 'Neuro solo (MD Priority).' });
  }

  // ── Main OR supervising MDs ──
  // Bracketed: 4 MDs at ≥10 ORs, 3 at ≥8, else ceil(N/3) with floor 1.
  // The Floor Runner counts as one supervisor, so we add (minOR_MDs - 1) extras.
  const minOR_MDs = totalORs >= 10 ? 4
                  : totalORs >= 8 ? 3
                  : totalORs >= 1 ? Math.max(1, Math.ceil(totalORs / 3))
                  : 0;
  const addMDs = Math.max(0, minOR_MDs - 1);
  const orMDs: MutableAssignment[] = [];
  for (let i = 0; i < addMDs; i++) {
    orMDs.push(push({ id: `md-${mdt++}`, type: 'MD', role: `OR Supv ${i + 1}`, site: 'Main OR',
      supervises: [], isSolo: false, notes: '1:3 ratio target.' }));
  }

  // At ≥10 ORs we promote the last OR Supv MD to running a solo case in 1 OR.
  let soloOR = false;
  if (totalORs >= 10 && minOR_MDs >= 4 && orMDs.length > 0) {
    soloOR = true;
    const s = orMDs[orMDs.length - 1];
    s.role = 'Main OR (Solo)'; s.isSolo = true; s.notes = 'Solo case in 1 OR.';
  }

  // ── OR CRNAs ──
  const orCRNAcount = soloOR ? totalORs - 1 : totalORs;
  const orCRNAs: MutableAssignment[] = [];
  for (let i = 0; i < orCRNAcount; i++) {
    const label = i < cfg.mainORCount ? `OR ${i + 1}` : `Add-On ${i - cfg.mainORCount + 1}`;
    orCRNAs.push(push({ id: `crna-${crt++}`, type: 'CRNA', role: label, site: 'Main OR',
      supervisedBy: null, isAddOn: i >= cfg.mainORCount, supervises: [] }));
  }

  // Distribute CRNAs to supervising MDs — Floor Runner first up to its cap,
  // then round-robin across remaining supervisors.
  const supMDs: MutableAssignment[] = [floor, ...orMDs.filter((m) => !m.isSolo)];
  let ci = 0;
  if (supMDs.length > 0 && orCRNAs.length > 0) {
    const fc = Math.min(FR_MAX, Math.ceil(orCRNAs.length / supMDs.length));
    for (let i = 0; i < fc && ci < orCRNAs.length; i++) {
      orCRNAs[ci].supervisedBy = floor.id;
      floor.supervises.push(orCRNAs[ci].id);
      ci++;
    }
    const others = supMDs.slice(1);
    if (others.length > 0) {
      let mi = 0;
      while (ci < orCRNAs.length) {
        const m = others[mi % others.length];
        orCRNAs[ci].supervisedBy = m.id;
        m.supervises.push(orCRNAs[ci].id);
        ci++; mi++;
      }
    } else {
      while (ci < orCRNAs.length && floor.supervises.length < FR_MAX) {
        orCRNAs[ci].supervisedBy = floor.id;
        floor.supervises.push(orCRNAs[ci].id);
        ci++;
      }
    }
  }

  // Helper: place a CRNA under any supervising MD with capacity, falling
  // back to a solo MD if no supervisor has room (1:3 for OR MDs, 1:3 for FR).
  const tryAssignCRNA = (role: string, site: string): MutableAssignment => {
    const av = supMDs.find((m) => {
      const cap = m.isFloorRunner ? FR_MAX : 4;
      return m.supervises.length < cap && !m.isSolo;
    });
    if (av) {
      const c = push({ id: `crna-${crt++}`, type: 'CRNA', role, site,
        supervisedBy: av.id, supervises: [] });
      av.supervises.push(c.id);
      return c;
    }
    return push({ id: `md-${mdt++}`, type: 'MD', role: `${role} MD`, site,
      supervises: [], isSolo: true, notes: `${role} solo — no MD capacity.` });
  };

  if (cfg.epLab && !cfg.soloPri) tryAssignCRNA('EP Lab', 'EP Lab');
  if (cfg.neuroLab && !cfg.soloPri) tryAssignCRNA('Neuro Lab', 'Neuro Lab');

  // ── Float staffing — auto-decide MD float vs CRNA floats ──
  // Estimate: with 2 CRNA floats (normal), would we be short on CRNAs but
  // have spare MDs? If so, drop in an MD float to save a CRNA slot.
  const mdsSoFar = asgn.filter((a) => a.type === 'MD').length;
  const crnasSoFar = asgn.filter((a) => a.type === 'CRNA').length;

  const crnasWith2Floats = crnasSoFar + 2;
  const mdSurplus = avail.mds - mdsSoFar;
  const crnaDeficit = crnasWith2Floats - avail.crnas;
  const useMDFloat = mdSurplus >= 1 && crnaDeficit >= 1;

  const floatCRNAs: MutableAssignment[] = [];
  let mdFloat: MutableAssignment | null = null;

  if (useMDFloat) {
    mdFloat = push({ id: `md-${mdt++}`, type: 'MD', role: 'Float MD', site: 'Float',
      supervises: [], isSolo: true, isFloat: true,
      notes: 'MD float — covers TEEs solo, break relief, add-on cases. Saves 1 CRNA.' });

    const crnasWith1Float = crnasSoFar + 1;
    const stillShort = crnasWith1Float > avail.crnas;

    if (!stillShort) {
      // 1 CRNA float for Endo coverage / break relief
      if (cfg.tees) {
        const endoCRNA = push({ id: `crna-${crt++}`, type: 'CRNA', role: 'Endo Float', site: 'Endoscopy',
          supervisedBy: endoMD.id, supervises: [],
          notes: 'Covers GI cases and break relief under Endo MD.' });
        endoMD.supervises.push(endoCRNA.id);
        floatCRNAs.push(endoCRNA);
        endoMD.notes = 'Covers GI solo + supervises Endo float. Float MD handles TEEs.';
      } else {
        const c = push({ id: `crna-${crt++}`, type: 'CRNA', role: 'Float 1', site: 'Float',
          supervisedBy: endoMD.id, supervises: [],
          notes: 'Breaks, GI overflow, add-ons.' });
        endoMD.supervises.push(c.id);
        floatCRNAs.push(c);
      }
    } else {
      mdFloat.notes = 'MD float — covers TEEs solo, Endo backup, break relief, add-ons. No CRNA floats available.';
      if (cfg.tees) {
        endoMD.notes = 'Covers GI solo. Float MD handles TEEs independently.';
      }
    }
  } else {
    // Standard: 2 CRNA floats
    if (cfg.tees) {
      // TEEs ON → Float 1 covers TEEs, Float 2 covers Endo, both under Endo MD
      const teeCRNA = push({ id: `crna-${crt++}`, type: 'CRNA', role: 'TEE Float', site: 'TEEs',
        supervisedBy: endoMD.id, supervises: [],
        notes: 'Covers TEEs/Cardioversions under Endo MD.' });
      endoMD.supervises.push(teeCRNA.id);
      floatCRNAs.push(teeCRNA);

      const endoCRNA = push({ id: `crna-${crt++}`, type: 'CRNA', role: 'Endo Float', site: 'Endoscopy',
        supervisedBy: endoMD.id, supervises: [],
        notes: 'Covers GI cases, breaks, add-ons under Endo MD.' });
      endoMD.supervises.push(endoCRNA.id);
      floatCRNAs.push(endoCRNA);

      endoMD.notes = 'Covers GI solo + supervises TEE and Endo floats.';
    } else {
      // TEEs OFF: both floats are general-purpose under Endo MD
      for (let i = 0; i < 2; i++) {
        const c = push({ id: `crna-${crt++}`, type: 'CRNA', role: `Float ${i + 1}`, site: 'Float',
          supervisedBy: endoMD.id, supervises: [],
          notes: i === 0 ? 'Breaks, TEEs, add-ons.' : 'Breaks, GI overflow, trauma.' });
        endoMD.supervises.push(c.id);
        floatCRNAs.push(c);
      }
    }
  }

  // ── Contingency lines ──
  const pickLeastLoadedMD = (exclude: string[] = []): MutableAssignment => {
    const candidates = supMDs
      .filter((m) => !m.isSolo && !exclude.includes(m.id))
      .sort((a, b) => a.supervises.length - b.supervises.length);
    return candidates[0] || floor;
  };

  // Trauma: float CRNA → least-loaded Main OR MD. If MD float is in play, it covers directly.
  if (useMDFloat && floatCRNAs.length === 0 && mdFloat) {
    contingencies.push({
      fromId: mdFloat.id, toId: mdFloat.id,
      type: 'trauma', label: 'Trauma — Float MD covers directly',
    });
  } else {
    const traumaFloat = floatCRNAs.length > 1 ? floatCRNAs[1] : floatCRNAs[0];
    if (traumaFloat) {
      const traumaMD = pickLeastLoadedMD();
      contingencies.push({
        fromId: traumaMD.id, toId: traumaFloat.id,
        type: 'trauma', label: 'Trauma coverage (20%)',
      });
    }
  }

  // Neuro add-on contingency only when Neuro isn't already staffed.
  if (!cfg.neuroLab) {
    if (useMDFloat && mdFloat) {
      contingencies.push({
        fromId: mdFloat.id, toId: mdFloat.id,
        type: 'neuro', label: 'Neuro add-on — Float MD covers solo',
      });
    } else {
      const neuroFloat = cfg.tees ? (floatCRNAs[1] || floatCRNAs[0]) : floatCRNAs[0];
      if (neuroFloat) {
        const traumaMDId = contingencies.find((c) => c.type === 'trauma')?.fromId;
        const neuroMD = pickLeastLoadedMD(traumaMDId ? [traumaMDId] : []);
        contingencies.push({
          fromId: neuroMD.id, toId: neuroFloat.id,
          type: 'neuro', label: 'Neuro add-on (35-50%)',
        });
      }
    }
  }

  // TEEs backup: when TEEs are on with no MD float, Floor Runner backs up the TEE float.
  if (cfg.tees && !useMDFloat && floatCRNAs[0]) {
    contingencies.push({
      fromId: floor.id, toId: floatCRNAs[0].id,
      type: 'teeBackup', label: 'TEE backup — if float pulled',
    });
  }

  // Add-on flex — if add-on rooms don't run, the assigned CRNA covers TEEs/breaks.
  if (cfg.addOnRooms > 0) {
    const addOnCRNA = asgn.find((a) => a.isAddOn);
    if (addOnCRNA) {
      contingencies.push({
        fromId: endoMD.id, toId: addOnCRNA.id,
        type: 'addOnFlex', label: 'Add-on → TEEs/Breaks if unused',
      });
    }
  }

  // ── Notes ──
  const mds = asgn.filter((a) => a.type === 'MD');
  const crnas = asgn.filter((a) => a.type === 'CRNA');
  const notes: string[] = [];

  if (useMDFloat) {
    notes.push(`🩺 MD Float assigned — ${mdSurplus} surplus MD${mdSurplus > 1 ? 's' : ''}, ${crnaDeficit} CRNA${crnaDeficit > 1 ? 's' : ''} short. MD covers TEEs/breaks solo, saving ${floatCRNAs.length === 0 ? '2' : '1'} CRNA float${floatCRNAs.length === 0 ? 's' : ''}.`);
  }
  if (cfg.soloPri) notes.push('🔷 MD Solo Priority — MDs solo in EP/Neuro instead of CRNAs.');
  if (totalORs >= 10) notes.push('⚠️ High OR volume — 4 MDs on Main OR supervision.');
  if (cfg.addOnRooms > 0) {
    notes.push(`📌 ${cfg.addOnRooms} add-on room${cfg.addOnRooms > 1 ? 's' : ''} factored into staffing (${cfg.mainORCount} scheduled + ${cfg.addOnRooms} add-on = ${totalORs} total).`);
    notes.push('♻️ If add-on rooms don\'t run, those CRNAs can cover TEEs or breaks.');
  }
  if (cfg.epLab && cfg.neuroLab && !cfg.soloPri) notes.push('EP & Neuro active — CRNAs under Main OR MDs.');
  if (cfg.tees && !useMDFloat) notes.push('💜 TEEs active — Endo MD supervises both TEE Float and Endo Float.');
  if (cfg.tees && useMDFloat) notes.push('💜 TEEs active — Float MD handles TEEs independently.');
  if (cfg.tees && !useMDFloat) notes.push('🔶 If a float gets pulled (trauma/neuro), Floor Runner backs up TEEs.');
  if (!cfg.tees && !useMDFloat) notes.push('TEEs not scheduled — both floats in general float pool.');
  if (!cfg.tees && useMDFloat) notes.push('TEEs not scheduled — Float MD available for breaks/add-ons.');
  notes.push(`Floor Runner hard-capped at ${FR_MAX} CRNAs.`);
  notes.push('OB MD floats for TEEs/breaks when available.');
  notes.push('🔴 Trauma (20%): ' + (useMDFloat && floatCRNAs.length === 0 ? 'Float MD covers directly.' : 'Float CRNA supervised by Main OR MD.'));
  if (!cfg.neuroLab) notes.push('🟡 Neuro add-on (35-50%): ' + (useMDFloat ? 'Float MD covers solo.' : 'Float CRNA covers under Main OR MD.'));

  // ── Break Coverage Analysis ──
  // Same shape as Lankenau so the UI panel renders consistently.
  // Providers needing breaks: any room provider that isn't a float, isn't the
  // Floor Runner (they manage their own coverage), and isn't a supervising MD
  // (those rotate between cases).
  const provNeedingBreaks = asgn.filter((a) =>
    !a.isFloat && a.site !== 'Float' && !a.isFloorRunner &&
    (a.type === 'CRNA' || (a.type === 'MD' && a.isSolo))
  );
  const breakDemand = provNeedingBreaks.length;

  const totalFloats = floatCRNAs.length + (mdFloat ? 1 : 0);
  const bkFloats = totalFloats * 5;
  const bkOB = 1;
  const bkEndoMD = endoMD.supervises.length === 0 ? 1 : 0;
  const bkFloorRunner = floor.supervises.length < FR_MAX ? 1 : 0;
  // Supervising OR MDs at ≥1:3 can give one of their CRNAs a break by floating in.
  const supMDsWith3 = orMDs.filter((m) => !m.isSolo && m.supervises.length >= 3).length;

  const breakSources = [
    { label: 'Floats',         count: totalFloats,    breaks: bkFloats,       detail: `${totalFloats} × 5` },
    { label: 'OB MD',          count: 1,              breaks: bkOB,           detail: 'between cases' },
    ...(bkEndoMD > 0 ? [{ label: 'Endo MD', count: 1, breaks: bkEndoMD, detail: 'when GI quiet' }] : []),
    ...(bkFloorRunner > 0 ? [{ label: 'Floor Runner', count: 1, breaks: bkFloorRunner, detail: 'spare capacity' }] : []),
    ...(supMDsWith3 > 0 ? [{ label: 'Supv MDs (≥1:3)', count: supMDsWith3, breaks: supMDsWith3, detail: `${supMDsWith3} × 1` }] : []),
  ];

  const breakCapacity = breakSources.reduce((sum, s) => sum + s.breaks, 0);
  const breakGap = breakDemand - breakCapacity;
  const breakPct = breakDemand > 0 ? Math.round((breakCapacity / breakDemand) * 100) : 100;
  const breakAnalysis = {
    demand: breakDemand,
    capacity: breakCapacity,
    sources: breakSources,
    gap: breakGap,
    pct: Math.min(breakPct, 100),
    severity: (breakPct >= 100 ? 'ok' : breakPct >= 75 ? 'tight' : breakPct >= 50 ? 'warning' : 'critical') as 'ok' | 'tight' | 'warning' | 'critical',
    unrelieved: Math.max(0, breakGap),
  };

  notes.push('── BREAK COVERAGE ──');
  breakSources.forEach((s) => notes.push(`  ☕ ${s.label}: ${s.breaks} break${s.breaks !== 1 ? 's' : ''} (${s.detail})`));
  notes.push(`  📊 Total: ${breakCapacity} break slots for ${breakDemand} providers needing breaks`);
  if (breakAnalysis.severity === 'ok')       notes.push(`  ✅ Coverage sufficient (${breakPct}%).`);
  if (breakAnalysis.severity === 'tight')    notes.push(`  ⚠️ Coverage tight (${breakPct}%). Some breaks may be delayed.`);
  if (breakAnalysis.severity === 'warning')  notes.push(`  🔴 Coverage strained (${breakPct}%). ${breakAnalysis.unrelieved} providers may not get timely breaks.`);
  if (breakAnalysis.severity === 'critical') notes.push(`  🚨 CRITICAL (${breakPct}%). ${breakAnalysis.unrelieved} providers will not get breaks without pulling coverage.`);

  // Suppress unused-var lint for `obMD` — referenced indirectly via `asgn`.
  void obMD;

  return {
    totalMDs: mds.length,
    totalCRNAs: crnas.length,
    totalStaff: mds.length + crnas.length,
    assignments: asgn,
    notes,
    contingencies,
    breakAnalysis,
  };
}

export const paoliCalculator: FacilityCalculator = {
  facilityId: 'Paoli Hospital',
  facilityName: 'Paoli Hospital',
  abbreviation: 'Paoli',
  schema: SCHEMA,
  defaultConfig: DEFAULT_CONFIG,
  calculate: calculatePaoli,
  status: 'ready',
  siteCatalog: [
    { key: 'Main OR',   label: 'Main OR (4th Floor)', color: '#4A90D9', icon: '🏥' },
    { key: 'EP Lab',    label: 'EP Lab',              color: '#29B6F6', icon: '⚡' },
    { key: 'Neuro Lab', label: 'Neuro Lab',           color: '#FFD93D', icon: '🧠' },
    { key: 'Endoscopy', label: 'Endoscopy (GI)',      color: '#8BC34A', icon: '🔬' },
    { key: 'TEEs',      label: 'TEEs / Cardio',       color: '#CE93D8', icon: '💜' },
    { key: 'OB',        label: 'OB / L&D',            color: '#E88AD0', icon: '👶' },
    { key: 'Float',     label: 'Float Pool',          color: '#80CBC4', icon: '🔄' },
  ],
};
