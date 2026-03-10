-- ORBoard v5 — Working today table
-- Run in Supabase → SQL Editor → New Query

CREATE TABLE IF NOT EXISTS daily_active (
  id         uuid default gen_random_uuid() primary key,
  staff_id   uuid not null references staff(id) on delete cascade,
  board_date date not null default current_date,
  created_at timestamptz default now(),
  unique(staff_id, board_date)
);

ALTER TABLE daily_active ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON daily_active FOR ALL USING (true) WITH CHECK (true);
ALTER PUBLICATION supabase_realtime ADD TABLE daily_active;

-- Also add position columns for drag-to-reorder
ALTER TABLE sites ADD COLUMN IF NOT EXISTS sort_order integer DEFAULT 0;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS sort_order integer DEFAULT 0;
