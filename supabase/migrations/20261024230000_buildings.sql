-- Buildings the app can show: the 280 dataset buildings plus ones created from uploaded plans.
-- The building.json files live in the private Storage bucket 'buildings' at <id>/building.json; the web
-- server and the agent read them with the secret key.
create table public.buildings (
  id text primary key,
  name text not null,
  source text not null,                  -- swiss | resplan | osm | procedural | upload
  split text,                            -- train | dev | test for dataset buildings, null for uploads
  license text,
  attribution text,
  floors integer not null,
  levels text,
  spaces integer not null,
  assets integer not null default 0,
  storage_path text not null,
  created_by uuid references auth.users (id) on delete set null,
  ingest_report jsonb,                   -- uploads: what the plan importer inferred or could not tell
  created_at timestamptz not null default now()
);

create index buildings_name on public.buildings (name);

alter table public.buildings enable row level security;

create policy "buildings are listed for everyone"
  on public.buildings for select to anon, authenticated using (true);

insert into storage.buckets (id, name, public) values ('buildings', 'buildings', false)
on conflict (id) do nothing;
