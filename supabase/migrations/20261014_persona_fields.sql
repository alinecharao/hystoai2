-- Expand personas while retaining legacy description data.
alter table public.personas add column if not exists photo_url text not null default '';
alter table public.personas add column if not exists gender text not null default '';
alter table public.personas add column if not exists age integer;
alter table public.personas add column if not exists role_description text not null default '';
alter table public.personas add column if not exists likes text not null default '';
alter table public.personas add column if not exists dislikes text not null default '';
alter table public.personas add column if not exists boundaries text not null default '';
alter table public.personas add column if not exists is_default boolean not null default false;
update public.personas set role_description = description where role_description = '' and description <> '';
alter table public.personas add constraint personas_age_valid check (age is null or (age between 1 and 120));
create unique index if not exists personas_one_default_per_user on public.personas (user_id) where is_default = true;
