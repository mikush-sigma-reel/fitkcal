-- FitKcal — schemat bazy. Wklej całość w Supabase → SQL Editor → Run.
-- Każda tabela ma RLS: użytkownik widzi i zmienia wyłącznie swoje wiersze.

-- ───────── Profil (dane do wyliczeń + preferencje treningowe) ─────────
create table if not exists public.profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  name           text,
  sex            text check (sex in ('m','f')),
  birth_date     date,
  height_cm      numeric(5,1),
  activity_level text default 'light'
                 check (activity_level in ('sedentary','light','moderate','active','very_active')),
  goal           text default 'cut' check (goal in ('cut','maintain','bulk')),
  -- tempo zmiany wagi w kg/tydzień (redukcja: np. 0.5)
  rate_kg_week   numeric(3,2) default 0.5,
  protein_g_kg   numeric(3,1) default 2.0,
  fat_g_kg       numeric(3,1) default 0.8,
  -- {place, equipment, days_per_week, session_min, experience, injuries, likes, notes}
  training       jsonb default '{}'::jsonb,
  updated_at     timestamptz default now()
);

-- ───────── Pomiary wagi ─────────
create table if not exists public.weights (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day        date not null default current_date,
  weight_kg  numeric(5,2) not null check (weight_kg > 20 and weight_kg < 400),
  created_at timestamptz default now(),
  unique (user_id, day)
);

-- ───────── Wpisy jedzenia ─────────
create table if not exists public.food_entries (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day        date not null default current_date,
  meal       text default 'snack' check (meal in ('breakfast','lunch','dinner','snack')),
  name       text not null,
  grams      numeric(7,1),
  kcal       numeric(7,1) not null default 0,
  protein    numeric(6,1) not null default 0,
  fat        numeric(6,1) not null default 0,
  carbs      numeric(6,1) not null default 0,
  source     text default 'manual' check (source in ('ai','barcode','manual')),
  barcode    text,
  created_at timestamptz default now()
);
create index if not exists food_entries_user_day on public.food_entries (user_id, day);

-- ───────── Treningi ─────────
create table if not exists public.workouts (
  id           bigint generated always as identity primary key,
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day          date not null default current_date,
  title        text not null,
  duration_min int,
  kcal_burned  int,
  -- [{name, sets:[{reps, kg}]}]
  exercises    jsonb default '[]'::jsonb,
  notes        text,
  created_at   timestamptz default now()
);
create index if not exists workouts_user_day on public.workouts (user_id, day);

-- ───────── Czat z trenerem ─────────
create table if not exists public.chat_messages (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  role       text not null check (role in ('user','assistant')),
  content    text not null,
  created_at timestamptz default now()
);
create index if not exists chat_messages_user_time on public.chat_messages (user_id, created_at desc);

-- ───────── Licznik zapytań AI (pilnuje limitu dziennego) ─────────
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null default current_date,
  count   int  not null default 0,
  primary key (user_id, day)
);

-- ───────── RLS ─────────
alter table public.profiles      enable row level security;
alter table public.weights       enable row level security;
alter table public.food_entries  enable row level security;
alter table public.workouts      enable row level security;
alter table public.chat_messages enable row level security;
alter table public.ai_usage      enable row level security;

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "own weights" on public.weights;
create policy "own weights" on public.weights
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own food" on public.food_entries;
create policy "own food" on public.food_entries
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own workouts" on public.workouts;
create policy "own workouts" on public.workouts
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own chat" on public.chat_messages;
create policy "own chat" on public.chat_messages
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ai_usage: użytkownik może tylko podejrzeć licznik; zwiększa go wyłącznie serwer
drop policy if exists "read own usage" on public.ai_usage;
create policy "read own usage" on public.ai_usage
  for select using (user_id = auth.uid());

-- Atomowo zwiększa licznik i zwraca nową wartość. Wywołuje go tylko funkcja serwerowa.
create or replace function public.bump_ai_usage(p_user uuid)
returns int
language sql
security definer
set search_path = public
as $$
  insert into public.ai_usage (user_id, day, count)
  values (p_user, current_date, 1)
  on conflict (user_id, day) do update set count = ai_usage.count + 1
  returning count;
$$;
revoke all on function public.bump_ai_usage(uuid) from public, anon, authenticated;
grant execute on function public.bump_ai_usage(uuid) to service_role;

-- Pusty profil zakłada się sam przy rejestracji
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
