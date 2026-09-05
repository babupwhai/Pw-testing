ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS variants jsonb,
  ADD COLUMN IF NOT EXISTS selected_quality text,
  ADD COLUMN IF NOT EXISTS stream_url text,
  ADD COLUMN IF NOT EXISTS segment_cursor integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS part_index integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS parts_sent integer NOT NULL DEFAULT 0;

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS max_part_mb integer NOT NULL DEFAULT 45;