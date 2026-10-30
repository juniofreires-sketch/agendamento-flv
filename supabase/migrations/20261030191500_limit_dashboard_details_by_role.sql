create or replace function public.dashboard_daily_supplier_summary(p_from date,p_to date)
returns table(day date,supplier_id bigint,supplier_name text,appointment_count bigint,slots text)
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
  if requester.role='admin' then
    return query
      select b.day,b.supplier_id,s.name,count(*)::bigint,
        pg_catalog.string_agg(pg_catalog.to_char(b.slot,'HH24:MI'),', ' order by b.slot)
      from public.bookings b join public.suppliers s on s.id=b.supplier_id
      where b.day between p_from and p_to and b.status='active'
      group by b.day,b.supplier_id,s.name
      order by b.day,s.name;
    return;
  end if;
  return query
    select b.day,null::bigint,null::text,count(distinct b.supplier_id)::bigint,null::text
    from public.bookings b
    where b.day between p_from and p_to and b.status='active'
    group by b.day
    order by b.day;
end;
$$;
revoke all on function public.dashboard_daily_supplier_summary(date,date) from public,anon,authenticated;
grant execute on function public.dashboard_daily_supplier_summary(date,date) to authenticated;
