ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS bot_token text,
  ADD COLUMN IF NOT EXISTS bot_username text,
  ADD COLUMN IF NOT EXISTS webhook_url text,
  ADD COLUMN IF NOT EXISTS webhook_set_at timestamptz;

INSERT INTO public.settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;