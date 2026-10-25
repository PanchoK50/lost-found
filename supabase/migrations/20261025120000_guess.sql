-- Building GeoGuessr (docs/GEOGUESSR.md): community photos tagged on the 3D model, and live duels.
-- The web server reads and writes both with the secret key; browsers only see public photo files.

create table public.guess_spots (
  id uuid primary key,
  building_id text not null,
  floor_id text not null,
  space_id text not null,
  x double precision not null,          -- building metres, y up
  y double precision not null,
  image_path text not null,             -- in the public bucket 'guess-photos'
  author_id uuid not null references auth.users (id) on delete cascade,
  author_name text not null,
  caption text,
  created_at timestamptz not null default now()
);

create index guess_spots_building on public.guess_spots (building_id, created_at desc);

alter table public.guess_spots enable row level security;

create policy "guess photos are listed for everyone"
  on public.guess_spots for select to anon, authenticated using (true);

insert into storage.buckets (id, name, public) values ('guess-photos', 'guess-photos', true)
on conflict (id) do nothing;

-- One versioned JSON document per duel (rules in website/src/lib/guess/duel.ts), written with optimistic retries.
create table public.guess_duels (
  id text primary key,
  building_id text not null,
  status text not null,                 -- lobby | playing | over
  state jsonb not null,
  version integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index guess_duels_open on public.guess_duels (building_id, status, updated_at desc);

alter table public.guess_duels enable row level security;
-- No policies: only the server (secret key) reads and writes duels.
