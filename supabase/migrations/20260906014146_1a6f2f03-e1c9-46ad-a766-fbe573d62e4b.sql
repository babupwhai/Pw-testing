CREATE TABLE public.pw_nav (
  token text PRIMARY KEY,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.pw_nav TO service_role;
ALTER TABLE public.pw_nav ENABLE ROW LEVEL SECURITY;