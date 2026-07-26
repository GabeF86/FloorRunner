// Scenario fixture builders (Paoli phase 2 tests): a bare ScenarioProvider
// and a ScenarioDoc literal, mirroring buildContext.ts's prov/buildCtx style.
import { DEFAULT_SCENARIO_CODE_MAP } from '../scenario';
import type { ScenarioDoc, ScenarioProvider } from '../scenario';

export function sp(id: string, over: Partial<ScenarioProvider> = {}): ScenarioProvider {
  return {
    provider_id: id, sourceName: id, scenarioFte: 1,
    targets: new Map(), neuroTarget: null,
    prohibitedAllDates: new Set(), prohibitedDatesByCode: new Map(),
    prohibitedAllDows: new Set(), prohibitedDowsByCode: new Map(),
    linkages: [], preferences: [], mandatoryRetained: [], fixedAssignments: [],
    ...over,
  };
}

export function scen(providers: ScenarioProvider[]): ScenarioDoc {
  return {
    neuroCode: 'C3', codeMap: DEFAULT_SCENARIO_CODE_MAP,
    providers: new Map(providers.map(p => [p.provider_id, p])),
  };
}
