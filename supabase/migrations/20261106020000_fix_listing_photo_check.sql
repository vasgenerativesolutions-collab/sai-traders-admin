-- The photo requirement for listing a saree was not enforced.
--
-- trg_enforce_listing_rules tested:
--
--   IF NEW.image_urls IS NULL OR array_length(NEW.image_urls, 1) < 1
--
-- array_length('{}'::text[], 1) is NULL, not 0 — Postgres reports no dimension for an
-- empty array. So for the column's own default value of '{}' the test evaluated to
-- NULL OR NULL, the IF never fired, and a saree with no photographs at all could be
-- listed and shown to customers. The other four conditions all worked, which is why
-- this went unnoticed: the rule looked present and refused on whichever check came
-- after it.
--
-- coalesce makes the absent dimension mean zero, which is what was meant.
--
-- The checks are also reordered to report in the order someone fills them in, and
-- each exception now names the saree, because "Cannot list: missing photos" with no
-- subject is hard to act on when several are being prepared at once.

create or replace function public.trg_enforce_listing_rules()
returns trigger
language plpgsql
as $function$
begin
  if new.status = 'listed'
     and (tg_op = 'INSERT' or old.status is distinct from 'listed')
  then
    if new.name is null or trim(new.name) = '' then
      raise exception 'Cannot list %: missing name', coalesce(new.sku, '(no sku)');
    end if;

    -- A saree still carrying its Tally stock code has not been named for customers.
    if new.tally_part_number is not null
       and lower(trim(new.name)) = lower(trim(new.tally_part_number)) then
      raise exception 'Cannot list %: still named after its Tally code, give it a name customers will understand',
        coalesce(new.sku, '(no sku)');
    end if;

    if new.price is null or new.price <= 0 then
      raise exception 'Cannot list %: missing selling price', coalesce(new.sku, '(no sku)');
    end if;

    -- coalesce, because array_length of an empty array is NULL and the comparison
    -- silently became NULL instead of true.
    if new.image_urls is null or coalesce(array_length(new.image_urls, 1), 0) < 1 then
      raise exception 'Cannot list %: missing photos', coalesce(new.sku, '(no sku)');
    end if;

    if not exists (
      select 1 from public.video_item vi
      join public.video_record vr on vr.video_id = vi.video_id
      where vi.product_code = new.tally_part_number
        and vi.verified = true and vr.is_active = true
    ) then
      raise exception 'Cannot list %: no verified video item', coalesce(new.sku, '(no sku)');
    end if;

    if not new.item_created_in_tally or not new.stock_added_in_tally then
      raise exception 'Cannot list %: not confirmed in Tally', coalesce(new.sku, '(no sku)');
    end if;
  end if;

  return new;
end;
$function$;
