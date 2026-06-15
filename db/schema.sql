-- Clubhouse — GS Pro shot data schema (Milestone 2)
-- Run this once in your Supabase project's SQL editor.
-- Idempotent: safe to re-run; existing tables/indexes/policies are skipped.

-- ── Extensions ───────────────────────────────────────────────────────────────
create extension if not exists "uuid-ossp";


-- ── players ──────────────────────────────────────────────────────────────────
-- One row per Optix member who has hit at least one shot at Clubhouse.
-- Auto-created on first session in M3 using their Optix email as the identifier.
create table if not exists public.players (
  id              uuid primary key default uuid_generate_v4(),
  optix_user_id   text unique,
  optix_member_id text,
  email           text unique,
  display_name    text,
  created_at      timestamptz not null default now()
);


-- ── sessions ─────────────────────────────────────────────────────────────────
-- One row per Optix booking. Created on booking start (M3), closed on booking
-- end or after `inactivityTimeoutMs` of no shots.
create table if not exists public.sessions (
  id               uuid primary key default uuid_generate_v4(),
  player_id        uuid references public.players(id) on delete set null,
  bay_number       integer not null check (bay_number in (1, 2)),
  optix_booking_id text,
  started_at       timestamptz not null,
  ended_at         timestamptz,
  shot_count       integer not null default 0
);

create index if not exists idx_sessions_player_id      on public.sessions(player_id);
create index if not exists idx_sessions_bay_started    on public.sessions(bay_number, started_at);
create index if not exists idx_sessions_optix_booking  on public.sessions(optix_booking_id);

-- Only one open session per bay at a time. Guards against duplicate session
-- rows if two relay polls race or a deploy collides with an existing process.
create unique index if not exists uniq_sessions_open_per_bay
  on public.sessions(bay_number)
  where ended_at is null;


-- ── shots ────────────────────────────────────────────────────────────────────
-- One row per shot the relay forwards to GS Pro. Written by the relay app
-- using the service_role key. session_id and player_id are nullable: M2 inserts
-- with both null, M3 backfills via timestamp ranges once sessions exist.
create table if not exists public.shots (
  id               uuid primary key default uuid_generate_v4(),
  session_id       uuid references public.sessions(id) on delete set null,
  player_id        uuid references public.players(id)  on delete set null,
  bay_number       integer not null check (bay_number in (1, 2)),
  shot_number      integer,
  ball_speed       double precision,
  spin_axis        double precision,
  total_spin       double precision,
  hla              double precision,
  vla              double precision,
  carry_distance   double precision,
  club_speed       double precision,
  face_to_target   double precision,
  attack_angle     double precision,
  path             double precision,
  club             text,
  raw              jsonb,
  recorded_at      timestamptz not null default now()
);

-- VIEW-source columns added by the file-watch pivot. The original schema was
-- written against the GS Pro Connect V1 TCP payload; these capture the extra
-- context VIEW writes via ProShotInfo.json.
alter table public.shots add column if not exists club_id   integer;
alter table public.shots add column if not exists hand      smallint;
alter table public.shots add column if not exists assurance jsonb;

-- Connect-log-tail pivot: the relay now reads the post-translation GS Pro
-- Open Connect envelope from GSPconnect's ConnectDebug.txt. The envelope
-- splits TotalSpin into BackSpin + SideSpin and exposes SpeedAtImpact —
-- promote those to first-class columns.
alter table public.shots add column if not exists back_spin       double precision;
alter table public.shots add column if not exists side_spin       double precision;
alter table public.shots add column if not exists speed_at_impact double precision;

create index if not exists idx_shots_player_id      on public.shots(player_id);
create index if not exists idx_shots_session_id     on public.shots(session_id);
create index if not exists idx_shots_recorded_at    on public.shots(recorded_at);
create index if not exists idx_shots_bay_recorded   on public.shots(bay_number, recorded_at);


-- ── Row Level Security ───────────────────────────────────────────────────────
-- Enabled on all tables. The service_role key bypasses RLS — both the relay
-- and the M4 stats Edge Function use it. The anon key has no read access and
-- never will: the Edge Function is the single data path for the stats canvas
-- so we can validate Optix tokens before returning any player data.
alter table public.players  enable row level security;
alter table public.sessions enable row level security;
alter table public.shots    enable row level security;


-- ── player_career_stats RPC (M4) ─────────────────────────────────────────────
-- Aggregates a player's career stats in a single query. The stats Edge Function
-- prefers this RPC (fast) but falls back to client-side aggregation if missing,
-- so deploying it is optional but recommended.
create or replace function public.player_career_stats(p_player_id uuid)
returns table (
  total_shots         bigint,
  total_sessions      bigint,
  avg_ball_speed      double precision,
  avg_carry_distance  double precision,
  avg_total_spin      double precision,
  longest_carry       double precision,
  fastest_ball_speed  double precision
)
language sql
security definer
set search_path = public
as $$
  select
    (select count(*) from public.shots    where player_id = p_player_id),
    (select count(*) from public.sessions where player_id = p_player_id),
    (select avg(ball_speed)     from public.shots where player_id = p_player_id),
    (select avg(carry_distance) from public.shots where player_id = p_player_id),
    (select avg(total_spin)     from public.shots where player_id = p_player_id),
    (select max(carry_distance) from public.shots where player_id = p_player_id),
    (select max(ball_speed)     from public.shots where player_id = p_player_id);
$$;

-- The Edge Function calls this with the service_role key, which has authenticated
-- access. We keep execution open to authenticated only — anon is denied at the
-- RLS boundary anyway, but this is belt-and-suspenders.
revoke all on function public.player_career_stats(uuid) from public;
grant execute on function public.player_career_stats(uuid) to service_role;
