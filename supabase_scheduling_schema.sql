-- ============================================================================
-- Anesthesia Scheduling Platform — Core Schema Migration
-- Run this in the Supabase SQL Editor
-- ============================================================================

-- ── SECTION 1: Schema ───────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS scheduling;

-- ── SECTION 2: Enum Types ───────────────────────────────────────────────────
CREATE TYPE scheduling.org_status AS ENUM ('active', 'inactive');
CREATE TYPE scheduling.site_type AS ENUM ('hospital', 'asc', 'office');
CREATE TYPE scheduling.provider_type AS ENUM ('physician', 'crna', 'aa', 'resident', 'fellow', 'locums', 'other');
CREATE TYPE scheduling.provider_status AS ENUM ('active', 'inactive', 'on_leave');
CREATE TYPE scheduling.employment_status AS ENUM ('full_time', 'part_time', 'per_diem', 'locums', 'contract', 'retired', 'terminated');
CREATE TYPE scheduling.custom_field_type AS ENUM ('text', 'number', 'boolean', 'select', 'multiselect', 'date');
CREATE TYPE scheduling.shift_category AS ENUM ('call', 'regular', 'float', 'admin', 'unavailable', 'leave');
CREATE TYPE scheduling.provider_group AS ENUM ('physician', 'crna', 'both');
CREATE TYPE scheduling.schedule_layer AS ENUM ('call', 'shifts', 'assignments');
CREATE TYPE scheduling.day_type AS ENUM ('weekday', 'friday', 'saturday', 'sunday', 'federal_holiday', 'major_holiday');
CREATE TYPE scheduling.schedule_type AS ENUM ('call', 'shifts', 'assignments', 'master');
CREATE TYPE scheduling.schedule_status AS ENUM ('draft', 'review', 'published', 'revised', 'archived');
CREATE TYPE scheduling.version_status AS ENUM ('draft', 'review', 'published', 'archived');
CREATE TYPE scheduling.assignment_status AS ENUM ('assigned', 'open', 'pending', 'declined', 'external_fill', 'canceled');
CREATE TYPE scheduling.source_type AS ENUM ('auto_generated', 'manual', 'swap', 'open_call_pickup', 'imported');
CREATE TYPE scheduling.availability_type AS ENUM ('available', 'unavailable', 'pto', 'sick', 'fmla', 'conference', 'admin', 'cme', 'jury_duty', 'no_call_request', 'call_request', 'blocked', 'parental_leave', 'military_leave');
CREATE TYPE scheduling.request_type AS ENUM ('pto', 'no_call', 'extra_call', 'preferred_weekend', 'swap_request', 'availability_change');
CREATE TYPE scheduling.approval_status AS ENUM ('pending', 'approved', 'denied', 'waitlisted', 'canceled');
CREATE TYPE scheduling.rule_category AS ENUM ('coverage', 'sequence', 'eligibility', 'frequency', 'rest', 'pairing', 'fairness', 'open_slot', 'time_off', 'cross_site');
CREATE TYPE scheduling.rule_set_status AS ENUM ('draft', 'active', 'archived');
CREATE TYPE scheduling.holiday_type AS ENUM ('federal', 'religious', 'organizational', 'custom');

-- ── SECTION 3: Foundation Tables ─────────────────────────────────────────────

-- Organizations
CREATE TABLE scheduling.organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  legal_name    text,
  status        scheduling.org_status NOT NULL DEFAULT 'active',
  default_timezone text NOT NULL DEFAULT 'America/New_York',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Users (linked to Supabase auth.users)
CREATE TABLE scheduling.users (
  id              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES scheduling.organizations(id) ON DELETE CASCADE,
  email           text NOT NULL,
  first_name      text,
  last_name       text,
  is_active       boolean NOT NULL DEFAULT true,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Helper function (must come after users table)
CREATE OR REPLACE FUNCTION scheduling.current_user_org_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT organization_id FROM scheduling.users WHERE id = auth.uid()
$$;

-- Roles
CREATE TABLE scheduling.roles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES scheduling.organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text,
  permissions     jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- User-Role junction
CREATE TABLE scheduling.user_roles (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES scheduling.users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES scheduling.roles(id) ON DELETE CASCADE,
  UNIQUE (user_id, role_id)
);

-- ── SECTION 5: Sites ────────────────────────────────────────────────────────

CREATE TABLE scheduling.sites (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES scheduling.organizations(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  short_name            text,
  site_type             scheduling.site_type NOT NULL DEFAULT 'hospital',
  address               text,
  timezone              text NOT NULL DEFAULT 'America/New_York',
  is_active             boolean NOT NULL DEFAULT true,
  display_order         integer NOT NULL DEFAULT 0,
  operational_days      jsonb NOT NULL DEFAULT '["Mon","Tue","Wed","Thu","Fri"]',
  weekday_staffing      jsonb,
  weekend_staffing      jsonb,
  holiday_staffing      jsonb,
  default_schedule_view text DEFAULT 'call',
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ── SECTION 6: Provider Tables ──────────────────────────────────────────────

CREATE TABLE scheduling.providers (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL REFERENCES scheduling.organizations(id) ON DELETE CASCADE,
  linked_user_id         uuid REFERENCES scheduling.users(id) ON DELETE SET NULL,
  provider_type          scheduling.provider_type NOT NULL,
  first_name             text NOT NULL,
  last_name              text NOT NULL,
  preferred_display_name text,
  short_display_name     text, -- e.g. "J.Smith"
  initials               text,
  status                 scheduling.provider_status NOT NULL DEFAULT 'active',
  photo_url              text,
  email                  text,
  phone                  text,
  home_address           text,
  npi                    text,
  employee_id            text,
  payroll_id             text,
  start_date             date,
  years_with_group       integer,
  notes_admin_only       text,
  color_tag              text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scheduling.provider_employment_profiles (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id             uuid NOT NULL UNIQUE REFERENCES scheduling.providers(id) ON DELETE CASCADE,
  employment_status       scheduling.employment_status NOT NULL DEFAULT 'full_time',
  fte_value               numeric(3,2) DEFAULT 1.00,
  is_shareholder          boolean NOT NULL DEFAULT false,
  pto_weeks               integer DEFAULT 0,
  max_weekly_hours        integer,
  max_monthly_calls       integer,
  -- Call eligibility
  call_taker              boolean NOT NULL DEFAULT false,
  partial_call_taker      boolean NOT NULL DEFAULT false,
  holiday_call_eligible   boolean NOT NULL DEFAULT true,
  weekend_call_eligible   boolean NOT NULL DEFAULT true,
  night_call_eligible     boolean NOT NULL DEFAULT true,
  backup_call_eligible    boolean NOT NULL DEFAULT true,
  late_shift_eligible     boolean NOT NULL DEFAULT true,
  -- Capabilities
  can_supervise_crnas     boolean NOT NULL DEFAULT false,
  can_work_solo           boolean NOT NULL DEFAULT false,
  can_cover_offsite       boolean NOT NULL DEFAULT false,
  -- Site
  home_site_id            uuid REFERENCES scheduling.sites(id) ON DELETE SET NULL,
  -- Specialties & skills
  fellowship_primary      text,
  fellowships             jsonb DEFAULT '[]',
  skills                  jsonb DEFAULT '[]',
  -- Preferences
  preferred_assignments   jsonb DEFAULT '[]',
  undesired_assignments   jsonb DEFAULT '[]',
  preferred_sites         jsonb DEFAULT '[]',
  undesired_sites         jsonb DEFAULT '[]',
  -- Specialty eligibility
  float_eligible          boolean NOT NULL DEFAULT true,
  trauma_eligible         boolean NOT NULL DEFAULT false,
  ob_eligible             boolean NOT NULL DEFAULT false,
  cardiac_eligible        boolean NOT NULL DEFAULT false,
  neuro_eligible          boolean NOT NULL DEFAULT false,
  endo_eligible           boolean NOT NULL DEFAULT false,
  ep_eligible             boolean NOT NULL DEFAULT false,
  -- Scheduling constraints
  max_consecutive_calls   integer,
  post_call_relief_rules  jsonb,
  weekend_frequency_target numeric(4,2),
  holiday_frequency_target numeric(4,2),
  friday_frequency_target  numeric(4,2),
  blocked_dates           jsonb DEFAULT '[]',
  scheduling_notes        text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scheduling.provider_site_credentials (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id           uuid NOT NULL REFERENCES scheduling.providers(id) ON DELETE CASCADE,
  site_id               uuid NOT NULL REFERENCES scheduling.sites(id) ON DELETE CASCADE,
  is_active             boolean NOT NULL DEFAULT true,
  credentialed          boolean NOT NULL DEFAULT true,
  effective_start_date  date,
  effective_end_date    date,
  can_take_call         boolean NOT NULL DEFAULT true,
  can_take_weekend_call boolean NOT NULL DEFAULT true,
  can_take_holiday_call boolean NOT NULL DEFAULT true,
  can_take_backup_call  boolean NOT NULL DEFAULT true,
  allowed_shift_types   jsonb DEFAULT '[]',
  excluded_shift_types  jsonb DEFAULT '[]',
  skill_tags            jsonb DEFAULT '[]',
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, site_id)
);

CREATE TABLE scheduling.provider_custom_field_definitions (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id            uuid NOT NULL REFERENCES scheduling.organizations(id) ON DELETE CASCADE,
  field_name                 text NOT NULL,
  display_label              text NOT NULL,
  field_type                 scheduling.custom_field_type NOT NULL DEFAULT 'text',
  options                    jsonb DEFAULT '[]',
  required                   boolean NOT NULL DEFAULT false,
  applies_to_provider_types  jsonb DEFAULT '[]',
  applies_to_sites           jsonb DEFAULT '[]',
  is_active                  boolean NOT NULL DEFAULT true,
  display_order              integer NOT NULL DEFAULT 0,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scheduling.provider_custom_field_values (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id         uuid NOT NULL REFERENCES scheduling.providers(id) ON DELETE CASCADE,
  field_definition_id uuid NOT NULL REFERENCES scheduling.provider_custom_field_definitions(id) ON DELETE CASCADE,
  value               jsonb,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, field_definition_id)
);

-- ── SECTION 7: Shift Configuration ─────────────────────────────────────────

CREATE TABLE scheduling.shift_types (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id                  uuid NOT NULL REFERENCES scheduling.sites(id) ON DELETE CASCADE,
  name                     text NOT NULL,
  code                     text NOT NULL,
  category                 scheduling.shift_category NOT NULL DEFAULT 'regular',
  provider_group           scheduling.provider_group NOT NULL DEFAULT 'both',
  start_time               time,
  end_time                 time,
  crosses_midnight         boolean NOT NULL DEFAULT false,
  duration_hours           numeric(4,1),
  color_hex                text DEFAULT '#6366f1',
  display_order            integer NOT NULL DEFAULT 0,
  counts_toward_hours      boolean NOT NULL DEFAULT true,
  counts_toward_call_burden boolean NOT NULL DEFAULT false,
  counts_as_weekend_burden boolean NOT NULL DEFAULT false,
  counts_as_holiday_burden boolean NOT NULL DEFAULT false,
  requires_post_call_rule  boolean NOT NULL DEFAULT false,
  requires_specific_skills jsonb DEFAULT '[]',
  requires_backup_pairing  boolean NOT NULL DEFAULT false,
  requires_credential      text,
  can_auto_assign          boolean NOT NULL DEFAULT true,
  manual_only              boolean NOT NULL DEFAULT false,
  is_active                boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scheduling.shift_templates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id             uuid NOT NULL REFERENCES scheduling.sites(id) ON DELETE CASCADE,
  schedule_layer      scheduling.schedule_layer NOT NULL DEFAULT 'call',
  day_type            scheduling.day_type NOT NULL DEFAULT 'weekday',
  weekday_number      smallint, -- 0=Sun, 1=Mon, ..., 6=Sat (nullable for non-weekday-specific)
  applies_on_holiday  boolean NOT NULL DEFAULT false,
  shift_type_id       uuid NOT NULL REFERENCES scheduling.shift_types(id) ON DELETE CASCADE,
  required_count      integer NOT NULL DEFAULT 1,
  required_skills     jsonb DEFAULT '[]',
  generation_priority integer NOT NULL DEFAULT 100,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scheduling.holiday_calendars (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES scheduling.organizations(id) ON DELETE CASCADE,
  site_id         uuid REFERENCES scheduling.sites(id) ON DELETE SET NULL,
  holiday_name    text NOT NULL,
  holiday_date    date NOT NULL,
  holiday_type    scheduling.holiday_type NOT NULL DEFAULT 'federal',
  color_hex       text DEFAULT '#fbbf24',
  is_major_holiday boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ── SECTION 8: Schedule Tables ──────────────────────────────────────────────

CREATE TABLE scheduling.schedules (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES scheduling.organizations(id) ON DELETE CASCADE,
  site_id                  uuid REFERENCES scheduling.sites(id) ON DELETE SET NULL,
  schedule_name            text NOT NULL,
  schedule_type            scheduling.schedule_type NOT NULL DEFAULT 'call',
  provider_group           scheduling.provider_group NOT NULL DEFAULT 'both',
  date_start               date NOT NULL,
  date_end                 date NOT NULL,
  status                   scheduling.schedule_status NOT NULL DEFAULT 'draft',
  current_version_number   integer NOT NULL DEFAULT 1,
  published_version_number integer,
  created_by               uuid REFERENCES scheduling.users(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scheduling.schedule_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id       uuid NOT NULL REFERENCES scheduling.schedules(id) ON DELETE CASCADE,
  version_number    integer NOT NULL,
  version_status    scheduling.version_status NOT NULL DEFAULT 'draft',
  created_by        uuid REFERENCES scheduling.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  published_at      timestamptz,
  notes             text,
  generation_run_id uuid,
  UNIQUE (schedule_id, version_number)
);

CREATE TABLE scheduling.schedule_slots (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_version_id   uuid NOT NULL REFERENCES scheduling.schedule_versions(id) ON DELETE CASCADE,
  site_id               uuid NOT NULL REFERENCES scheduling.sites(id) ON DELETE RESTRICT,
  slot_date             date NOT NULL,
  shift_type_id         uuid NOT NULL REFERENCES scheduling.shift_types(id) ON DELETE RESTRICT,
  slot_label            text,
  provider_group        scheduling.provider_group NOT NULL DEFAULT 'both',
  required_count        integer NOT NULL DEFAULT 1,
  slot_index            integer NOT NULL DEFAULT 0,
  start_datetime        timestamptz,
  end_datetime          timestamptz,
  derived_day_type      scheduling.day_type,
  requires_skills       jsonb DEFAULT '[]',
  locked                boolean NOT NULL DEFAULT false,
  generated_by_system   boolean NOT NULL DEFAULT false,
  metadata              jsonb DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scheduling.assignments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_slot_id    uuid NOT NULL REFERENCES scheduling.schedule_slots(id) ON DELETE CASCADE,
  provider_id         uuid REFERENCES scheduling.providers(id) ON DELETE SET NULL,
  assignment_status   scheduling.assignment_status NOT NULL DEFAULT 'open',
  source_type         scheduling.source_type NOT NULL DEFAULT 'manual',
  manually_overridden boolean NOT NULL DEFAULT false,
  is_open_call        boolean NOT NULL DEFAULT false,
  open_call_priority  integer,
  assigned_at         timestamptz,
  assigned_by         uuid REFERENCES scheduling.users(id) ON DELETE SET NULL,
  notes               text,
  validation_flags    jsonb DEFAULT '[]',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ── SECTION 9: Availability & Requests ──────────────────────────────────────

CREATE TABLE scheduling.provider_availability (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id       uuid NOT NULL REFERENCES scheduling.providers(id) ON DELETE CASCADE,
  site_id           uuid REFERENCES scheduling.sites(id) ON DELETE SET NULL,
  availability_type scheduling.availability_type NOT NULL,
  start_date        date NOT NULL,
  end_date          date NOT NULL,
  all_day           boolean NOT NULL DEFAULT true,
  recurrence_rule   text, -- iCal RRULE format
  reason_code       text,
  notes             text,
  source            text DEFAULT 'manual', -- manual, imported, system
  approved_by       uuid REFERENCES scheduling.users(id) ON DELETE SET NULL,
  approval_status   scheduling.approval_status NOT NULL DEFAULT 'pending',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scheduling.provider_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id     uuid NOT NULL REFERENCES scheduling.providers(id) ON DELETE CASCADE,
  site_id         uuid REFERENCES scheduling.sites(id) ON DELETE SET NULL,
  request_type    scheduling.request_type NOT NULL,
  start_date      date NOT NULL,
  end_date        date NOT NULL,
  part_of_day     text, -- 'morning', 'afternoon', 'evening', null=all day
  recurrence_rule text,
  notes           text,
  status          scheduling.approval_status NOT NULL DEFAULT 'pending',
  submitted_at    timestamptz NOT NULL DEFAULT now(),
  reviewed_at     timestamptz,
  reviewed_by     uuid REFERENCES scheduling.users(id) ON DELETE SET NULL,
  decision_reason text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ── SECTION 10: Rules Engine ────────────────────────────────────────────────

CREATE TABLE scheduling.rule_sets (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES scheduling.organizations(id) ON DELETE CASCADE,
  site_id              uuid NOT NULL REFERENCES scheduling.sites(id) ON DELETE CASCADE,
  name                 text NOT NULL,
  status               scheduling.rule_set_status NOT NULL DEFAULT 'draft',
  effective_start_date date,
  effective_end_date   date,
  original_plain_text  text,
  ai_summary           text,
  approved_by          uuid REFERENCES scheduling.users(id) ON DELETE SET NULL,
  approved_at          timestamptz,
  created_by           uuid REFERENCES scheduling.users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scheduling.rule_definitions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id               uuid NOT NULL REFERENCES scheduling.rule_sets(id) ON DELETE CASCADE,
  rule_name                 text NOT NULL,
  rule_category             scheduling.rule_category NOT NULL,
  hard_constraint           boolean NOT NULL DEFAULT true,
  priority_rank             integer NOT NULL DEFAULT 100,
  applies_to_provider_group scheduling.provider_group DEFAULT 'both',
  applies_to_shift_types    jsonb DEFAULT '[]',
  applies_to_day_types      jsonb DEFAULT '[]',
  condition                 jsonb NOT NULL DEFAULT '{}',
  action                    jsonb NOT NULL DEFAULT '{}',
  explanation_text          text,
  is_active                 boolean NOT NULL DEFAULT true,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- ── SECTION 11: Scheduler Runs ──────────────────────────────────────────────

CREATE TABLE scheduling.scheduler_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id           uuid NOT NULL REFERENCES scheduling.schedules(id) ON DELETE CASCADE,
  schedule_version_id   uuid REFERENCES scheduling.schedule_versions(id) ON DELETE SET NULL,
  initiated_by          uuid REFERENCES scheduling.users(id) ON DELETE SET NULL,
  started_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  run_status            text NOT NULL DEFAULT 'running', -- running, completed, failed
  parameters            jsonb DEFAULT '{}',
  warnings              jsonb DEFAULT '[]',
  validation_summary    jsonb DEFAULT '{}',
  open_slots_count      integer DEFAULT 0,
  soft_violations_count integer DEFAULT 0,
  hard_failures_count   integer DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- ── SECTION 12: Burden Tracking ─────────────────────────────────────────────

CREATE TABLE scheduling.burden_targets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id   uuid NOT NULL REFERENCES scheduling.providers(id) ON DELETE CASCADE,
  site_id       uuid REFERENCES scheduling.sites(id) ON DELETE SET NULL,
  period_type   text NOT NULL DEFAULT 'year', -- year, quarter, month
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  category      text NOT NULL, -- weekday_call, friday_call, weekend_call, holiday_call, backup_call, etc.
  target_value  numeric(6,2) NOT NULL,
  target_source text NOT NULL DEFAULT 'auto', -- auto, manual
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scheduling.burden_actuals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id       uuid NOT NULL REFERENCES scheduling.providers(id) ON DELETE CASCADE,
  site_id           uuid REFERENCES scheduling.sites(id) ON DELETE SET NULL,
  period_type       text NOT NULL DEFAULT 'year',
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  category          text NOT NULL,
  actual_value      numeric(6,2) NOT NULL DEFAULT 0,
  last_calculated_at timestamptz NOT NULL DEFAULT now()
);

-- ── SECTION 13: Swap Requests ───────────────────────────────────────────────

CREATE TABLE scheduling.swap_requests (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  initiating_provider_id        uuid NOT NULL REFERENCES scheduling.providers(id) ON DELETE CASCADE,
  target_provider_id            uuid NOT NULL REFERENCES scheduling.providers(id) ON DELETE CASCADE,
  schedule_slot_id              uuid NOT NULL REFERENCES scheduling.schedule_slots(id) ON DELETE CASCADE,
  proposed_new_schedule_slot_id uuid REFERENCES scheduling.schedule_slots(id) ON DELETE SET NULL,
  status                        scheduling.approval_status NOT NULL DEFAULT 'pending',
  submitted_at                  timestamptz NOT NULL DEFAULT now(),
  responded_at                  timestamptz,
  approved_by                   uuid REFERENCES scheduling.users(id) ON DELETE SET NULL,
  approved_at                   timestamptz,
  notes                         text,
  created_at                    timestamptz NOT NULL DEFAULT now()
);

-- ── SECTION 14: OpenCall Offers ─────────────────────────────────────────────

CREATE TABLE scheduling.open_call_offers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id  uuid NOT NULL REFERENCES scheduling.assignments(id) ON DELETE CASCADE,
  site_id        uuid NOT NULL REFERENCES scheduling.sites(id) ON DELETE CASCADE,
  posted_at      timestamptz NOT NULL DEFAULT now(),
  posted_by      uuid REFERENCES scheduling.users(id) ON DELETE SET NULL,
  status         text NOT NULL DEFAULT 'open', -- open, claimed, filled, expired, canceled
  eligible_pool  jsonb DEFAULT '[]',
  picked_up_by   uuid REFERENCES scheduling.providers(id) ON DELETE SET NULL,
  picked_up_at   timestamptz,
  premium_type   text, -- extra_pay, comp_time, etc.
  premium_amount numeric(8,2),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ── SECTION 15: Notifications ───────────────────────────────────────────────

CREATE TABLE scheduling.notifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES scheduling.organizations(id) ON DELETE CASCADE,
  user_id             uuid REFERENCES scheduling.users(id) ON DELETE SET NULL,
  provider_id         uuid REFERENCES scheduling.providers(id) ON DELETE SET NULL,
  notification_type   text NOT NULL, -- pto_submitted, pto_approved, schedule_published, etc.
  channel             text NOT NULL DEFAULT 'in_app', -- in_app, email, sms
  subject             text,
  message_body        text,
  status              text NOT NULL DEFAULT 'pending', -- pending, sent, failed, read
  scheduled_at        timestamptz,
  sent_at             timestamptz,
  related_entity_type text,
  related_entity_id   uuid,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- ── SECTION 16: Audit Log ───────────────────────────────────────────────────

CREATE TABLE scheduling.audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES scheduling.organizations(id) ON DELETE CASCADE,
  actor_user_id   uuid REFERENCES scheduling.users(id) ON DELETE SET NULL,
  entity_type     text NOT NULL, -- provider, schedule, assignment, rule_set, etc.
  entity_id       uuid NOT NULL,
  action_type     text NOT NULL, -- create, update, delete, publish, approve, deny, override
  before_json     jsonb,
  after_json      jsonb,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ── SECTION 17: Indexes ─────────────────────────────────────────────────────

-- Users
CREATE INDEX idx_users_org ON scheduling.users(organization_id, is_active);
CREATE UNIQUE INDEX idx_users_email ON scheduling.users(email);

-- Sites
CREATE INDEX idx_sites_org ON scheduling.sites(organization_id, is_active);

-- Providers
CREATE INDEX idx_providers_org_status ON scheduling.providers(organization_id, status);
CREATE INDEX idx_providers_org_type ON scheduling.providers(organization_id, provider_type);
CREATE UNIQUE INDEX idx_providers_employee_id ON scheduling.providers(organization_id, employee_id) WHERE employee_id IS NOT NULL;

-- Provider employment profiles (already has UNIQUE on provider_id from table def)

-- Provider site credentials
CREATE INDEX idx_psc_site ON scheduling.provider_site_credentials(site_id, is_active);

-- Shift types
CREATE INDEX idx_shift_types_site ON scheduling.shift_types(site_id, is_active);

-- Shift templates
CREATE INDEX idx_shift_templates_site_day ON scheduling.shift_templates(site_id, day_type, is_active);

-- Holiday calendars
CREATE INDEX idx_holidays_org_date ON scheduling.holiday_calendars(organization_id, holiday_date);

-- Schedules
CREATE INDEX idx_schedules_org_status ON scheduling.schedules(organization_id, site_id, status);
CREATE INDEX idx_schedules_site_dates ON scheduling.schedules(site_id, date_start, date_end);

-- Schedule versions
-- Already has UNIQUE on (schedule_id, version_number)

-- Schedule slots
CREATE INDEX idx_slots_version_date ON scheduling.schedule_slots(schedule_version_id, slot_date);
CREATE INDEX idx_slots_site_date ON scheduling.schedule_slots(site_id, slot_date, shift_type_id);

-- Assignments
CREATE INDEX idx_assignments_slot ON scheduling.assignments(schedule_slot_id);
CREATE INDEX idx_assignments_provider ON scheduling.assignments(provider_id, assignment_status);

-- Provider availability
CREATE INDEX idx_availability_provider ON scheduling.provider_availability(provider_id, start_date, end_date);
CREATE INDEX idx_availability_site ON scheduling.provider_availability(site_id, start_date);

-- Provider requests
CREATE INDEX idx_requests_provider ON scheduling.provider_requests(provider_id, status);

-- Rule definitions
CREATE INDEX idx_rules_set ON scheduling.rule_definitions(rule_set_id, is_active);

-- Burden
CREATE INDEX idx_burden_targets_provider ON scheduling.burden_targets(provider_id, category);
CREATE INDEX idx_burden_actuals_provider ON scheduling.burden_actuals(provider_id, category);

-- Audit log
CREATE INDEX idx_audit_org_entity ON scheduling.audit_log(organization_id, entity_type, entity_id);
CREATE INDEX idx_audit_org_time ON scheduling.audit_log(organization_id, created_at DESC);

-- Notifications
CREATE INDEX idx_notifications_user ON scheduling.notifications(user_id, status);

-- ── SECTION 18: Row Level Security ──────────────────────────────────────────

ALTER TABLE scheduling.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.provider_employment_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.provider_site_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.provider_custom_field_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.provider_custom_field_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.shift_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.shift_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.holiday_calendars ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.schedule_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.schedule_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.provider_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.provider_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.rule_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.rule_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.scheduler_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.burden_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.burden_actuals ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.swap_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.open_call_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling.audit_log ENABLE ROW LEVEL SECURITY;

-- RLS Policies: org-scoped access for tables with organization_id
-- (Using service role key bypasses RLS for server-side API routes)

CREATE POLICY org_access ON scheduling.organizations
  FOR ALL USING (id = scheduling.current_user_org_id());

CREATE POLICY org_access ON scheduling.users
  FOR ALL USING (organization_id = scheduling.current_user_org_id());

CREATE POLICY org_access ON scheduling.roles
  FOR ALL USING (organization_id = scheduling.current_user_org_id());

CREATE POLICY org_access ON scheduling.user_roles
  FOR ALL USING (EXISTS (
    SELECT 1 FROM scheduling.users u WHERE u.id = user_id AND u.organization_id = scheduling.current_user_org_id()
  ));

CREATE POLICY org_access ON scheduling.sites
  FOR ALL USING (organization_id = scheduling.current_user_org_id());

CREATE POLICY org_access ON scheduling.providers
  FOR ALL USING (organization_id = scheduling.current_user_org_id());

CREATE POLICY org_access ON scheduling.provider_employment_profiles
  FOR ALL USING (EXISTS (
    SELECT 1 FROM scheduling.providers p WHERE p.id = provider_id AND p.organization_id = scheduling.current_user_org_id()
  ));

CREATE POLICY org_access ON scheduling.provider_site_credentials
  FOR ALL USING (EXISTS (
    SELECT 1 FROM scheduling.providers p WHERE p.id = provider_id AND p.organization_id = scheduling.current_user_org_id()
  ));

CREATE POLICY org_access ON scheduling.provider_custom_field_definitions
  FOR ALL USING (organization_id = scheduling.current_user_org_id());

CREATE POLICY org_access ON scheduling.provider_custom_field_values
  FOR ALL USING (EXISTS (
    SELECT 1 FROM scheduling.providers p WHERE p.id = provider_id AND p.organization_id = scheduling.current_user_org_id()
  ));

CREATE POLICY org_access ON scheduling.shift_types
  FOR ALL USING (EXISTS (
    SELECT 1 FROM scheduling.sites s WHERE s.id = site_id AND s.organization_id = scheduling.current_user_org_id()
  ));

CREATE POLICY org_access ON scheduling.shift_templates
  FOR ALL USING (EXISTS (
    SELECT 1 FROM scheduling.sites s WHERE s.id = site_id AND s.organization_id = scheduling.current_user_org_id()
  ));

CREATE POLICY org_access ON scheduling.holiday_calendars
  FOR ALL USING (organization_id = scheduling.current_user_org_id());

CREATE POLICY org_access ON scheduling.schedules
  FOR ALL USING (organization_id = scheduling.current_user_org_id());

CREATE POLICY org_access ON scheduling.schedule_versions
  FOR ALL USING (EXISTS (
    SELECT 1 FROM scheduling.schedules s WHERE s.id = schedule_id AND s.organization_id = scheduling.current_user_org_id()
  ));

CREATE POLICY org_access ON scheduling.schedule_slots
  FOR ALL USING (EXISTS (
    SELECT 1 FROM scheduling.sites s WHERE s.id = site_id AND s.organization_id = scheduling.current_user_org_id()
  ));

CREATE POLICY org_access ON scheduling.assignments
  FOR ALL USING (EXISTS (
    SELECT 1 FROM scheduling.schedule_slots sl
    JOIN scheduling.sites s ON s.id = sl.site_id
    WHERE sl.id = schedule_slot_id AND s.organization_id = scheduling.current_user_org_id()
  ));

CREATE POLICY org_access ON scheduling.provider_availability
  FOR ALL USING (EXISTS (
    SELECT 1 FROM scheduling.providers p WHERE p.id = provider_id AND p.organization_id = scheduling.current_user_org_id()
  ));

CREATE POLICY org_access ON scheduling.provider_requests
  FOR ALL USING (EXISTS (
    SELECT 1 FROM scheduling.providers p WHERE p.id = provider_id AND p.organization_id = scheduling.current_user_org_id()
  ));

CREATE POLICY org_access ON scheduling.rule_sets
  FOR ALL USING (organization_id = scheduling.current_user_org_id());

CREATE POLICY org_access ON scheduling.rule_definitions
  FOR ALL USING (EXISTS (
    SELECT 1 FROM scheduling.rule_sets rs WHERE rs.id = rule_set_id AND rs.organization_id = scheduling.current_user_org_id()
  ));

CREATE POLICY org_access ON scheduling.scheduler_runs
  FOR ALL USING (EXISTS (
    SELECT 1 FROM scheduling.schedules s WHERE s.id = schedule_id AND s.organization_id = scheduling.current_user_org_id()
  ));

CREATE POLICY org_access ON scheduling.burden_targets
  FOR ALL USING (EXISTS (
    SELECT 1 FROM scheduling.providers p WHERE p.id = provider_id AND p.organization_id = scheduling.current_user_org_id()
  ));

CREATE POLICY org_access ON scheduling.burden_actuals
  FOR ALL USING (EXISTS (
    SELECT 1 FROM scheduling.providers p WHERE p.id = provider_id AND p.organization_id = scheduling.current_user_org_id()
  ));

CREATE POLICY org_access ON scheduling.swap_requests
  FOR ALL USING (EXISTS (
    SELECT 1 FROM scheduling.providers p WHERE p.id = initiating_provider_id AND p.organization_id = scheduling.current_user_org_id()
  ));

CREATE POLICY org_access ON scheduling.open_call_offers
  FOR ALL USING (EXISTS (
    SELECT 1 FROM scheduling.sites s WHERE s.id = site_id AND s.organization_id = scheduling.current_user_org_id()
  ));

CREATE POLICY org_access ON scheduling.notifications
  FOR ALL USING (organization_id = scheduling.current_user_org_id());

CREATE POLICY org_access ON scheduling.audit_log
  FOR ALL USING (organization_id = scheduling.current_user_org_id());

-- ── SECTION 19: Updated-at Triggers ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION scheduling.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'organizations', 'users', 'roles', 'sites', 'providers',
    'provider_employment_profiles', 'provider_site_credentials',
    'provider_custom_field_definitions', 'shift_types', 'shift_templates',
    'holiday_calendars', 'schedules', 'schedule_slots', 'assignments',
    'provider_availability', 'provider_requests', 'rule_sets', 'rule_definitions',
    'burden_targets'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER set_updated_at BEFORE UPDATE ON scheduling.%I FOR EACH ROW EXECUTE FUNCTION scheduling.set_updated_at()',
      tbl
    );
  END LOOP;
END;
$$;

-- ── SECTION 20: Expose scheduling schema to PostgREST ───────────────────────
-- Required for Supabase client to access the scheduling schema
ALTER ROLE authenticator SET pgrst.db_schemas TO 'public, scheduling';
NOTIFY pgrst, 'reload config';

-- Grant usage on the scheduling schema to the roles Supabase uses
GRANT USAGE ON SCHEMA scheduling TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA scheduling TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA scheduling TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA scheduling GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA scheduling GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
