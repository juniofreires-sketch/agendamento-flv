create or replace function public.dashboard_daily_supplier_summary(p_from date,p_to date)
returns table(day date,supplier_id bigint,supplier_name text,appointment_count bigint,slots text,weight_total numeric,box_total bigint,item_total bigint)
language plpgsql security definer set search_path = ''
as $$
declare
  requester public.profiles%rowtype;
begin
  select * into requester from public.profiles p where p.id=(select auth.uid());
  if requester.id is null or requester.status<>'active' or requester.role not in ('admin','commercial') then
    raise exception 'No permission to access this dashboard.';
  end if;
  if p_from is null or p_to is null or p_from>p_to then raise exception 'Invalid date range.'; end if;
  return query
    select b.day,b.supplier_id,s.name,1::bigint,
      pg_catalog.to_char(b.slot,'HH24:MI'),
      b.weight_kg::numeric,b.box_count::bigint,b.item_count::bigint
    from public.bookings b join public.suppliers s on s.id=b.supplier_id
    where b.day between p_from and p_to and b.status='active'
    order by b.day,b.slot,s.name,b.id;
end;
$$;
revoke all on function public.dashboard_daily_supplier_summary(date,date) from public,anon,authenticated;
grant execute on function public.dashboard_daily_supplier_summary(date,date) to authenticated;
