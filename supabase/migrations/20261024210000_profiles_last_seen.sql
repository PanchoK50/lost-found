-- Online status independent of location sharing: the web app marks a signed-in user as seen while the app is open.
alter table public.profiles add column last_seen_at timestamptz;
create index profiles_last_seen on public.profiles (last_seen_at desc);
