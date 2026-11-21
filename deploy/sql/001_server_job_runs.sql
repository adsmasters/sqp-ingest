-- Tabelle fuer Meldungen der Server-Jobs (Hetzner). Hauptprojekt lgrnmiszhhahfcmctmwo. Einmalig im Supabase-SQL-Editor ausfuehren.
-- Nur NEUE Tabelle: aendert keine bestehende Tabelle, loescht nichts.
--  kind = 'run'   : ein beendeter Job-Schritt (deploy/server-job.sh -> report-job-run.mjs): result success|failed|timeout|killed|skipped
--  kind = 'alert' : eigene Meldung eines Skripts (notify.mjs, z. B. ads-periodic Fail-Open); sent_at wird vom Waechter gesetzt, wenn sie nach Slack ging
-- Zugriff NUR mit dem service_role-Schluessel (Server-Jobs, GitHub-Waechter): RLS an, keine Rechte fuer anon/authenticated.
create table if not exists public.server_job_runs (
  id          bigserial primary key,
  job         text        not null,
  kind        text        not null default 'run' check (kind in ('run', 'alert')),
  result      text,
  exit_status text,
  host        text,
  detail      text,
  finished_at timestamptz not null default now(),
  sent_at     timestamptz
);
create index if not exists server_job_runs_job_finished_idx on public.server_job_runs (job, finished_at desc);
create index if not exists server_job_runs_unsent_alerts_idx on public.server_job_runs (finished_at) where kind = 'alert' and sent_at is null;
alter table public.server_job_runs enable row level security;
revoke all on table public.server_job_runs from anon, authenticated;
revoke all on sequence public.server_job_runs_id_seq from anon, authenticated;
-- Aufraeumen (optional, spaeter): alte 'run'-Zeilen nach 90 Tagen loeschen.
