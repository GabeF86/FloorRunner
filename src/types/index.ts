export type Role = 'physician' | 'fellow' | 'crna' | 'srna' | 'resident' | 'surgeon';

export const ROLE_META: Record<Role, { label: string; color: string; bg: string; border: string }> = {
  physician: { label: 'Physicians', color: '#f59e0b', bg: 'rgba(245,158,11,0.18)', border: 'rgba(245,158,11,0.35)' },
  fellow:    { label: 'Fellows',    color: '#14b8a6', bg: 'rgba(20,184,166,0.18)',  border: 'rgba(20,184,166,0.35)' },
  crna:      { label: 'CRNAs',      color: '#0ea5e9', bg: 'rgba(14,165,233,0.18)',  border: 'rgba(14,165,233,0.35)' },
  srna:      { label: 'SRNAs',      color: '#a78bfa', bg: 'rgba(167,139,250,0.18)', border: 'rgba(167,139,250,0.35)' },
  resident:  { label: 'Residents',  color: '#34d399', bg: 'rgba(52,211,153,0.18)',  border: 'rgba(52,211,153,0.35)' },
  surgeon:   { label: 'Surgeons',   color: '#fb7185', bg: 'rgba(251,113,133,0.18)', border: 'rgba(251,113,133,0.35)' },
};

export const HOUR_OPTIONS = ['8hr', '10hr', '12hr', '24hr'] as const;
export type ShiftHours = typeof HOUR_OPTIONS[number];

export type MDDesignation =
  | 'D1'|'D2'|'D3'|'D4'|'D5'|'D6'|'D7'|'D8'|'D9'
  | 'C1'|'C2'|'C3'
  | '3pm'|'5pm'|'7pm'
  | '8hr'|'10hr';
export const MD_DESIGNATIONS: MDDesignation[] = [
  'D1','D2','D3','D4','D5','D6','D7','D8','D9',
  'C1','C2','C3',
  '3pm','5pm','7pm',
  '8hr','10hr',
];
// Out order: day designations leave in numerical order, followed by early-out times,
// then C2 (last-out call). C1/C3 are overnight call and don't appear in the day out-list.
export const DESIGNATION_OUT_ORDER: MDDesignation[] = [
  'D1','D2','D3','D4','D5','D6','D7','D8','D9',
  '3pm','5pm','7pm',
  'C2',
];

export const SUPERVISION_LIMITS = { crna: 4, resident: 2 };
export const SUPERVISED_ROLES: Role[] = ['crna', 'srna', 'resident'];

export type BreakType = 'morning' | 'lunch' | 'afternoon';
export function getBreaksForShift(hours: ShiftHours): BreakType[] {
  if (hours === '8hr') return ['morning', 'lunch'];
  return ['morning', 'lunch', 'afternoon'];
}

export const SHIFT_START_HOUR = 7;
export const SHIFT_START_MINUTE = 30;

export function getReliefTime(hours: ShiftHours): Date {
  const d = new Date();
  d.setHours(SHIFT_START_HOUR, SHIFT_START_MINUTE, 0, 0);
  d.setTime(d.getTime() + parseInt(hours) * 60 * 60 * 1000);
  return d;
}

export function getMinutesToRelief(hours: ShiftHours): number {
  return Math.round((getReliefTime(hours).getTime() - Date.now()) / 60000);
}

export type AlertLevel = 'none' | 'warning' | 'critical';
export function getAlertLevel(mins: number): AlertLevel {
  if (mins <= 5)  return 'critical';
  if (mins <= 15) return 'warning';
  return 'none';
}

export interface SupervisionLoad {
  crnaCount: number; residentCount: number;
  overCrna: boolean; overResident: boolean;
  atCrna: boolean;   atResident: boolean;
}

export interface StaffMember {
  id: string; name: string; initials: string;
  role: Role; hours: ShiftHours; hospital?: string | null; created_at?: string;
}

export interface Room {
  id: string; site_id: string; name: string;
  position: number; sort_order?: number; created_at?: string;
}

export const HOSPITALS = ['Paoli Hospital', 'Bryn Mawr Hospital', 'Lankenau Hospital', 'Riddle Hospital'] as const;
export type Hospital = typeof HOSPITALS[number];

export interface Site {
  id: string; name: string; color: string; icon: string;
  position: number; sort_order?: number; rooms: Room[];
  is_float?: boolean; hospital?: string | null; created_at?: string;
}

export interface Assignment {
  id: string; room_id: string; staff_id: string;
  board_date: string; staff?: StaffMember; created_at?: string;
}

export interface DailyDesignation {
  id: string; staff_id: string; board_date: string; designation: MDDesignation;
}

export interface DailyShift {
  id: string; staff_id: string; board_date: string; hours: ShiftHours;
}

export interface Break {
  id: string; staff_id: string; board_date: string;
  break_type: BreakType; taken: boolean; taken_at?: string;
}

export interface ReliefEntry {
  id: string; staff_id: string; staff_name: string; staff_role: string;
  staff_initials: string; board_date: string; relieved_at: string;
  designation?: string; shift_hours?: string;
}

export interface DailyActive {
  id: string; staff_id: string; board_date: string;
}

export interface DraggedPerson extends StaffMember { role: Role; }

export function todayString(): string {
  return new Date().toISOString().split('T')[0];
}

export function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

export function formatDateLabel(dateStr: string): string {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}
