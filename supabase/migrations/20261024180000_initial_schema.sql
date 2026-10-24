-- Lost & Found: profiles, the multiplayer world, chat history and building edits.
-- Row-level security is on for every table. The web server writes with the secret key (bypasses RLS);
-- signed-in users read shared data and only their own private rows.

-- ---------- profiles: one per login (demo accounts are created by scripts/create-demo-users) ----------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text unique not null,
  display_name text not null,
  role text not null default 'member'
    check (role in ('member', 'facility', 'first_aider', 'visitor', 'exhibitor')),
  groups text[] not null default '{}',
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles are visible to signed-in users"
  on public.profiles for select to authenticated using (true);

create policy "users update their own profile"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- A profile row for every new auth user, from the sign-up metadata.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, username, display_name, role, groups)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'username', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'role', 'member'),
    coalesce(array(select jsonb_array_elements_text(new.raw_user_meta_data -> 'groups')), '{}')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- worlds: the multiplayer state per building (website/src/lib/world, StoredWorld) ----------
-- One versioned document per building; the server applies the world rules and writes with an optimistic
-- version check, so concurrent actions never overwrite each other.
create table public.worlds (
  building_id text primary key,
  state jsonb not null,
  version integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.worlds enable row level security;

create policy "worlds are visible to signed-in users"
  on public.worlds for select to authenticated using (true);

alter publication supabase_realtime add table public.worlds;

-- ---------- chat history ----------
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  building_id text not null,
  agent_session_id text,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index conversations_user_building on public.conversations (user_id, building_id, updated_at desc);

alter table public.conversations enable row level security;

create policy "users read their own conversations"
  on public.conversations for select to authenticated using ((select auth.uid()) = user_id);

create policy "users delete their own conversations"
  on public.conversations for delete to authenticated using ((select auth.uid()) = user_id);

create table public.messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  response jsonb,          -- the full ChatResponse (answer card + scene), to replay an answer on the map
  source text,             -- agent | world | demo
  cost numeric(10, 5),
  created_at timestamptz not null default now()
);

create index messages_conversation on public.messages (conversation_id, id);

alter table public.messages enable row level security;

create policy "users read messages of their own conversations"
  on public.messages for select to authenticated
  using (exists (
    select 1 from public.conversations c
    where c.id = conversation_id and c.user_id = (select auth.uid())
  ));

-- ---------- building edits: closures, new doors, moved assets ----------
create table public.building_edits (
  id bigint generated always as identity primary key,
  building_id text not null,
  user_id uuid references auth.users (id) on delete set null,
  conversation_id uuid references public.conversations (id) on delete set null,
  action jsonb not null,
  created_at timestamptz not null default now()
);

create index building_edits_building on public.building_edits (building_id, id);

alter table public.building_edits enable row level security;

create policy "building edits are visible to signed-in users"
  on public.building_edits for select to authenticated using (true);

create policy "users record their own edits"
  on public.building_edits for insert to authenticated with check ((select auth.uid()) = user_id);
