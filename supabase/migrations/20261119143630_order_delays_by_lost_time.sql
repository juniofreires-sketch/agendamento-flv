-- Rank delayed suppliers by total minutes lost before limiting to the top ten.
create or replace function public.arrival_performance_dashboard(
  p_from date,p_to date,p_supplier_id bigint default null
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  requester public.profiles%rowtype;
  local_day date := (now() at time zone 'America/Sao_Paulo')::date;
  result jsonb;
begin
  select * into requester from public.profiles where id=(select auth.uid());
  if requester.id is null or requester.status<>'active'
     or requester.role not in ('admin','commercial','cd') then
    raise exception 'Sem permissão para consultar o painel de chegadas.';
  end if;
  if p_from is null or p_to is null or p_from>p_to then raise exception 'Período inválido.'; end if;
  if p_supplier_id is not null and requester.role<>'admin' then
    raise exception 'Apenas administradores podem filtrar por fornecedor.';
  end if;

  with filtered as (
    select b.day,b.slot,b.status,b.supplier_id,s.name as supplier_name,a.arrival_time,
      greatest((extract(epoch from (a.arrival_time-b.slot))/60)::integer,0) as late_minutes
    from public.bookings b
    join public.suppliers s on s.id=b.supplier_id
    left join public.booking_arrivals a on a.booking_id=b.id
    where b.status in ('active','no_show') and b.day between p_from and p_to
      and (p_supplier_id is null or b.supplier_id=p_supplier_id)
  ), totals as (
    select count(*) as scheduled,
      count(*) filter (where day<=local_day) as scheduled_to_date,
      count(arrival_time) as recorded,
      count(*) filter (where status='no_show') as no_show,
      count(*) filter (where arrival_time>slot) as late,
      count(*) filter (where arrival_time<slot) as early,
      count(*) filter (where arrival_time=slot) as on_time,
      count(*) filter (where status='active' and arrival_time is null and day<=local_day) as pending,
      count(*) filter (where status='active' and arrival_time is null and day>local_day) as upcoming,
      coalesce(sum(late_minutes),0) as late_minutes,
      coalesce(round(avg(late_minutes) filter (where late_minutes>0),1),0) as average_late_minutes
    from filtered
  ), days as (
    select day,count(*) as scheduled,count(arrival_time) as recorded,
      count(*) filter (where status='no_show') as no_show,
      count(*) filter (where arrival_time>slot) as late,
      count(*) filter (where arrival_time<=slot) as on_time_or_early,
      count(*) filter (where status='active' and arrival_time is null and day<=local_day) as pending,
      coalesce(sum(late_minutes),0) as late_minutes
    from filtered group by day
  ), suppliers as (
    select supplier_id,supplier_name,count(*) as scheduled,count(arrival_time) as recorded,
      count(*) filter (where arrival_time>slot) as late,
      count(distinct day) filter (where arrival_time>slot) as late_days,
      coalesce(sum(late_minutes),0) as late_minutes,
      coalesce(round(avg(late_minutes) filter (where late_minutes>0),1),0) as average_late_minutes
    from filtered group by supplier_id,supplier_name
    having count(*) filter (where arrival_time>slot)>0
    order by coalesce(sum(late_minutes),0) desc,
      count(*) filter (where arrival_time>slot) desc,supplier_name limit 10
  ), no_show_suppliers as (
    select supplier_id,supplier_name,
      count(*) filter (where status='no_show') as no_show,
      count(*) filter (where day<=local_day) as scheduled_to_date,
      round(100.0*count(*) filter (where status='no_show')/
        nullif(count(*) filter (where day<=local_day),0),1) as no_show_percent
    from filtered group by supplier_id,supplier_name
    having count(*) filter (where status='no_show')>0
    order by count(*) filter (where status='no_show') desc,supplier_name limit 10
  ), slots as (
    select slot,count(*) as scheduled,count(arrival_time) as recorded,
      count(*) filter (where status='no_show') as no_show,
      count(*) filter (where arrival_time>slot) as late,
      coalesce(sum(late_minutes),0) as late_minutes
    from filtered group by slot
  )
  select pg_catalog.jsonb_build_object(
    'totals',(select pg_catalog.to_jsonb(t) from totals t),
    'days',coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) order by d.day) from days d),'[]'::jsonb),
    'top_suppliers',coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(s)
      order by s.late_minutes desc,s.late desc,s.supplier_name) from suppliers s),'[]'::jsonb),
    'top_no_show',coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(n)
      order by n.no_show desc,n.supplier_name) from no_show_suppliers n),'[]'::jsonb),
    'slots',coalesce((select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('slot',pg_catalog.to_char(sl.slot,'HH24:MI'),
      'scheduled',sl.scheduled,'recorded',sl.recorded,'no_show',sl.no_show,
      'late',sl.late,'late_minutes',sl.late_minutes) order by sl.slot) from slots sl),'[]'::jsonb)
  ) into result;
  return result;
end;
$$;
revoke all on function public.arrival_performance_dashboard(date,date,bigint) from public,anon,authenticated;
grant execute on function public.arrival_performance_dashboard(date,date,bigint) to authenticated;
