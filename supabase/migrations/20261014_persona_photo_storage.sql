-- Public persona portraits, writable only inside the authenticated user's folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('persona-photos', 'persona-photos', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = true, file_size_limit = 5242880, allowed_mime_types = excluded.allowed_mime_types;

create policy "Read persona portraits" on storage.objects
for select to public using (bucket_id = 'persona-photos');

create policy "Upload own persona portraits" on storage.objects
for insert to authenticated
with check (bucket_id = 'persona-photos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Update own persona portraits" on storage.objects
for update to authenticated
using (bucket_id = 'persona-photos' and (storage.foldername(name))[1] = auth.uid()::text)
with check (bucket_id = 'persona-photos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Delete own persona portraits" on storage.objects
for delete to authenticated
using (bucket_id = 'persona-photos' and (storage.foldername(name))[1] = auth.uid()::text);
