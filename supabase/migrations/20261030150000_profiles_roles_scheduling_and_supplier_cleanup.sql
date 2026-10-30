alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check check (role in ('supplier','admin','commercial'));
alter table public.profiles drop constraint if exists supplier_profile_requires_supplier;
alter table public.profiles
  add constraint supplier_profile_requires_supplier
  check (role <> 'supplier' or status='pending' or supplier_id is not null);
alter table public.profiles drop constraint if exists non_supplier_profile_has_no_supplier;
alter table public.profiles
  add constraint non_supplier_profile_has_no_supplier
  check (role='supplier' or supplier_id is null);

create table if not exists public.scheduling_settings (
  id smallint primary key default 1 check (id=1),
  start_time time not null default time '05:00',
  end_time time not null default time '10:00',
  interval_minutes integer not null default 30 check (interval_minutes in (30,60)),
  vehicles_per_slot integer not null default 5 check (vehicles_per_slot between 1 and 10000),
  daily_vehicle_limit integer not null default 55 check (daily_vehicle_limit between 1 and 10000),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint valid_scheduling_window check (
    end_time > start_time
    and mod(extract(epoch from (end_time-start_time))::integer, interval_minutes*60)=0
    and mod(extract(epoch from start_time)::integer,1800)=0
    and mod(extract(epoch from end_time)::integer,1800)=0
    and (interval_minutes=30 or (extract(minute from start_time)=0 and extract(minute from end_time)=0))
  )
);
insert into public.scheduling_settings(id) values (1) on conflict (id) do nothing;
alter table public.scheduling_settings enable row level security;
drop policy if exists scheduling_settings_read on public.scheduling_settings;
create policy scheduling_settings_read on public.scheduling_settings for select to anon,authenticated using (true);
revoke all on public.scheduling_settings from anon,authenticated;
grant select on public.scheduling_settings to anon,authenticated;

create or replace function private.assign_booking()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  requester public.profiles%rowtype;
  config public.scheduling_settings%rowtype;
  local_day date := (now() at time zone 'America/Sao_Paulo')::date;
  local_time time := (now() at time zone 'America/Sao_Paulo')::time;
  selected_slot time;
  daily_count integer;
  window_message text;
begin
  if (select auth.uid()) is null then raise exception 'Faça login para continuar.'; end if;
  select * into requester from public.profiles where id=(select auth.uid());
  if requester.id is null or requester.status <> 'active' then
    raise exception 'Seu cadastro precisa estar aprovado para agendar.';
  end if;
  if requester.role not in ('admin','supplier') then
    raise exception 'Este perfil não tem permissão para criar agendamentos.';
  end if;
  select * into config from public.scheduling_settings where id=1 for share;
  window_message := pg_catalog.format('Os agendamentos são feitos de segunda a sábado, das %s às %s. Para uma entrega fora dessa janela, entre em contato com o setor comercial.',pg_catalog.to_char(config.start_time,'HH24:MI'),pg_catalog.to_char(config.end_time,'HH24:MI'));
  if requester.role <> 'admin' then new.supplier_id := requester.supplier_id; end if;
  if new.supplier_id is null or not exists(select 1 from public.suppliers where id=new.supplier_id) then
    raise exception 'Selecione um fornecedor válido.';
  end if;
  if new.day < local_day or extract(dow from new.day)=0 then raise exception '%',window_message; end if;

  perform pg_catalog.pg_advisory_xact_lock(414950,(new.day-date '2000-01-01')::integer);
  select count(*) into daily_count from public.bookings b where b.day=new.day and b.status='active';
  if daily_count>=config.daily_vehicle_limit then
    raise exception 'O limite de % veículos para esta data foi atingido. Escolha outro dia ou entre em contato com o setor comercial.',config.daily_vehicle_limit;
  end if;
  select c.slot into selected_slot
  from (
    select (config.start_time+pg_catalog.make_interval(mins=>slot_range.slot_index*config.interval_minutes))::time as slot
    from pg_catalog.generate_series(0,floor(extract(epoch from (config.end_time-config.start_time))/(config.interval_minutes*60))::integer) as slot_range(slot_index)
  ) c
  where (new.day>local_day or c.slot>=local_time)
    and (select count(*) from public.bookings b where b.day=new.day and b.slot=c.slot and b.status='active')<config.vehicles_per_slot
  order by c.slot limit 1;
  if selected_slot is null then
    if new.day=local_day and local_time>config.end_time then
      raise exception 'O horário de hoje terminou às %. Para entregas fora da janela, entre em contato com o setor comercial.',pg_catalog.to_char(config.end_time,'HH24:MI');
    end if;
    raise exception 'Todos os horários desta data estão completos. Escolha outro dia ou entre em contato com o setor comercial.';
  end if;
  new.slot:=selected_slot;
  new.user_id:=(select auth.uid());
  new.status:='active';
  new.cancelled_at:=null;
  return new;
end;
$$;
revoke all on function private.assign_booking() from public,anon,authenticated;

create or replace function public.admin_approve_user(p_user_id uuid, p_role text)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not (select private.is_admin()) then
    raise exception 'Apenas administradores podem aprovar acessos.';
  end if;
  if p_role is null or p_role not in ('supplier','admin','commercial') then
    raise exception 'Escolha Administrador, Fornecedor ou Comercial.';
  end if;
  if not exists (
    select 1 from public.profiles
    where id=p_user_id and role='supplier' and status='pending'
  ) then
    raise exception 'Solicitação pendente não encontrada.';
  end if;
  if p_role in ('admin','commercial') then
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
  if p_role is null or p_role not in ('admin','supplier','commercial') then
    raise exception 'Selecione Administrador, Fornecedor ou Comercial.';
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

create or replace function public.admin_update_scheduling_settings(
  p_start_time time,p_end_time time,p_interval_minutes integer,
  p_vehicles_per_slot integer,p_daily_vehicle_limit integer
)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not (select private.is_admin()) then
    raise exception 'Apenas administradores podem alterar a sistemática.';
  end if;
  if p_start_time is null or p_end_time is null or p_end_time<=p_start_time
     or p_interval_minutes not in (30,60)
     or mod(extract(epoch from (p_end_time-p_start_time))::integer,p_interval_minutes*60)<>0
     or mod(extract(epoch from p_start_time)::integer,1800)<>0
     or mod(extract(epoch from p_end_time)::integer,1800)<>0
     or (p_interval_minutes=60 and (extract(minute from p_start_time)<>0 or extract(minute from p_end_time)<>0))
     or p_vehicles_per_slot not between 1 and 10000
     or p_daily_vehicle_limit not between 1 and 10000 then
    raise exception 'Confira os horários, o intervalo (30 ou 60 minutos) e os limites de veículos.';
  end if;
  update public.scheduling_settings
    set start_time=p_start_time,end_time=p_end_time,interval_minutes=p_interval_minutes,
        vehicles_per_slot=p_vehicles_per_slot,daily_vehicle_limit=p_daily_vehicle_limit,
        updated_by=(select auth.uid()),updated_at=now()
    where id=1;
end;
$$;
revoke all on function public.admin_update_scheduling_settings(time,time,integer,integer,integer) from public,anon,authenticated;
grant execute on function public.admin_update_scheduling_settings(time,time,integer,integer,integer) to authenticated;

create or replace function public.commercial_dashboard(p_from date,p_to date)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  requester public.profiles%rowtype;
  result jsonb;
begin
  select * into requester from public.profiles where id=(select auth.uid());
  if requester.id is null or requester.status<>'active' or requester.role not in ('admin','commercial') then
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

create temporary table supplier_name_cleanup on commit drop as
with normalized as (
  select id,name,
         trim(regexp_replace(name,'^[0-9][0-9./-]*[[:space:]]+','','')) as clean_name
  from public.suppliers
), targets as (
  select lower(clean_name) as key,
         coalesce(
           min(id) filter (where name=clean_name),
           min(id) filter (where name !~ '^[0-9][0-9./-]*[[:space:]]+'),
           min(id)
         ) as target_id
  from normalized group by lower(clean_name)
)
select n.id as source_id,t.target_id,n.clean_name
from normalized n join targets t on t.key=lower(n.clean_name)
where n.name<>n.clean_name;

update public.profiles p set supplier_id=m.target_id
from supplier_name_cleanup m where p.supplier_id=m.source_id and m.source_id<>m.target_id;
update public.bookings b set supplier_id=m.target_id
from supplier_name_cleanup m where b.supplier_id=m.source_id and m.source_id<>m.target_id;
delete from public.suppliers s using supplier_name_cleanup m
where s.id=m.source_id and m.source_id<>m.target_id;
update public.suppliers s set name=m.clean_name
from supplier_name_cleanup m where s.id=m.target_id and s.name<>m.clean_name;
