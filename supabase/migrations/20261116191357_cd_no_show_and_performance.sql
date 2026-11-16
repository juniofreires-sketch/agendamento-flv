-- Permit CD to mark genuine absences while preserving the existing booking update guard.
create or replace function private.cancel_booking_guard()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if old.user_id is not null and new.user_id is null
     and (to_jsonb(new) - 'user_id') = (to_jsonb(old) - 'user_id') then
    return new;
  end if;
  if old.status = 'active' and new.status = 'no_show' then
    if not exists (
      select 1 from public.profiles p where p.id=(select auth.uid())
        and p.status='active' and p.role in ('admin','cd')
    ) then
      raise exception 'Apenas CD e administradores podem marcar No show.';
    end if;
    if old.day > ((now() at time zone 'America/Sao_Paulo')::date)
       or (old.day = ((now() at time zone 'America/Sao_Paulo')::date)
           and old.slot > ((now() at time zone 'America/Sao_Paulo')::time)) then
      raise exception 'No show só pode ser registrado após o horário agendado.';
    end if;
    if exists (select 1 from public.booking_arrivals a where a.booking_id=old.id) then
      raise exception 'Este fornecedor já possui horário de chegada registrado.';
    end if;
    if (to_jsonb(new) - 'status' - 'no_show_at') is distinct from
       (to_jsonb(old) - 'status' - 'no_show_at') then
      raise exception 'Apenas o status No show pode ser alterado.';
    end if;
    new.no_show_at := now();
    return new;
  end if;
  if old.status <> 'active' or new.status <> 'cancelled' then
    raise exception 'Este agendamento não pode ser cancelado.';
  end if;
  if (to_jsonb(new) - 'status' - 'cancelled_at') is distinct from
     (to_jsonb(old) - 'status' - 'cancelled_at') then
    raise exception 'Apenas o cancelamento é permitido.';
  end if;
  new.cancelled_at := now();
  return new;
end;
$$;
revoke all on function private.cancel_booking_guard() from public,anon,authenticated;

create or replace function public.cd_arrival_bookings_with_status(p_day date)
returns table(
  booking_id bigint,day date,slot time without time zone,supplier_id bigint,supplier_name text,
  order_number text,invoice_number text,weight_kg numeric,item_count integer,box_count integer,
  vehicle_type text,cargo_type text,arrival_time time without time zone,recorded_at timestamptz,status text
)
language plpgsql security definer set search_path = ''
as $$
declare requester public.profiles%rowtype;
begin
  select * into requester from public.profiles where id=(select auth.uid());
  if requester.id is null or requester.status<>'active' or requester.role not in ('admin','cd') then
    raise exception 'Apenas CD e administradores podem consultar chegadas.';
  end if;
  if p_day is null then raise exception 'Informe a data dos agendamentos.'; end if;
  return query
    select b.id,b.day,b.slot,b.supplier_id,s.name,b.order_number,b.invoice_number,
      b.weight_kg,b.item_count,b.box_count,b.vehicle_type,b.cargo_type,
      a.arrival_time,a.recorded_at,b.status
    from public.bookings b
    join public.suppliers s on s.id=b.supplier_id
    left join public.booking_arrivals a on a.booking_id=b.id
    where b.day=p_day and b.status in ('active','no_show')
    order by b.slot,s.name,b.id;
end;
$$;
revoke all on function public.cd_arrival_bookings_with_status(date) from public,anon,authenticated;
grant execute on function public.cd_arrival_bookings_with_status(date) to authenticated;

create or replace function public.mark_cd_booking_no_show(p_booking_id bigint)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  requester public.profiles%rowtype;
  booking_day date;
  booking_status text;
  booking_slot time without time zone;
begin
  select * into requester from public.profiles where id=(select auth.uid());
  if requester.id is null or requester.status<>'active' or requester.role not in ('admin','cd') then
    raise exception 'Apenas CD e administradores podem marcar No show.';
  end if;
  select b.day,b.status,b.slot into booking_day,booking_status,booking_slot
    from public.bookings b where b.id=p_booking_id for update;
  if not found then raise exception 'Agendamento não encontrado.'; end if;
  if booking_status<>'active' then raise exception 'Somente agendamentos confirmados podem ser marcados No show.'; end if;
  if booking_day>((now() at time zone 'America/Sao_Paulo')::date)
     or (booking_day=((now() at time zone 'America/Sao_Paulo')::date)
         and booking_slot>((now() at time zone 'America/Sao_Paulo')::time)) then
    raise exception 'No show só pode ser registrado após o horário agendado.';
  end if;
  if exists (select 1 from public.booking_arrivals a where a.booking_id=p_booking_id) then
    raise exception 'Este fornecedor já possui horário de chegada registrado.';
  end if;
  update public.bookings set status='no_show' where id=p_booking_id;
end;
$$;
revoke all on function public.mark_cd_booking_no_show(bigint) from public,anon,authenticated;
grant execute on function public.mark_cd_booking_no_show(bigint) to authenticated;

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
    order by count(*) filter (where arrival_time>slot) desc,
      coalesce(sum(late_minutes),0) desc,supplier_name limit 10
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
      order by s.late desc,s.late_minutes desc,s.supplier_name) from suppliers s),'[]'::jsonb),
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
