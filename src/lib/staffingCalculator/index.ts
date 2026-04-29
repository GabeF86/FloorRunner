// Registry of per-facility staffing calculators.
// To add a new facility: create a module that exports a `FacilityCalculator`,
// then register it here. The page automatically picks it up.

import { FacilityCalculator } from './types';
import { lankenauCalculator } from './lankenau';
import { paoliCalculator } from './paoli';

export const CALCULATORS: FacilityCalculator[] = [
  lankenauCalculator,
  paoliCalculator,
  // bryn mawr, riddle — future
];

export function getCalculator(facilityId: string): FacilityCalculator | undefined {
  return CALCULATORS.find((c) => c.facilityId === facilityId);
}

export * from './types';
