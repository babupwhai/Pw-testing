begin;

create extension if not exists pgcrypto;

do $$
begin
  create type public.app_role as enum ('admin');
exception
  when duplicate_object then null;
end
$$;

create table if not exists public.settings (
  id integer primary key default 1,
  default_daily_limit integer not null default 50,
  max_file_mb integer not null default 2000,
  max_part_mb integer not null default 45,
  parallel_jobs integer not null default 3,
  allow_all_users boolean not null default true,
  welcome_text text,
  bot_token text,
  bot_username text,
  webhook_url text,
  webhook_set_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.bot_users (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint not null unique,
  first_name text,
  username text,
  blocked boolean not null default false,
  is_bot_admin boolean not null default false,
  daily_limit integer,
  total_jobs integer not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.batches (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint not null,
  chat_id bigint not null,
  source_name text,
  total integer not null default 0,
  done integer not null default 0,
  failed integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint not null,
  chat_id bigint not null,
  batch_id uuid references public.batches(id) on delete set null,
  url text not null,
  title text,
  kind text not null default 'video',
  method text,
  status text not null default 'queued',
  variants jsonb,
  status_message_id bigint,
  stream_url text,
  selected_quality text,
  file_name text,
  file_size bigint,
  progress integer not null default 0,
  attempts integer not null default 0,
  segment_cursor integer not null default 0,
  part_index integer not null default 0,
  parts_sent integer not null default 0,
  position integer not null default 0,
  ms_taken integer,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.usage_daily (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint not null,
  day date not null default current_date,
  count integer not null default 0,
  unique (telegram_id, day)
);

create table if not exists public.tg_updates (
  update_id bigint primary key,
  created_at timestamptz not null default now()
);

create table if not exists public.pw_nav (
  token text primary key,
  data jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null,
  created_at timestamptz not null default now(),
  unique (user_id, role)
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end
$$;

drop trigger if exists settings_set_updated_at on public.settings;
create trigger settings_set_updated_at
before update on public.settings
for each row execute function public.set_updated_at();

drop trigger if exists bot_users_set_updated_at on public.bot_users;
create trigger bot_users_set_updated_at
before update on public.bot_users
for each row execute function public.set_updated_at();

drop trigger if exists batches_set_updated_at on public.batches;
create trigger batches_set_updated_at
before update on public.batches
for each row execute function public.set_updated_at();

drop trigger if exists jobs_set_updated_at on public.jobs;
create trigger jobs_set_updated_at
before update on public.jobs
for each row execute function public.set_updated_at();

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles
    where user_id = _user_id and role = _role
  )
$$;

create index if not exists jobs_status_created_at_idx
on public.jobs(status, created_at desc);
create index if not exists jobs_queue_idx
on public.jobs(status, created_at asc, position asc);
create index if not exists jobs_telegram_created_idx
on public.jobs(telegram_id, created_at desc);
create index if not exists jobs_batch_idx on public.jobs(batch_id);
create index if not exists bot_users_last_seen_idx
on public.bot_users(last_seen_at desc);
create index if not exists usage_daily_telegram_day_idx
on public.usage_daily(telegram_id, day);
create index if not exists user_roles_user_role_idx
on public.user_roles(user_id, role);

insert into public.settings (id)
values (1)
on conflict (id) do nothing;

alter table public.settings enable row level security;
alter table public.bot_users enable row level security;
alter table public.batches enable row level security;
alter table public.jobs enable row level security;
alter table public.usage_daily enable row level security;
alter table public.tg_updates enable row level security;
alter table public.pw_nav enable row level security;
alter table public.user_roles enable row level security;

revoke all on public.settings from anon, authenticated;
revoke all on public.bot_users from anon, authenticated;
revoke all on public.batches from anon, authenticated;
revoke all on public.jobs from anon, authenticated;
revoke all on public.usage_daily from anon, authenticated;
revoke all on public.tg_updates from anon, authenticated;
revoke all on public.pw_nav from anon, authenticated;
revoke all on public.user_roles from anon, authenticated;
grant execute on function public.has_role(uuid, public.app_role) to authenticated;

commit;