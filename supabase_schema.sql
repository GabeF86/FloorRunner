-- ============================================================
-- ORBoard — Supabase Schema  (v2 — with supervision logic)
-- Run this entire file in: Supabase → SQL Editor → New Query
-- ============================================================

-- Sites
create table if not exists sites (
  id         uuid default gen_random_uuid() primary key,
  name       text not null,
  color      text not null default '#0ea5e9',
  icon       text not null default '◈',
  position   integer not null default 0,
  created_at timestamptz default now()
);

-- Rooms
create table if not exists rooms (
  id         uuid default gen_random_uuid() primary key,
  site_id    uuid not null references sites(id) on delete cascade,
  name       text not null,
  position   integer not null default 0,
  created_at timestamptz default now()
);

-- Staff
create table if not exists staff (
  id         uuid default gen_random_uuid() primary key,
  name       text not null,
  initials   text not null,
  role       text not null check (role in ('physician','crna','srna','resident','surgeon')),
  hours      text not null default '8hr' check (hours in ('8hr','10hr','12hr','24hr')),
  created_at timestamptz default now()
);

-- Assignments
-- NOTE: No unique(staff_id, board_date) constraint — physicians can cover multiple rooms.
-- Uniqueness for non-physicians is enforced in application logic (API route).
create table if not exists assignments (
  id         uuid default gen_random_uuid() primary key,
  room_id    uuid not null references rooms(id) on delete cascade,
  staff_id   uuid not null references staff(id) on delete cascade,
  board_date date not null default current_date,
  created_at timestamptz default now()
);

-- Prevent a physician from being assigned to the same room twice on the same day
create unique index if not exists assignments_physician_room_date
  on assignments(staff_id, room_id, board_date);

-- ── Enable Realtime ──────────────────────────────────────────────────────────
alter publication supabase_realtime add table assignments;
alter publication supabase_realtime add table sites;
alter publication supabase_realtime add table rooms;
alter publication supabase_realtime add table staff;

-- ── Row Level Security ───────────────────────────────────────────────────────
alter table sites       enable row level security;
alter table rooms       enable row level security;
alter table staff       enable row level security;
alter table assignments enable row level security;

create policy "Allow all" on sites       for all using (true) with check (true);
create policy "Allow all" on rooms       for all using (true) with check (true);
create policy "Allow all" on staff       for all using (true) with check (true);
create policy "Allow all" on assignments for all using (true) with check (true);

-- ── Seed data ────────────────────────────────────────────────────────────────
insert into sites (name, color, icon, position) values
  ('Main OR',   '#0ea5e9', '⚕', 1),
  ('Endoscopy', '#10b981', '◎', 2),
  ('Neuro Lab', '#8b5cf6', '⬡', 3),
  ('EP Lab',    '#f59e0b', '♥', 4),
  ('OB',        '#ec4899', '✦', 5)
on conflict do nothing;
