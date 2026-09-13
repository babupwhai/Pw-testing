begin;

create table if not exists public.pw_txt_jobs (
  id uuid primary key default gen_random_uuid(),
  chat_id bigint not null,
  telegram_id bigint not null,
  batch_id text not null,
  batch_name text not null,
  status text not null default 'queued',
  status_message_id bigint,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  worker_id text,
  lease_until timestamptz,
  attempts integer not null default 0,
  sent_parts integer not null default 0,
  last_error text,
  constraint pw_txt_jobs_status_check
    check (status in ('queued', 'processing', 'done', 'failed')),
  constraint pw_txt_jobs_attempts_check check (attempts between 0 and 3),
  constraint pw_txt_jobs_sent_parts_check check (sent_parts >= 0)
);

alter table public.pw_txt_jobs add column if not exists worker_id text;
alter table public.pw_txt_jobs add column if not exists lease_until timestamptz;
alter table public.pw_txt_jobs add column if not exists attempts integer not null default 0;
alter table public.pw_txt_jobs add column if not exists sent_parts integer not null default 0;
alter table public.pw_txt_jobs add column if not exists last_error text;

create index if not exists pw_txt_jobs_status_created_idx
  on public.pw_txt_jobs(status, created_at asc);
create index if not exists pw_txt_jobs_lease_idx
  on public.pw_txt_jobs(lease_until)
  where status = 'processing';
create unique index if not exists pw_txt_jobs_one_active_batch_idx
  on public.pw_txt_jobs(telegram_id, batch_id)
  where status in ('queued', 'processing');

alter table public.pw_txt_jobs enable row level security;
revoke all on public.pw_txt_jobs from anon, authenticated;
grant all on public.pw_txt_jobs to service_role;

create or replace function public.claim_pw_txt_job(
  p_worker_id text,
  p_lease_seconds integer default 300
)
returns setof public.pw_txt_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidate as (
    select id
    from public.pw_txt_jobs
    where attempts < 3
      and (
        status = 'queued'
        or (status = 'processing' and lease_until < now())
      )
    order by created_at asc
    for update skip locked
    limit 1
  )
  update public.pw_txt_jobs job
  set status = 'processing',
      worker_id = p_worker_id,
      started_at = coalesce(job.started_at, now()),
      lease_until = now() + make_interval(secs => greatest(60, least(p_lease_seconds, 1800))),
      attempts = job.attempts + 1
  from candidate
  where job.id = candidate.id
  returning job.*;
end;
$$;

revoke all on function public.claim_pw_txt_job(text, integer) from public, anon, authenticated;
grant execute on function public.claim_pw_txt_job(text, integer) to service_role;

commit;