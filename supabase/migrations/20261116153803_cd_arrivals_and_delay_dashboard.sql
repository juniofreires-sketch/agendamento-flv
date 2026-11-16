-- CD users see the dashboard and may record arrivals; suppliers keep their existing isolation.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check check (role in ('supplier','admin','commercial','cd'));

create table public.booking_arrivals (
  booking_id bigint primary key references public.bookings(id) on delete cascade,
  arrival_time time without time zone not null,
  recorded_by uuid references auth.users(id) on delete set null,
  recorded_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index booking_arrivals_recorded_by_idx on public.booking_arrivals(recorded_by);
alter table public.booking_arrivals enable row level security;
revoke all on public.booking_arrivals from public,anon,authenticated;

create or replace function public.admin_approve_user(p_user_id uuid, p_role text)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not (select private.is_admin()) then
    raise exception 'Apenas administradores podem aprovar acessos.';
  end if;
  if p_role is null or p_role not in ('supplier','admin','commercial','cd') then
    raise exception 'Escolha Administrador, Fornecedor, Comercial ou CD.';
  end if;
  if not exists (
    select 1 from public.profiles
    where id=p_user_id and role='supplier' and status='pending'
  ) then
    raise exception 'Solicitação pendente não encontrada.';
  end if;
  if p_role in ('admin','commercial','cd') then
    update public.profiles
      set role=p_role,status='active',supplier_id=null,requested_supplier_name=null
      where id=p_user_id;
  else
    update public.profiles set status='active' where id=p_user_id;
  end if;
end;
$$;
revoke all on function public.admin_approve_user(uuid,text) from public,anon,authenticated;
grant execute on function public.admin_approve_user(uuid,text) to authenticated;

create or replace function public.admin_update_user_role(p_user_id uuid,p_role text,p_supplier_id bigint default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  target public.profiles%rowtype;
begin
  if (select auth.uid()) is null or not (select private.is_admin()) then
    raise exception 'Apenas administradores podem alterar perfis.';
  end if;
  if p_user_id=(select auth.uid()) then
    raise exception 'Não é possível alterar o próprio perfil.';
  end if;
  if p_role is null or p_role not in ('admin','supplier','commercial','cd') then
    raise exception 'Selecione Administrador, Fornecedor, Comercial ou CD.';
  end if;
  select * into target from public.profiles where id=p_user_id for update;
  if target.id is null then raise exception 'Usuário não encontrado.'; end if;
  if target.status<>'active' then raise exception 'Altere o perfil pela aprovação pendente deste usuário.'; end if;
  if p_role='supplier' and (p_supplier_id is null or not exists(select 1 from public.suppliers where id=p_supplier_id)) then
    raise exception 'Selecione um fornecedor para este usuário.';
  end if;
  update public.profiles
    set role=p_role,
        supplier_id=case when p_role='supplier' then p_supplier_id else null end,
        requested_supplier_name=null
    where id=p_user_id;
end;
$$;
revoke all on function public.admin_update_user_role(uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.admin_update_user_role(uuid,text,bigint) to authenticated;

create or replace function public.commercial_dashboard(p_from date,p_to date)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  requester public.profiles%rowtype;
  result jsonb;
begin
  select * into requester from public.profiles where id=(select auth.uid());
  if requester.id is null or requester.status<>'active' or requester.role not in ('admin','commercial','cd') then
    raise exception 'Sem permissão para acessar este painel.';
  end if;
  if p_from is null or p_to is null or p_from>p_to then raise exception 'Período inválido.'; end if;
  with active as (
    select day,weight_kg,item_count,box_count,cargo_type
    from public.bookings where day between p_from and p_to and status='active'
  ), totals as (
    select count(*) as carros,coalesce(sum(weight_kg),0) as peso,
           coalesce(sum(item_count),0) as items,coalesce(sum(box_count),0) as boxes
    from active
  ), weekdays as (
    select d.day_name,coalesce(c.n,0) as count,d.sort_order
    from (values ('Segunda',1,1),('Terça',2,2),('Quarta',3,3),('Quinta',4,4),('Sexta',5,5),('Sábado',6,6)) d(day_name,day_num,sort_order)
    left join (select extract(isodow from day)::integer as day_num,count(*) as n from active group by 1) c using(day_num)
  ), cargos as (
    select d.name,coalesce(c.n,0) as count,d.sort_order
    from (values ('Batida / Paletizada',1),('Carga batida',2),('Paletizada',3),('Pallet sobreposto',4)) d(name,sort_order)
    left join (select cargo_type,count(*) as n from active group by cargo_type) c on c.cargo_type=d.name
  )
  select pg_catalog.jsonb_build_object(
    'carros',totals.carros,'peso',totals.peso,'items',totals.items,'boxes',totals.boxes,
    'weekday_counts',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',day_name,'count',count) order by sort_order) from weekdays),
    'cargo_counts',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',name,'count',count) order by sort_order) from cargos)
  ) into result from totals;
  return result;
end;
$$;
revoke all on function public.commercial_dashboard(date,date) from public,anon,authenticated;
grant execute on function public.commercial_dashboard(date,date) to authenticated;

create or replace function public.dashboard_daily_supplier_summary(p_from date,p_to date)
returns table(day date,supplier_id bigint,supplier_name text,appointment_count bigint,slots text,weight_total numeric,box_total bigint,item_total bigint)
language plpgsql security definer set search_path = ''
as $$
declare
  requester public.profiles%rowtype;
begin
  select * into requester from public.profiles p where p.id=(select auth.uid());
  if requester.id is null or requester.status<>'active' or requester.role not in ('admin','commercial','cd') then
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

create or replace function public.cd_arrival_bookings(p_day date)
returns table(
  booking_id bigint,day date,slot time without time zone,supplier_id bigint,supplier_name text,
  order_number text,invoice_number text,weight_kg numeric,item_count integer,box_count integer,
  vehicle_type text,cargo_type text,arrival_time time without time zone,recorded_at timestamptz
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
      b.weight_kg,b.item_count,b.box_count,b.vehicle_type,b.cargo_type,a.arrival_time,a.recorded_at
    from public.bookings b
    join public.suppliers s on s.id=b.supplier_id
    left join public.booking_arrivals a on a.booking_id=b.id
    where b.day=p_day and b.status='active'
    order by b.slot,s.name,b.id;
end;
$$;
revoke all on function public.cd_arrival_bookings(date) from public,anon,authenticated;
grant execute on function public.cd_arrival_bookings(date) to authenticated;

create or replace function public.record_booking_arrival(p_booking_id bigint,p_arrival_time time without time zone)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  requester public.profiles%rowtype;
  booking_day date;
  local_day date := (now() at time zone 'America/Sao_Paulo')::date;
  local_time time := (now() at time zone 'America/Sao_Paulo')::time;
begin
  select * into requester from public.profiles where id=(select auth.uid());
  if requester.id is null or requester.status<>'active' or requester.role not in ('admin','cd') then
    raise exception 'Apenas CD e administradores podem registrar chegadas.';
  end if;
  if p_booking_id is null or p_arrival_time is null then
    raise exception 'Informe um horário de chegada válido.';
  end if;
  select b.day into booking_day from public.bookings b
    where b.id=p_booking_id and b.status='active' for update;
  if not found then raise exception 'Agendamento confirmado não encontrado.'; end if;
  if booking_day>local_day or (booking_day=local_day and p_arrival_time>local_time) then
    raise exception 'O horário de chegada não pode estar no futuro.';
  end if;
  insert into public.booking_arrivals(booking_id,arrival_time,recorded_by)
    values(p_booking_id,p_arrival_time,(select auth.uid()))
  on conflict (booking_id) do update
    set arrival_time=excluded.arrival_time,recorded_by=excluded.recorded_by,updated_at=now();
end;
$$;
revoke all on function public.record_booking_arrival(bigint,time without time zone) from public,anon,authenticated;
grant execute on function public.record_booking_arrival(bigint,time without time zone) to authenticated;

create or replace function public.arrival_delay_summary(p_from date,p_to date)
returns table(
  supplier_id bigint,supplier_name text,late_days bigint,late_arrivals bigint,
  total_delay_minutes bigint,average_delay_minutes numeric
)
language plpgsql security definer set search_path = ''
as $$
declare requester public.profiles%rowtype;
begin
  select * into requester from public.profiles where id=(select auth.uid());
  if requester.id is null or requester.status<>'active' or requester.role not in ('admin','commercial','cd') then
    raise exception 'Sem permissão para consultar atrasos.';
  end if;
  if p_from is null or p_to is null or p_from>p_to then raise exception 'Período inválido.'; end if;
  return query
    select b.supplier_id,s.name,count(distinct b.day)::bigint,count(*)::bigint,
      sum((extract(epoch from (a.arrival_time-b.slot))/60)::integer)::bigint,
      round(avg(extract(epoch from (a.arrival_time-b.slot))/60),1)
    from public.bookings b
    join public.booking_arrivals a on a.booking_id=b.id
    join public.suppliers s on s.id=b.supplier_id
    where b.status='active' and b.day between p_from and p_to and a.arrival_time>b.slot
    group by b.supplier_id,s.name
    order by count(distinct b.day) desc,sum(extract(epoch from (a.arrival_time-b.slot))) desc,s.name;
end;
$$;
revoke all on function public.arrival_delay_summary(date,date) from public,anon,authenticated;
grant execute on function public.arrival_delay_summary(date,date) to authenticated;

create or replace function public.arrival_delay_details(p_from date,p_to date,p_supplier_id bigint)
returns table(day date,slot time without time zone,arrival_time time without time zone,delay_minutes integer)
language plpgsql security definer set search_path = ''
as $$
declare requester public.profiles%rowtype;
begin
  select * into requester from public.profiles where id=(select auth.uid());
  if requester.id is null or requester.status<>'active' or requester.role not in ('admin','commercial','cd') then
    raise exception 'Sem permissão para consultar atrasos.';
  end if;
  if p_from is null or p_to is null or p_from>p_to or p_supplier_id is null then
    raise exception 'Informe um período e fornecedor válidos.';
  end if;
  return query
    select b.day,b.slot,a.arrival_time,
      (extract(epoch from (a.arrival_time-b.slot))/60)::integer
    from public.bookings b
    join public.booking_arrivals a on a.booking_id=b.id
    where b.supplier_id=p_supplier_id and b.status='active'
      and b.day between p_from and p_to and a.arrival_time>b.slot
    order by b.day desc,b.slot,b.id;
end;
$$;
revoke all on function public.arrival_delay_details(date,date,bigint) from public,anon,authenticated;
grant execute on function public.arrival_delay_details(date,date,bigint) to authenticated;
