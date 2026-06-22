// Paoli Hospital staffing calculator.
// Ported (TypeScript) from the standalone "UAS Staff Optimizer" prototype
// (~/Desktop/UAS Staff Optimizer/index.html). Algorithm details are
// Paoli-specific — Floor Runner role (capped at 3 CRNAs), Endo/OB always
// staffed, EP/Neuro room counts, and the MD Solo Priority flag.
//
// Off-site rooms (EP Lab, Neuro Lab) are numeric counts. TEEs/Cardio is an
// intermittent site with a "cross cover" option: when on, the demand is
// absorbed by the flexible pool (floats, idle Endo MD, OB MD) before any
// dedicated CRNA is added; when off, a dedicated TEE CRNA runs under the Endo
// MD. Don't generalize the room/ratio math without verifying against the
// original.

import {
  AvailableStaff,
  CalculatorConfig,
  CalculatorOutput,
  ConfigField,
  Contingency,
  FacilityCalculator,
  StaffAssignment,
} from './types';
import {
  clampConfig, buildBreakAnalysis, breakCoverageNotes, feasibilityNotes, BREAKS_PER_FLOAT,
  resolveCrossCover, crossCoverNotes, CrossCoverFlexSource, CrossCoverResolution,
  staffingWeightField, readStaffingWeight,
} from './shared';

const FR_MAX = 3; // Floor Runner hard cap on supervised CRNAs

const SCHEMA: ConfigField[] = [
  // STAFFING STRATEGY — "More Solo MD" subsumes the old MD-Solo-Priority toggle.
  staffingWeightField(),
  // MAIN OR
  { key: 'mainORCount', label: 'Main ORs',          section: 'Main OR (4th Floor)', kind: 'number', defaultValue: 7, min: 0, max: 11, accentColor: '#4A90D9' },
  { key: 'addOnRooms',  label: 'Add-on rooms',      section: 'Main OR (4th Floor)', kind: 'number', defaultValue: 0, min: 0, max: 3,  accentColor: '#E8C854' },
  // OFF-SITES
  { key: 'epLab',     label: 'EP Lab rooms',    section: 'Off-sites', kind: 'number', defaultValue: 0, min: 0, max: 2, accentColor: '#29B6F6' },
  { key: 'neuroLab',  label: 'Neuro Lab rooms', section: 'Off-sites', kind: 'number', defaultValue: 0, min: 0, max: 2, helpText: 'Neurointerventional', accentColor: '#FFD93D' },
  { key: 'tees',      label: 'TEEs / Cardio',   section: 'Off-sites', kind: 'number', defaultValue: 0, min: 0, max: 3, helpText: 'Intermittent TEE / cardioversion rooms', accentColor: '#CE93D8' },
  { key: 'teesCross', label: 'Cross cover',     section: 'Off-sites', kind: 'toggle', defaultValue: false, helpText: 'Absorb TEEs with floats / Endo MD / OB before adding a dedicated CRNA', attachTo: 'tees', accentColor: '#F97316' },
];

const DEFAULT_CONFIG: CalculatorConfig = Object.fromEntries(
  SCHEMA.map((f) => [f.key, f.defaultValue]),
);

interface MutableAssignment extends StaffAssignment {
  supervises: string[];
}

function calculatePaoli(cfgIn: CalculatorConfig, avail: AvailableStaff): CalculatorOutput {
  const clamped = clampConfig(SCHEMA, cfgIn);
  const cfg = {
    mainORCount: Number(clamped.mainORCount),
    addOnRooms:  Number(clamped.addOnRooms),
    epLab:       Number(clamped.epLab),
    neuroLab:    Number(clamped.neuroLab),
    tees:        Number(clamped.tees),
    teesCross:   Boolean(clamped.teesCross),
  };
  const weight = readStaffingWeight(clamped);
  // "More Solo MD" reproduces the old MD-Solo-Priority behavior (solo MDs in
  // EP/Neuro instead of supervised CRNAs); balanced/CRNA keep them supervised.
  const soloPri = weight === 'solo';

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
    notes: 'Covers GI solo. Supervises float CRNAs for overflow / TEEs.' });

  const floor = push({ id: `md-${mdt++}`, type: 'MD', role: 'Floor Runner', site: 'Main OR',
    supervises: [], isSolo: false, isFloorRunner: true,
    notes: `Schedule mgmt, intubations, epidurals. Max ${FR_MAX} CRNAs.` });

  // ── Solo-priority off-sites ──
  if (soloPri) {
    for (let i = 0; i < cfg.epLab; i++) {
      push({ id: `md-${mdt++}`, type: 'MD', role: cfg.epLab > 1 ? `EP Lab MD ${i + 1}` : 'EP Lab MD', site: 'EP Lab',
        supervises: [], isSolo: true, notes: 'EP solo (MD Priority).' });
    }
    for (let i = 0; i < cfg.neuroLab; i++) {
      push({ id: `md-${mdt++}`, type: 'MD', role: cfg.neuroLab > 1 ? `Neuro Lab MD ${i + 1}` : 'Neuro Lab MD', site: 'Neuro Lab',
        supervises: [], isSolo: true, notes: 'Neuro solo (MD Priority).' });
    }
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
  // back to a solo MD if no supervisor has room (1:4 for OR MDs, 1:3 for FR).
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

  // ── Off-site CRNA rooms (supervised) — only when not in MD-solo mode ──
  if (!soloPri) {
    for (let i = 0; i < cfg.epLab; i++) {
      tryAssignCRNA(cfg.epLab > 1 ? `EP Lab ${i + 1}` : 'EP Lab', 'EP Lab');
    }
    for (let i = 0; i < cfg.neuroLab; i++) {
      tryAssignCRNA(cfg.neuroLab > 1 ? `Neuro Lab ${i + 1}` : 'Neuro Lab', 'Neuro Lab');
    }
  }

  // ── Float staffing — auto-decide MD float vs CRNA floats ──
  // Estimate: with 2 CRNA floats (normal), would we be short on CRNAs but
  // have spare MDs? If so, drop in an MD float to save a CRNA slot. Floats are
  // general-purpose here; TEE coverage is resolved separately below.
  const mdsSoFar = asgn.filter((a) => a.type === 'MD').length;
  const crnasSoFar = asgn.filter((a) => a.type === 'CRNA').length;

  const crnasWith2Floats = crnasSoFar + 2;
  const mdSurplus = avail.mds - mdsSoFar;
  const crnaDeficit = crnasWith2Floats - avail.crnas;
  // Weight steers the float mix: solo → take an MD float whenever a surplus MD
  // exists; CRNA → never (keep CRNA floats); balanced → the original heuristic.
  const useMDFloat = weight === 'solo' ? mdSurplus >= 1
    : weight === 'crna' ? false
    : mdSurplus >= 1 && crnaDeficit >= 1;

  const floatCRNAs: MutableAssignment[] = [];
  let mdFloat: MutableAssignment | null = null;

  if (useMDFloat) {
    mdFloat = push({ id: `md-${mdt++}`, type: 'MD', role: 'Float MD', site: 'Float',
      supervises: [], isSolo: true, isFloat: true,
      notes: 'MD float — break relief, add-on cases, intermittent coverage. Saves 1 CRNA.' });

    const crnasWith1Float = crnasSoFar + 1;
    const stillShort = crnasWith1Float > avail.crnas;

    if (!stillShort) {
      // 1 CRNA float for Endo coverage / break relief
      const c = push({ id: `crna-${crt++}`, type: 'CRNA', role: 'Float 1', site: 'Float',
        supervisedBy: endoMD.id, supervises: [],
        notes: 'Breaks, GI overflow, add-ons.' });
      endoMD.supervises.push(c.id);
      floatCRNAs.push(c);
    } else {
      mdFloat.notes = 'MD float — Endo backup, break relief, add-ons. No CRNA floats available.';
    }
  } else {
    // Standard: 2 general-purpose CRNA floats under Endo MD
    for (let i = 0; i < 2; i++) {
      const c = push({ id: `crna-${crt++}`, type: 'CRNA', role: `Float ${i + 1}`, site: 'Float',
        supervisedBy: endoMD.id, supervises: [],
        notes: i === 0 ? 'Breaks, add-ons, intermittent coverage.' : 'Breaks, GI overflow, trauma.' });
      endoMD.supervises.push(c.id);
      floatCRNAs.push(c);
    }
  }

  // ── TEEs / Cardio — dedicated CRNA(s) unless cross-covered ──
  // Cross cover absorbs the intermittent demand with floats / an idle Endo MD /
  // the OB MD before adding any dedicated body. Resolved after floats exist.
  const teeCount = cfg.tees;
  const teeCRNAs: MutableAssignment[] = [];
  let teeResolution: CrossCoverResolution | null = null;
  const addDedicatedTEE = (i: number, note: string) => {
    const c = push({ id: `crna-${crt++}`, type: 'CRNA', role: teeCount > 1 ? `TEE ${i + 1}` : 'TEE Float', site: 'TEEs',
      supervisedBy: endoMD.id, isTEE: true, supervises: [], notes: note });
    endoMD.supervises.push(c.id);
    teeCRNAs.push(c);
  };
  if (teeCount > 0) {
    if (cfg.teesCross) {
      const sources: CrossCoverFlexSource[] = [
        { label: 'Floats', capacity: floatCRNAs.length + (mdFloat ? 1 : 0) },
        { label: 'Endo MD', capacity: endoMD.supervises.length === 0 ? 1 : 0 },
        { label: 'OB MD', capacity: 1 },
      ];
      teeResolution = resolveCrossCover(teeCount, sources);
      // Safety net: Paoli's flexible pool (≥1 float + idle Endo MD + OB MD) almost
      // always covers up to the max TEE count, so shortfall is rarely > 0 — but if
      // flex ever falls short, add a dedicated TEE CRNA under the Endo MD.
      for (let i = 0; i < teeResolution.shortfall; i++) {
        addDedicatedTEE(i, 'Dedicated TEE/cardioversion CRNA (flexible coverage insufficient).');
      }
    } else {
      for (let i = 0; i < teeCount; i++) {
        addDedicatedTEE(i, 'Dedicated TEE/cardioversion CRNA under Endo MD.');
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

  // Trauma: float CRNA → least-loaded Main OR MD. If MD float is in play with
  // no CRNA floats, it covers directly.
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
  if (cfg.neuroLab === 0) {
    if (useMDFloat && mdFloat) {
      contingencies.push({
        fromId: mdFloat.id, toId: mdFloat.id,
        type: 'neuro', label: 'Neuro add-on — Float MD covers solo',
      });
    } else {
      const neuroFloat = floatCRNAs[0];
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

  // TEE cross-cover backup: when TEEs are absorbed by flex, a float/Floor Runner
  // is the standing backup if that float gets pulled.
  if (teeResolution && teeResolution.absorbed > 0 && floatCRNAs[0]) {
    contingencies.push({
      fromId: floor.id, toId: floatCRNAs[0].id,
      type: 'teeBackup', label: 'TEE cross-cover — float backup',
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

  if (weight !== 'balanced') {
    notes.push(weight === 'solo'
      ? '🔷 Staffing strategy: More Solo MD — favoring solo MDs over supervised CRNAs.'
      : '🔶 Staffing strategy: More CRNA — favoring supervised CRNAs over solo MDs.');
  }
  if (useMDFloat) {
    const saved = floatCRNAs.length === 0 ? '2' : '1';
    notes.push(crnaDeficit >= 1
      ? `🩺 MD Float assigned — ${mdSurplus} surplus MD${mdSurplus > 1 ? 's' : ''}, ${crnaDeficit} CRNA${crnaDeficit > 1 ? 's' : ''} short. MD covers breaks/add-ons solo, saving ${saved} CRNA float${saved === '2' ? 's' : ''}.`
      : `🩺 MD Float assigned (solo-weighted) — surplus MD covers breaks/add-ons solo, saving ${saved} CRNA float${saved === '2' ? 's' : ''}.`);
  }
  if (soloPri) notes.push('🔷 MD Solo Priority — MDs solo in EP/Neuro instead of CRNAs.');
  if (totalORs >= 10) notes.push('⚠️ High OR volume — 4 MDs on Main OR supervision.');
  if (cfg.epLab > 0) notes.push(`⚡ EP Lab: ${cfg.epLab} room${cfg.epLab > 1 ? 's' : ''}${soloPri ? ' (solo MD)' : ' under Main OR MDs'}.`);
  if (cfg.neuroLab > 0) notes.push(`🧠 Neuro Lab: ${cfg.neuroLab} room${cfg.neuroLab > 1 ? 's' : ''}${soloPri ? ' (solo MD)' : ' under Main OR MDs'}.`);
  if (cfg.addOnRooms > 0) {
    notes.push(`📌 ${cfg.addOnRooms} add-on room${cfg.addOnRooms > 1 ? 's' : ''} factored into staffing (${cfg.mainORCount} scheduled + ${cfg.addOnRooms} add-on = ${totalORs} total).`);
    notes.push('♻️ If add-on rooms don\'t run, those CRNAs can cover TEEs or breaks.');
  }
  if (teeCount > 0 && !cfg.teesCross) {
    notes.push(`💜 TEEs/Cardio — ${teeCRNAs.length} dedicated CRNA${teeCRNAs.length !== 1 ? 's' : ''} under Endo MD.`);
  }
  if (teeResolution) notes.push(...crossCoverNotes('TEEs', teeResolution));
  notes.push(`Floor Runner hard-capped at ${FR_MAX} CRNAs.`);
  notes.push('OB MD floats for breaks / intermittent coverage when available.');
  notes.push('🔴 Trauma (20%): ' + (useMDFloat && floatCRNAs.length === 0 ? 'Float MD covers directly.' : 'Float CRNA supervised by Main OR MD.'));
  if (cfg.neuroLab === 0) notes.push('🟡 Neuro add-on (35-50%): ' + (useMDFloat ? 'Float MD covers solo.' : 'Float CRNA covers under Main OR MD.'));

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
  const dedicatedTEEs = teeCRNAs.length;
  const bkFloats = totalFloats * BREAKS_PER_FLOAT;
  const bkTEE = dedicatedTEEs * 2;
  const bkOB = 1;
  const bkEndoMD = endoMD.supervises.length === 0 ? 1 : 0;
  const bkFloorRunner = floor.supervises.length < FR_MAX ? 1 : 0;
  // Supervising OR MDs at ≥1:3 can give one of their CRNAs a break by floating in.
  const supMDsWith3 = orMDs.filter((m) => !m.isSolo && m.supervises.length >= 3).length;

  const breakSources = [
    { label: 'Floats',         count: totalFloats,    breaks: bkFloats,       detail: `${totalFloats} × 5` },
    ...(bkTEE > 0 ? [{ label: 'TEE CRNA', count: dedicatedTEEs, breaks: bkTEE, detail: 'between cases' }] : []),
    { label: 'OB MD',          count: 1,              breaks: bkOB,           detail: 'between cases' },
    ...(bkEndoMD > 0 ? [{ label: 'Endo MD', count: 1, breaks: bkEndoMD, detail: 'when GI quiet' }] : []),
    ...(bkFloorRunner > 0 ? [{ label: 'Floor Runner', count: 1, breaks: bkFloorRunner, detail: 'spare capacity' }] : []),
    ...(supMDsWith3 > 0 ? [{ label: 'Supv MDs (≥1:3)', count: supMDsWith3, breaks: supMDsWith3, detail: `${supMDsWith3} × 1` }] : []),
  ];

  const breakAnalysis = buildBreakAnalysis(breakDemand, breakSources);

  notes.push(...breakCoverageNotes(breakAnalysis));

  notes.push(...feasibilityNotes(mds.length, crnas.length, avail));

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
