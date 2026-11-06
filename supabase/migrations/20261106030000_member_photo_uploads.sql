-- Let a signed-in shop member upload a catalogue photograph.
--
-- storage.objects had exactly one policy: public SELECT on the catalogue bucket. Every
-- upload therefore had to go through the store server using the service key, so a
-- dashboard hosted without a server could not add a photo — and a photo is one of the
-- five conditions for putting a saree on sale. The workflow simply stopped there.
--
-- Members may now write to the catalogue images bucket from their own session. Scoped as
-- tightly as the bucket allows:
--
--   * only the saree-catalog-images bucket, which is already public for reading and
--     holds nothing private
--   * only authenticated users who belong to a shop, which is what current_user_shop_ids
--     answers
--   * no delete, so a careless click cannot remove a photograph another member added;
--     removing one still goes through the server
--
-- customer-media is deliberately untouched. It holds images people sent over WhatsApp.

begin;

drop policy if exists catalog_images_member_insert on storage.objects;
create policy catalog_images_member_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'saree-catalog-images'
    and exists (select 1 from public.shop_members m where m.user_id = auth.uid())
  );

-- Overwriting the same path is how a re-upload of a corrected image works.
drop policy if exists catalog_images_member_update on storage.objects;
create policy catalog_images_member_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'saree-catalog-images'
    and exists (select 1 from public.shop_members m where m.user_id = auth.uid())
  );

commit;
