-- ============================================================
-- ORBoard v3 — Additional tables
-- Run in Supabase → SQL Editor → New Query
-- ============================================================

-- Daily MD designations (D1-D8, C1, C2, 8hr, 10hr)
create table if not exists daily_designations (
  id           uuid default gen_random_uuid() primary key,
  staff_id     uuid not null references staff(id) on delete cascade,
  board_date   date not null default current_date,
  designation  text not null check (designation in ('D1','D2','D3','D4','D5','D6','D7','D8','C1','C2','8hr','10hr')),
  created_at   timestamptz default now(),
  unique(staff_id, board_date)
);

-- Daily shift selections for CRNAs/SRNAs/Residents
create table if not exists daily_shifts (
  id           uuid default gen_random_uuid() primary key,
  staff_id     uuid not null references staff(id) on delete cascade,
  board_date   date not null default current_date,
  hours        text not null check (hours in ('8hr','10hr','12hr','24hr')),
  created_at   timestamptz default now(),
  unique(staff_id, board_date)
);

-- Break tracking
create table if not exists breaks (
  id           uuid default gen_random_uuid() primary key,
  staff_id     uuid not null references staff(id) on delete cascade,
  board_date   date not null default current_date,
  break_type   text not null check (break_type in ('morning','lunch','afternoon')),
  taken        boolean not null default false,
  taken_at     timestamptz,
  created_at   timestamptz default now(),
  unique(staff_id, board_date, break_type)
);

-- Relief log (permanent historical record)
create table if not exists relief_log (
  id            uuid default gen_random_uuid() primary key,
  staff_id      uuid not null references staff(id) on delete cascade,
  staff_name    text not null,
  staff_role    text not null,
  staff_initials text not null,
  board_date    date not null default current_date,
  relieved_at   timestamptz not null default now(),
  designation   text,
  shift_hours   text,
  created_at    timestamptz default now()
);

-- Enable realtime on new tables
alter publication supabase_realtime add table daily_designations;
alter publication supabase_realtime add table daily_shifts;
alter publication supabase_realtime add table breaks;
alter publication supabase_realtime add table relief_log;

-- RLS
alter table daily_designations enable row level security;
alter table daily_shifts        enable row level security;
alter table breaks              enable row level security;
alter table relief_log          enable row level security;

create policy "Allow all" on daily_designations for all using (true) with check (true);
create policy "Allow all" on daily_shifts        for all using (true) with check (true);
create policy "Allow all" on breaks              for all using (true) with check (true);
create policy "Allow all" on relief_log          for all using (true) with check (true);
