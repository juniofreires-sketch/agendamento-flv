create table private.unscheduled_arrivals (
  id bigint generated always as identity primary key,
  supplier_id bigint not null references public.suppliers(id),
  day date not null,
  arrival_time time without time zone not null,
  recorded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index unscheduled_arrivals_day_idx on private.unscheduled_arrivals(day,supplier_id);
alter table private.unscheduled_arrivals enable row level security;
revoke all on private.unscheduled_arrivals from public,anon,authenticated;

create or replace function public.record_unscheduled_arrival(
  p_supplier_id bigint,p_day date,p_arrival_time time without time zone)
returns bigint language plpgsql security definer set search_path = ''
as $$
declare
  requester public.profiles%rowtype;
  local_day date := (now() at time zone 'America/Sao_Paulo')::date;
  local_time time := (now() at time zone 'America/Sao_Paulo')::time;
  new_id bigint;
begin
  select * into requester from public.profiles where id=(select auth.uid());
  if requester.id is null or requester.status<>'active' or requester.role not in ('admin','cd') then
    raise exception 'Apenas CD e administradores podem registrar veículos fora da agenda.';
  end if;
  if p_supplier_id is null or not exists(
    select 1 from public.suppliers where id=p_supplier_id and archived_at is null
  ) then
    raise exception 'Selecione um fornecedor disponível.';
  end if;
  if p_day is null or p_day>local_day then
    raise exception 'A data de chegada deve ser hoje ou uma data anterior.';
  end if;
  if p_arrival_time is null or (p_day=local_day and p_arrival_time>local_time) then
    raise exception 'Informe um horário de chegada que não esteja no futuro.';
  end if;
  insert into private.unscheduled_arrivals(supplier_id,day,arrival_time,recorded_by)
    values(p_supplier_id,p_day,p_arrival_time,(select auth.uid())) returning id into new_id;
  return new_id;
end;
$$;
revoke all on function public.record_unscheduled_arrival(bigint,date,time without time zone) from public,anon,authenticated;
grant execute on function public.record_unscheduled_arrival(bigint,date,time without time zone) to authenticated;

create or replace function public.list_unscheduled_arrivals(p_day date)
returns table(id bigint,day date,supplier_id bigint,supplier_name text,arrival_time time without time zone,created_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
declare requester public.profiles%rowtype;
begin
  select * into requester from public.profiles where id=(select auth.uid());
  if requester.id is null or requester.status<>'active' or requester.role not in ('admin','cd') then
    raise exception 'Apenas CD e administradores podem consultar veículos fora da agenda.';
  end if;
  if p_day is null then raise exception 'Informe a data de chegada.'; end if;
  return query
    select u.id,u.day,u.supplier_id,s.name,u.arrival_time,u.created_at
    from private.unscheduled_arrivals u join public.suppliers s on s.id=u.supplier_id
    where u.day=p_day order by u.arrival_time,s.name,u.id;
end;
$$;
revoke all on function public.list_unscheduled_arrivals(date) from public,anon,authenticated;
grant execute on function public.list_unscheduled_arrivals(date) to authenticated;

create or replace function public.unscheduled_arrival_summary(p_from date,p_to date,p_supplier_id bigint default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  requester public.profiles%rowtype;
  through_day date := least(p_to,(now() at time zone 'America/Sao_Paulo')::date);
  scheduled_total bigint := 0;
  unscheduled_total bigint := 0;
  top_suppliers jsonb := '[]'::jsonb;
begin
  select * into requester from public.profiles where id=(select auth.uid());
  if requester.id is null or requester.status<>'active' or requester.role not in ('admin','commercial','cd') then
    raise exception 'Sem permissão para consultar veículos fora da agenda.';
  end if;
  if p_from is null or p_to is null or p_from>p_to then raise exception 'Período inválido.'; end if;
  if p_supplier_id is not null and requester.role<>'admin' then
    raise exception 'Apenas administradores podem filtrar por fornecedor.';
  end if;
  select count(*) into scheduled_total from public.bookings b
    where b.status in ('active','no_show') and b.day between p_from and through_day
      and (p_supplier_id is null or b.supplier_id=p_supplier_id);
  select count(*) into unscheduled_total from private.unscheduled_arrivals u
    where u.day between p_from and through_day
      and (p_supplier_id is null or u.supplier_id=p_supplier_id);
  select coalesce(jsonb_agg(jsonb_build_object(
    'supplier_id',r.supplier_id,'supplier_name',r.supplier_name,
    'unscheduled',r.unscheduled,'scheduled',r.scheduled,
    'percent',round(r.unscheduled*100.0/(r.unscheduled+r.scheduled),1)
  ) order by r.unscheduled desc,r.supplier_name),'[]'::jsonb) into top_suppliers
  from (
    select u.supplier_id,s.name as supplier_name,count(*)::bigint as unscheduled,
      (select count(*) from public.bookings b where b.supplier_id=u.supplier_id
        and b.status in ('active','no_show') and b.day between p_from and through_day)::bigint as scheduled
    from private.unscheduled_arrivals u join public.suppliers s on s.id=u.supplier_id
    where u.day between p_from and through_day and (p_supplier_id is null or u.supplier_id=p_supplier_id)
    group by u.supplier_id,s.name
    order by count(*) desc,s.name limit 10
  ) r;
  return jsonb_build_object(
    'scheduled',scheduled_total,'unscheduled',unscheduled_total,
    'unscheduled_percent',case when scheduled_total+unscheduled_total=0 then 0
      else round(unscheduled_total*100.0/(scheduled_total+unscheduled_total),1) end,
    'top_suppliers',top_suppliers
  );
end;
$$;
revoke all on function public.unscheduled_arrival_summary(date,date,bigint) from public,anon,authenticated;
grant execute on function public.unscheduled_arrival_summary(date,date,bigint) to authenticated;
