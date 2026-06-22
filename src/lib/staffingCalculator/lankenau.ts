// Lankenau Hospital staffing calculator.
// Ported verbatim (TypeScript) from the standalone "Lank Scheduler" prototype
// (~/Desktop/Lank Scheduler/index.html). Algorithm details and ratios are
// Lankenau-specific — 8101 schedule-runner role, OB always staffed, APC
// 1:3-or-1:4 conservation logic, etc. Don't generalize without verifying
// each branch against the original.

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

const SCHEMA: ConfigField[] = [
  // STAFFING STRATEGY
  staffingWeightField(),
  // MAIN OR
  { key: 'mainOR',     label: 'Main ORs',         section: 'Main OR (4th Floor)', kind: 'number', defaultValue: 7, min: 0, max: 9, accentColor: '#4A90D9' },
  { key: 'addOnRooms', label: 'Add-on rooms',     section: 'Main OR (4th Floor)', kind: 'number', defaultValue: 0, min: 0, max: 3, accentColor: '#E8C854' },
  // APC
  { key: 'apc',        label: 'APC rooms',        section: 'APC (1st Floor)',     kind: 'number', defaultValue: 0, min: 0, max: 4, accentColor: '#B06AE8' },
  // CARDIAC
  { key: 'cardiac',    label: 'Cardiac rooms',    section: 'Cardiac / TAVR',       kind: 'number', defaultValue: 0, min: 0, max: 4, accentColor: '#E05599' },
  // ENDO
  { key: 'endo',       label: 'Endo rooms',       section: 'Endo (GI)',            kind: 'number', defaultValue: 0, min: 0, max: 4, accentColor: '#8BC34A' },
  // EP LAB
  { key: 'ep',         label: 'EP rooms',         section: 'EP Lab',               kind: 'number', defaultValue: 0, min: 0, max: 4, accentColor: '#29B6F6' },
  { key: 'epTEE',      label: 'DCCV / TEEs',      section: 'EP Lab',               kind: 'number', defaultValue: 0, min: 0, max: 2, helpText: 'Intermittent DCCV/TEE rooms within EP', visibleWhen: (cfg) => Number(cfg.ep) > 0, accentColor: '#29B6F6' },
  { key: 'epTEECross', label: 'Cross cover',      section: 'EP Lab',               kind: 'toggle', defaultValue: false, helpText: 'Absorb DCCV/TEE with floats/8101/OB before adding a dedicated CRNA', attachTo: 'epTEE', visibleWhen: (cfg) => Number(cfg.ep) > 0, accentColor: '#F97316' },
  // OB
  { key: 'csections',  label: 'C-sections',       section: 'OB',                   kind: 'number', defaultValue: 0, min: 0, max: 8, accentColor: '#E88AD0' },
  // OTHER
  { key: 'ir',         label: 'IR cases',         section: 'Other',                kind: 'number', defaultValue: 0, min: 0, max: 2, accentColor: '#FFAB40' },
  { key: 'irCross',    label: 'Cross cover',      section: 'Other',                kind: 'toggle', defaultValue: false, helpText: 'Absorb IR with spare supervision / floats before adding a dedicated provider', attachTo: 'ir', accentColor: '#F97316' },
];

const DEFAULT_CONFIG: CalculatorConfig = Object.fromEntries(
  SCHEMA.map((f) => [f.key, f.defaultValue]),
);

interface MutableAssignment extends StaffAssignment {
  // Working copy — `supervises` is always present during construction so
  // the algorithm can push to it. Frozen into StaffAssignment shape on return.
  supervises: string[];
}

function calculateLankenau(cfgIn: CalculatorConfig, avail: AvailableStaff): CalculatorOutput {
  // Clamp + coerce to a typed shape so the algorithm is easier to read. The
  // shared clampConfig validates against the schema (NaN/missing → default,
  // numbers clamped to [min,max], toggles coerced to boolean).
  const clamped = clampConfig(SCHEMA, cfgIn);
  const cfg = {
    mainOR:     Number(clamped.mainOR),
    addOnRooms: Number(clamped.addOnRooms),
    apc:        Number(clamped.apc),
    cardiac:    Number(clamped.cardiac),
    endo:       Number(clamped.endo),
    ep:         Number(clamped.ep),
    epTEE:      Number(clamped.epTEE),
    epTEECross: Boolean(clamped.epTEECross),
    csections:  Number(clamped.csections),
    ir:         Number(clamped.ir),
    irCross:    Boolean(clamped.irCross),
  };
  const weight = readStaffingWeight(clamped);

  const asgn: MutableAssignment[] = [];
  let mdt = 0, crt = 0;
  const contingencies: Contingency[] = [];
  const push = (o: MutableAssignment) => { asgn.push(o); return o; };

  // ── MD Budget — estimate total need and decide if we must conserve ──
  const fixedMDs = 1 + 1 + cfg.cardiac; // 8101 + OB + cardiac solos
  const totalORs_est = cfg.mainOR + cfg.addOnRooms;
  const orSupvEst = totalORs_est > 0 ? Math.max(1, Math.ceil((totalORs_est - 2) / 3)) : 0; // 8101 takes 2
  const endoMDEst = cfg.endo > 0 ? 1 : 0;
  const epMDEst = cfg.ep > 0 ? 1 : 0;
  const apcMDEst = cfg.apc >= 2 ? 2 : cfg.apc; // optimal: supv + solo
  const totalMDEst = fixedMDs + endoMDEst + epMDEst + apcMDEst + orSupvEst;
  const mdTight = totalMDEst >= avail.mds; // true = conserve MDs

  // ── 8101 — Schedule Runner ──
  // Lives in the Main OR lane alongside OR Supv MDs — it's a Main-OR-area
  // role, not its own site. The is8101 flag still drives the yellow badge.
  const md8101 = push({ id: `md-${mdt++}`, type: 'MD', role: '8101', site: 'Main OR',
    supervises: [], isSolo: true, is8101: true,
    notes: 'Runs schedule. Available for emergencies, traumas, epidurals. Avoids rooms if possible.' });

  // ── OB — always staffed ──
  const obMD = push({ id: `md-${mdt++}`, type: 'MD', role: 'OB MD', site: 'OB',
    supervises: [], isSolo: true,
    notes: 'Covers L&D, epidurals, C-sections.' });

  // ── Cardiac — solo MDs only ──
  for (let i = 0; i < cfg.cardiac; i++) {
    push({ id: `md-${mdt++}`, type: 'MD', role: `Cardiac ${i + 1}`, site: 'Cardiac',
      supervises: [], isSolo: true, isCardiac: true,
      notes: 'Cardiac anesthesiologist. Solo coverage including TAVR.' });
  }

  // ── Endo — 1 MD supervising CRNAs ──
  let endoMD: MutableAssignment | null = null;
  if (cfg.endo > 0) {
    endoMD = push({ id: `md-${mdt++}`, type: 'MD', role: 'Endo MD', site: 'Endo',
      supervises: [], isSolo: cfg.endo === 0,
      notes: 'Dedicated Endo MD supervising GI CRNAs.' });
    for (let i = 0; i < cfg.endo; i++) {
      const c = push({ id: `crna-${crt++}`, type: 'CRNA', role: `Endo ${i + 1}`, site: 'Endo',
        supervisedBy: endoMD.id, supervises: [] });
      endoMD.supervises.push(c.id);
    }
  }

  // ── EP — MD supervising CRNAs; DCCV/TEE rooms dedicated unless cross-covered ──
  // DCCV/TEE are intermittent. When `epTEECross` is on we don't allocate a
  // dedicated CRNA here — the demand is resolved against flexible coverage
  // after floats exist (see the cross-cover section below).
  let epMD: MutableAssignment | null = null;
  const teeCount = Math.min(cfg.epTEE, cfg.ep);
  if (cfg.ep > 0) {
    const procRooms = cfg.ep - teeCount;
    const dedicatedTEE = teeCount > 0 && !cfg.epTEECross;
    // Only stand up an EP MD if there's a room they'd actually supervise. A
    // single EP room that is a cross-covered DCCV/TEE needs no dedicated EP team.
    if (procRooms > 0 || dedicatedTEE) {
      epMD = push({ id: `md-${mdt++}`, type: 'MD', role: 'EP MD', site: 'EP Lab',
        supervises: [], isSolo: false,
        notes: 'EP Lab MD supervising procedure CRNAs.' + (teeCount > 0 ? ' DCCV/TEE room active.' : '') });
      for (let i = 0; i < procRooms; i++) {
        const c = push({ id: `crna-${crt++}`, type: 'CRNA', role: `EP ${i + 1}`, site: 'EP Lab',
          supervisedBy: epMD.id, supervises: [] });
        epMD.supervises.push(c.id);
      }
      if (dedicatedTEE) {
        for (let i = 0; i < teeCount; i++) {
          const teeC = push({ id: `crna-${crt++}`, type: 'CRNA', role: teeCount > 1 ? `DCCV/TEE ${i + 1}` : 'DCCV/TEE', site: 'EP Lab',
            supervisedBy: epMD.id, isTEE: true, supervises: [],
            notes: 'Dedicated DCCV/TEE CRNA. Available for break relief between cases.' });
          epMD.supervises.push(teeC.id);
        }
      }
      if (epMD.supervises.length === 0) epMD.isSolo = true;
    }
  }

  // ── APC — staffing depends on MD budget + staffing weight ──
  // Optimal (MDs plentiful): 1 supervising MD (1:3) + 1 solo MD = 2 MDs
  // Conservative (MDs tight / CRNA-weighted): 1 MD supervising all CRNAs (1:4) = 1 MD
  // Solo (solo-weighted / CRNA shortage): one solo MD per room — most MD-heavy
  const apcMDs: MutableAssignment[] = [];
  const apcCRNAs: MutableAssignment[] = [];
  if (cfg.apc > 0) {
    const crnasSoFar = asgn.filter(a => a.type === 'CRNA').length;
    const crnaForMainOR = cfg.mainOR + cfg.addOnRooms;
    const crnaForFloats = 3;
    const crnaEstNeeded = crnasSoFar + crnaForMainOR + crnaForFloats;
    const crnaAvailForAPC = Math.max(0, avail.crnas - crnaEstNeeded);
    const noCRNA = crnaAvailForAPC < cfg.apc;

    // Pick the staffing mode. Weight overrides the default heuristic, but a CRNA
    // shortage always forces solo. 'balanced' reproduces the original behavior.
    let mode: 'optimal' | 'conservation' | 'solo';
    if (weight === 'solo' || noCRNA) mode = 'solo';
    else if (weight === 'crna') mode = 'conservation';
    else mode = mdTight ? 'conservation' : 'optimal';

    if (mode === 'optimal') {
      const supMD = push({ id: `md-${mdt++}`, type: 'MD', role: 'APC Supv', site: 'APC',
        supervises: [], isSolo: false, notes: 'APC supervising MD. 1:3 optimal ratio.' });
      apcMDs.push(supMD);
      const soloMD = push({ id: `md-${mdt++}`, type: 'MD', role: 'APC Solo', site: 'APC',
        supervises: [], isSolo: true, notes: 'APC solo MD. Covers 1 room independently.' });
      apcMDs.push(soloMD);
      const crnaCount = Math.min(cfg.apc - 1, 3);
      for (let i = 0; i < crnaCount; i++) {
        const c = push({ id: `crna-${crt++}`, type: 'CRNA', role: `APC ${i + 1}`, site: 'APC',
          supervisedBy: supMD.id, supervises: [] });
        supMD.supervises.push(c.id);
        apcCRNAs.push(c);
      }
    } else if (mode === 'conservation') {
      const supMD = push({ id: `md-${mdt++}`, type: 'MD', role: 'APC Supv', site: 'APC',
        supervises: [], isSolo: false,
        notes: `APC supervising MD. 1:${cfg.apc} ratio (MD conservation mode).` });
      apcMDs.push(supMD);
      for (let i = 0; i < cfg.apc; i++) {
        const c = push({ id: `crna-${crt++}`, type: 'CRNA', role: `APC ${i + 1}`, site: 'APC',
          supervisedBy: supMD.id, supervises: [] });
        supMD.supervises.push(c.id);
        apcCRNAs.push(c);
      }
    } else {
      const note = noCRNA ? 'APC solo MD (CRNAs unavailable).' : 'APC solo MD (solo-weighted).';
      for (let i = 0; i < cfg.apc; i++) {
        apcMDs.push(push({ id: `md-${mdt++}`, type: 'MD', role: `APC MD ${i + 1}`, site: 'APC',
          supervises: [], isSolo: true, notes: note }));
      }
    }
  }

  // ── Main OR — 1:3 optimal, 1:4 max ──
  // Smart 8101 usage: if giving 8101 1-2 rooms reduces the # of dedicated
  // OR supervising MDs needed, do it proactively (frees an MD for other duties).
  const totalORs = cfg.mainOR + cfg.addOnRooms;
  const orMDs: MutableAssignment[] = [];
  const orCRNAs: MutableAssignment[] = [];
  if (totalORs > 0) {
    const supMDsWithout8101 = Math.max(1, Math.ceil(totalORs / 3));

    let rooms8101 = 0;
    const supMDsWith1 = Math.max(1, Math.ceil((totalORs - 1) / 3));
    const supMDsWith2 = Math.max(1, Math.ceil((totalORs - 2) / 3));
    if (totalORs >= 2 && supMDsWith2 < supMDsWithout8101) rooms8101 = 2;
    else if (totalORs >= 1 && supMDsWith1 < supMDsWithout8101) rooms8101 = 1;

    const actualSupMDs = rooms8101 > 0
      ? Math.max(1, Math.ceil((totalORs - rooms8101) / 3))
      : supMDsWithout8101;

    for (let i = 0; i < actualSupMDs; i++) {
      orMDs.push(push({ id: `md-${mdt++}`, type: 'MD', role: `OR Supv ${i + 1}`, site: 'Main OR',
        supervises: [], isSolo: false, notes: 'Main OR supervision. 1:3 target ratio.' }));
    }

    for (let i = 0; i < totalORs; i++) {
      const label = i < cfg.mainOR ? `OR ${i + 1}` : `Add-On ${i - cfg.mainOR + 1}`;
      const c = push({ id: `crna-${crt++}`, type: 'CRNA', role: label, site: 'Main OR',
        supervisedBy: null, isAddOn: i >= cfg.mainOR, supervises: [] });
      orCRNAs.push(c);
    }

    let ci = 0;
    for (let i = 0; i < rooms8101 && ci < orCRNAs.length; i++) {
      orCRNAs[ci].supervisedBy = md8101.id;
      md8101.supervises.push(orCRNAs[ci].id);
      md8101.isSolo = false;
      ci++;
    }
    if (rooms8101 > 0) {
      md8101.notes = `Carrying ${rooms8101} OR room${rooms8101 > 1 ? 's' : ''} to optimize staffing. Still available for emergencies.`;
    }

    let mi = 0;
    while (ci < orCRNAs.length) {
      const md = orMDs[mi % orMDs.length];
      orCRNAs[ci].supervisedBy = md.id;
      md.supervises.push(orCRNAs[ci].id);
      ci++; mi++;
    }
  }

  // ── IR — dedicated providers unless cross-covered ──
  // Cross-covered IR is resolved after floats (see the cross-cover section).
  if (cfg.ir > 0 && !cfg.irCross) {
    for (let i = 0; i < cfg.ir; i++) {
      const allSupMDs: MutableAssignment[] = [...orMDs];
      if (md8101.supervises.length > 0 && md8101.supervises.length < 3) allSupMDs.push(md8101);
      const avMD = allSupMDs.find(m => m.supervises.length < 4);
      if (avMD) {
        const c = push({ id: `crna-${crt++}`, type: 'CRNA', role: cfg.ir > 1 ? `IR CRNA ${i + 1}` : 'IR CRNA', site: 'IR',
          supervisedBy: avMD.id, supervises: [] });
        avMD.supervises.push(c.id);
      } else {
        push({ id: `md-${mdt++}`, type: 'MD', role: cfg.ir > 1 ? `IR MD ${i + 1}` : 'IR MD', site: 'IR',
          supervises: [], isSolo: true, notes: 'IR solo — no OR MD capacity.' });
      }
    }
  }

  // ── Floats — minimum 3, fill with what's available ──
  const mdsSoFar = asgn.filter(a => a.type === 'MD').length;
  const crnasSoFar = asgn.filter(a => a.type === 'CRNA').length;
  const crnaRemaining = Math.max(0, avail.crnas - crnasSoFar);
  let mdRemaining = Math.max(0, avail.mds - mdsSoFar);

  const floats: MutableAssignment[] = [];
  const minFloats = 3;

  let crnaFloats = Math.min(crnaRemaining, minFloats);
  let mdFloats = 0;
  if (crnaFloats < minFloats && mdRemaining > 0) {
    mdFloats = Math.min(mdRemaining, minFloats - crnaFloats);
    mdRemaining -= mdFloats;
  }
  const extraCRNAFloats = crnaRemaining - crnaFloats;
  if (extraCRNAFloats > 0) crnaFloats += extraCRNAFloats;
  if (mdRemaining > 0) { mdFloats += mdRemaining; mdRemaining = 0; }

  for (let i = 0; i < crnaFloats; i++) {
    floats.push(push({ id: `crna-${crt++}`, type: 'CRNA', role: `Float ${i + 1}`, site: 'Float',
      supervisedBy: null, isFloat: true, supervises: [],
      notes: 'Break relief, lunch coverage, contingency response. 8101 assigns.' }));
  }
  for (let i = 0; i < mdFloats; i++) {
    floats.push(push({ id: `md-${mdt++}`, type: 'MD', role: `Float MD ${i + 1}`, site: 'Float',
      supervises: [], isSolo: true, isFloat: true,
      notes: 'MD float — breaks, add-ons, emergencies. Covers solo.' }));
  }

  // ── FINAL DEFICIT REPAIR ──
  // If after everything, total CRNAs > available, try to convert CRNA floats → MD floats.
  let totalCRNAsNow = asgn.filter(a => a.type === 'CRNA').length;
  let crnaOver = totalCRNAsNow - avail.crnas;
  let mdAvailStill = avail.mds - asgn.filter(a => a.type === 'MD').length;

  while (crnaOver > 0 && mdAvailStill > 0) {
    const crnaFloat = floats.find(f => f.type === 'CRNA');
    if (!crnaFloat) break;
    const idx = asgn.indexOf(crnaFloat);
    if (idx >= 0) asgn.splice(idx, 1);
    const fi = floats.indexOf(crnaFloat);
    if (fi >= 0) floats.splice(fi, 1);
    const newMDFloat = push({ id: `md-${mdt++}`, type: 'MD', role: 'Float MD', site: 'Float',
      supervises: [], isSolo: true, isFloat: true,
      notes: 'MD float (converted from CRNA float to resolve deficit).' });
    floats.push(newMDFloat);
    totalCRNAsNow--;
    crnaOver--;
    mdAvailStill--;
  }

  // ── Cross-cover resolution ──
  // Intermittent DCCV/TEE and IR demand flagged "cross cover" is absorbed by the
  // flexible pool (floats, schedule runner's spare capacity, OB MD, spare OR
  // supervision) before any dedicated provider is added. Runs after floats exist
  // so the tally reflects the real board. Only the unabsorbed remainder becomes
  // new headcount — which feasibilityNotes then flags if it overruns availability.
  //
  // The float pool and schedule-runner spare are a SINGLE shared budget drawn
  // down as each site absorbs, so the same float/8101 is never credited to two
  // intermittent sites at once. OB MD (TEE) and spare OR supervision (IR) are
  // site-specific resources that don't overlap, so they aren't shared.
  let floatBudget = floats.length; // CRNA + MD floats
  let runnerBudget = md8101.supervises.length < 2 ? 1 : 0;

  let teeResolution: CrossCoverResolution | null = null;
  if (teeCount > 0 && cfg.epTEECross) {
    const sources: CrossCoverFlexSource[] = [
      { label: 'Floats', capacity: floatBudget },
      { label: 'Schedule runner (8101)', capacity: runnerBudget },
      { label: 'OB MD', capacity: 1 },
    ];
    teeResolution = resolveCrossCover(teeCount, sources);
    // Draw down the budgets, consuming TEE's EXCLUSIVE resource (OB MD) before the
    // SHARED float/runner pool, so floats stay available for IR where possible.
    let drawn = teeResolution.absorbed;
    drawn -= Math.min(drawn, 1); // OB MD (exclusive to TEE)
    const f = Math.min(drawn, floatBudget); floatBudget -= f; drawn -= f;
    const r = Math.min(drawn, runnerBudget); runnerBudget -= r; drawn -= r;
    for (let i = 0; i < teeResolution.shortfall; i++) {
      // Never leave a TEE CRNA unsupervised: prefer the EP MD, else an OR Supv MD
      // below 1:4, else the schedule runner (8101 carries ≤2 rooms, so has room).
      const host = epMD || orMDs.find(m => m.supervises.length < 4) || (md8101.supervises.length < 4 ? md8101 : null);
      const teeC = push({ id: `crna-${crt++}`, type: 'CRNA', role: teeCount > 1 ? `DCCV/TEE ${i + 1}` : 'DCCV/TEE', site: 'EP Lab',
        supervisedBy: host ? host.id : null, isTEE: true, supervises: [],
        notes: 'Dedicated DCCV/TEE CRNA (flexible coverage insufficient).' });
      if (host) { host.supervises.push(teeC.id); host.isSolo = false; }
    }
  }

  let irResolution: CrossCoverResolution | null = null;
  if (cfg.ir > 0 && cfg.irCross) {
    // Spare OR supervision (an OR Supv MD below 1:4) can pick up an intermittent
    // IR case without a new body, alongside the SHARED float / runner budget.
    const supSpare = orMDs.reduce((sum, m) => sum + Math.max(0, 4 - m.supervises.length), 0);
    const sources: CrossCoverFlexSource[] = [
      { label: 'Floats', capacity: floatBudget },
      { label: 'Spare OR supervision', capacity: supSpare },
      { label: 'Schedule runner (8101)', capacity: runnerBudget },
    ];
    irResolution = resolveCrossCover(cfg.ir, sources);
    // Consume IR's EXCLUSIVE resource (spare OR supervision) before the SHARED
    // float/runner pool, mirroring the TEE drawdown above.
    let drawn = irResolution.absorbed;
    drawn -= Math.min(drawn, supSpare); // spare OR supervision (exclusive to IR)
    const f = Math.min(drawn, floatBudget); floatBudget -= f; drawn -= f;
    const r = Math.min(drawn, runnerBudget); runnerBudget -= r; drawn -= r;
    for (let i = 0; i < irResolution.shortfall; i++) {
      const avMD = orMDs.find(m => m.supervises.length < 4) || (md8101.supervises.length < 4 ? md8101 : undefined);
      if (avMD) {
        const c = push({ id: `crna-${crt++}`, type: 'CRNA', role: cfg.ir > 1 ? `IR CRNA ${i + 1}` : 'IR CRNA', site: 'IR',
          supervisedBy: avMD.id, supervises: [] });
        avMD.supervises.push(c.id);
        avMD.isSolo = false;
      } else {
        push({ id: `md-${mdt++}`, type: 'MD', role: cfg.ir > 1 ? `IR MD ${i + 1}` : 'IR MD', site: 'IR',
          supervises: [], isSolo: true, notes: 'IR solo — flexible coverage insufficient.' });
      }
    }
  }

  // ── Contingencies ──
  if (floats.length > 0) {
    const traumaFloat = floats.find(f => f.type === 'CRNA') || floats[0];
    const traumaSup = traumaFloat.type === 'CRNA'
      ? (orMDs.length > 0 ? [...orMDs].sort((a, b) => a.supervises.length - b.supervises.length)[0] : md8101)
      : traumaFloat;
    contingencies.push({
      fromId: traumaSup.id, toId: traumaFloat.id,
      type: 'trauma', label: 'Trauma OR (30-40%)',
    });
  }
  {
    const emergFloat = floats.find(f => f.type === 'CRNA') || floats.find(f => f.type === 'MD') || md8101;
    contingencies.push({
      fromId: obMD.id, toId: emergFloat.id,
      type: 'emergCS', label: 'Emergency C-section (30%)',
    });
  }
  if (teeCount > 0 && floats.length > 0) {
    const teeFloat = floats.find(f => f.type === 'CRNA') || floats[0];
    contingencies.push({
      fromId: epMD ? epMD.id : md8101.id, toId: teeFloat.id,
      type: 'epTEE', label: teeResolution ? 'DCCV/TEE cross-cover (float)' : 'DCCV/TEE float backup',
    });
  }
  if (teeCount > 0) {
    const teeCRNA = asgn.find(a => a.isTEE);
    if (teeCRNA) {
      contingencies.push({
        fromId: teeCRNA.id, toId: teeCRNA.id,
        type: 'teeBreaks', label: 'DCCV/TEE → break relief between cases',
      });
    }
  }
  if (irResolution && irResolution.absorbed > 0 && floats.length > 0) {
    const irFloat = floats.find(f => f.type === 'CRNA') || floats[0];
    const irSup = orMDs[0] || md8101;
    contingencies.push({
      fromId: irSup.id, toId: irFloat.id,
      type: 'irFlex', label: 'IR case → float coverage',
    });
  }
  if (cfg.addOnRooms > 0) {
    const addOnCRNA = asgn.find(a => a.isAddOn);
    if (addOnCRNA) {
      contingencies.push({
        fromId: md8101.id, toId: addOnCRNA.id,
        type: 'addOnFlex', label: 'Add-on → breaks if unused',
      });
    }
  }

  // ── Notes ──
  const mds = asgn.filter(a => a.type === 'MD');
  const crnas = asgn.filter(a => a.type === 'CRNA');
  const mdFloatCount = floats.filter(f => f.type === 'MD').length;
  const crnaFloatCount = floats.filter(f => f.type === 'CRNA').length;
  const totalFloats = floats.length;
  const notes: string[] = [];

  if (weight !== 'balanced') {
    notes.push(weight === 'solo'
      ? '🔷 Staffing strategy: More Solo MD — favoring solo MDs over supervised CRNAs.'
      : '🔶 Staffing strategy: More CRNA — favoring supervised CRNAs over solo MDs.');
  }

  if (md8101.supervises.length > 0) {
    notes.push(`📋 8101 supervising ${md8101.supervises.length} OR room${md8101.supervises.length > 1 ? 's' : ''} to optimize staffing. Still available for emergencies.`);
  } else {
    notes.push('✅ 8101 free — available for emergencies, traumas, epidurals.');
  }
  if (cfg.cardiac > 0) notes.push(`❤️ ${cfg.cardiac} cardiac room${cfg.cardiac > 1 ? 's' : ''} — solo cardiac anesthesiologists.`);
  if (cfg.apc > 0 && apcCRNAs.length === 0) notes.push(weight === 'solo'
    ? `🔷 APC: ${apcMDs.length} solo MD${apcMDs.length > 1 ? 's' : ''} (solo-weighted).`
    : '⚠️ APC staffed with solo MDs — no CRNAs available.');
  if (cfg.apc > 0 && apcCRNAs.length > 0 && apcMDs.length === 2) notes.push(`🏥 APC: 1 supervising MD (1:${apcCRNAs.length}) + 1 solo MD.`);
  if (cfg.apc > 0 && apcCRNAs.length > 0 && apcMDs.length === 1) notes.push(`🏥 APC: 1 MD supervising ${apcCRNAs.length} CRNAs (1:${apcCRNAs.length}) — MD conservation mode.`);
  if (totalORs >= 7) notes.push(`⚠️ High Main OR volume — ${totalORs} rooms.`);
  if (cfg.addOnRooms > 0) notes.push(`📌 ${cfg.addOnRooms} add-on room${cfg.addOnRooms > 1 ? 's' : ''} (${cfg.mainOR} scheduled + ${cfg.addOnRooms} add-on = ${totalORs} total).`);
  if (cfg.ep > 0) notes.push(`⚡ EP Lab: ${cfg.ep} room${cfg.ep > 1 ? 's' : ''}${teeCount > 0 ? ` (incl. ${teeCount} DCCV/TEE)` : ''}.`);
  if (asgn.some(a => a.isTEE)) notes.push('☕ DCCV/TEE CRNA available for break relief between cases.');
  if (teeResolution) notes.push(...crossCoverNotes('DCCV/TEE', teeResolution));
  if (cfg.endo > 0) notes.push(`🔬 Endo: ${cfg.endo} room${cfg.endo > 1 ? 's' : ''} under dedicated Endo MD.`);
  if (cfg.ir > 0) notes.push(`📋 ${cfg.ir} IR case${cfg.ir > 1 ? 's' : ''} booked today.`);
  if (irResolution) notes.push(...crossCoverNotes('IR', irResolution));
  if (cfg.csections >= 1) notes.push(`👶 ${cfg.csections} C-section${cfg.csections > 1 ? 's' : ''} scheduled.`);
  if (cfg.csections >= 4) notes.push('🔴 High OB volume — strongly consider dedicated second OB provider.');
  notes.push('🔴 Trauma OR (30-40%): float provider responds.');
  if (totalFloats < 3) notes.push(`🔴 Only ${totalFloats} float${totalFloats !== 1 ? 's' : ''} — below minimum of 3. Contingency coverage compromised.`);
  if (totalFloats >= 3) notes.push(`✅ ${totalFloats} float${totalFloats !== 1 ? 's' : ''} available — ${crnaFloatCount} CRNA${crnaFloatCount !== 1 ? 's' : ''} + ${mdFloatCount} MD${mdFloatCount !== 1 ? 's' : ''} (minimum 3 met).`);
  if (mdFloatCount > 0) notes.push(`🩺 ${mdFloatCount} MD float${mdFloatCount > 1 ? 's' : ''} — surplus MDs covering break/contingency roles.`);

  // ── Break Coverage Analysis ──
  // Every provider in a room needs a lunch break (~30 min). Cardiac MDs and
  // supervising MDs handle their own coverage between cases.
  const provNeedingBreaks = asgn.filter(a =>
    !a.isFloat && a.site !== 'Float' && !a.is8101 &&
    (a.type === 'CRNA' || (a.type === 'MD' && a.isSolo && !a.isCardiac))
  );
  const breakDemand = provNeedingBreaks.length;

  const dedicatedTEEs = asgn.filter(a => a.isTEE).length;
  const bkFloats = floats.length * BREAKS_PER_FLOAT;
  const bkTEE = dedicatedTEEs * 2;
  const bk8101 = 1;
  const bkOB = 1;
  const bkEP = epMD ? 1 : 0;
  const supMDsWith3 = mds.filter(m =>
    !m.is8101 && !m.isSolo && !m.isCardiac && m.supervises && m.supervises.length >= 3
  ).length;
  const bkSupMDs = supMDsWith3;

  const breakSources = [
    { label: 'Floats', count: floats.length, breaks: bkFloats, detail: `${floats.length} × 5` },
    ...(bkTEE > 0 ? [{ label: 'DCCV/TEE CRNA', count: dedicatedTEEs, breaks: bkTEE, detail: 'between cases' }] : []),
    { label: '8101', count: 1, breaks: bk8101, detail: 'schedule runner' },
    { label: 'OB MD', count: 1, breaks: bkOB, detail: 'between cases' },
    ...(bkEP > 0 ? [{ label: 'EP MD', count: 1, breaks: bkEP, detail: 'between cases' }] : []),
    ...(bkSupMDs > 0 ? [{ label: 'Supv MDs (≥1:3)', count: supMDsWith3, breaks: bkSupMDs, detail: `${supMDsWith3} × 1` }] : []),
  ];

  const breakAnalysis = buildBreakAnalysis(breakDemand, breakSources);

  notes.push(...breakCoverageNotes(breakAnalysis));

  notes.push(...feasibilityNotes(mds.length, crnas.length, avail));

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

export const lankenauCalculator: FacilityCalculator = {
  facilityId: 'Lankenau Hospital',
  facilityName: 'Lankenau Hospital',
  abbreviation: 'Lank',
  schema: SCHEMA,
  defaultConfig: DEFAULT_CONFIG,
  calculate: calculateLankenau,
  status: 'ready',
  siteCatalog: [
    { key: 'Main OR', label: 'Main OR (4th Floor)',     color: '#4A90D9', icon: '🏥' },
    { key: 'Cardiac', label: 'Cardiac / TAVR',          color: '#E05599', icon: '❤️' },
    { key: 'APC',     label: 'APC (Surgery Center)',    color: '#B06AE8', icon: '🔧' },
    { key: 'Endo',    label: 'Endoscopy (GI)',          color: '#8BC34A', icon: '🔬' },
    { key: 'EP Lab',  label: 'EP Lab',                  color: '#29B6F6', icon: '⚡' },
    { key: 'OB',      label: 'OB / L&D',                color: '#E88AD0', icon: '👶' },
    { key: 'IR',      label: 'IR',                      color: '#FFAB40', icon: '📡' },
    { key: 'Float',   label: 'Float Pool',              color: '#80CBC4', icon: '🔄' },
  ],
};
