-- Derive daily capacity from the configured slot window and enforce future weekdays.
alter table public.scheduling_settings
  drop constraint if exists scheduling_settings_daily_vehicle_limit_check;

update public.scheduling_settings
set daily_vehicle_limit = (
  (extract(epoch from (end_time - start_time))::integer / (interval_minutes * 60) + 1)
  * vehicles_per_slot
)
where id = 1;

alter table public.scheduling_settings
  drop constraint if exists daily_vehicle_limit_matches_window;

alter table public.scheduling_settings
  add constraint scheduling_settings_daily_vehicle_limit_check
  check (daily_vehicle_limit between 1 and 1000000),
  add constraint daily_vehicle_limit_matches_window
  check (
    daily_vehicle_limit = (
      (extract(epoch from (end_time - start_time))::integer / (interval_minutes * 60) + 1)
      * vehicles_per_slot
    )
  );

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
  if requester.role <> 'admin' then
    new.supplier_id := requester.supplier_id;
  end if;
  if new.supplier_id is null or not exists(select 1 from public.suppliers where id=new.supplier_id) then
    raise exception 'Selecione um fornecedor válido.';
  end if;
  if new.day <= local_day or extract(dow from new.day)=0 then
    raise exception 'Os agendamentos estão disponíveis de segunda a sábado, somente a partir do dia seguinte. Para entregas fora da janela, entre em contato com o setor comercial.';
  end if;

  -- One lock per delivery day serializes daily capacity and slot assignment.
  perform pg_catalog.pg_advisory_xact_lock(414950, (new.day - date '2000-01-01')::integer);
  select count(*) into daily_count from public.bookings b where b.day=new.day and b.status='active';
  if daily_count >= config.daily_vehicle_limit then
    raise exception 'O limite de % veículos para esta data foi atingido. Escolha outro dia ou entre em contato com o setor comercial.',config.daily_vehicle_limit;
  end if;
  select c.slot into selected_slot
  from (
    select (config.start_time + pg_catalog.make_interval(mins => slot_range.slot_index * config.interval_minutes))::time as slot
    from pg_catalog.generate_series(0, floor(extract(epoch from (config.end_time-config.start_time))/(config.interval_minutes*60))::integer) as slot_range(slot_index)
  ) c
  where (new.day > local_day or c.slot >= local_time)
    and (
      select count(*) from public.bookings b
      where b.day=new.day and b.slot=c.slot and b.status='active'
    ) < config.vehicles_per_slot
  order by c.slot
  limit 1;
  if selected_slot is null then
    if new.day=local_day and local_time > config.end_time then
      raise exception 'O horário de hoje terminou às %. Para entregas fora da janela, entre em contato com o setor comercial.',pg_catalog.to_char(config.end_time,'HH24:MI');
    end if;
    raise exception 'Todos os horários desta data estão completos. Escolha outro dia ou entre em contato com o setor comercial.';
  end if;
  new.slot := selected_slot;
  new.user_id := (select auth.uid());
  new.status := 'active';
  new.cancelled_at := null;
  return new;
end;
$$;
revoke all on function private.assign_booking() from public, anon, authenticated;

create or replace function public.admin_update_scheduling_settings(
  p_start_time time,
  p_end_time time,
  p_interval_minutes integer,
  p_vehicles_per_slot integer,
  p_daily_vehicle_limit integer
)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  calculated_daily_limit integer;
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
     or p_vehicles_per_slot not between 1 and 10000 then
    raise exception 'Confira os horários, o intervalo (30 ou 60 minutos) e os limites de veículos.';
  end if;
  calculated_daily_limit := (
    (extract(epoch from (p_end_time-p_start_time))::integer/(p_interval_minutes*60)+1)
    * p_vehicles_per_slot
  );
  if calculated_daily_limit not between 1 and 1000000 then
    raise exception 'O limite diário calculado está fora do intervalo permitido.';
  end if;
  update public.scheduling_settings
    set start_time=p_start_time,end_time=p_end_time,interval_minutes=p_interval_minutes,
        vehicles_per_slot=p_vehicles_per_slot,daily_vehicle_limit=calculated_daily_limit,
        updated_by=(select auth.uid()),updated_at=now()
    where id=1;
end;
$$;
revoke all on function public.admin_update_scheduling_settings(time,time,integer,integer,integer) from public, anon, authenticated;
grant execute on function public.admin_update_scheduling_settings(time,time,integer,integer,integer) to authenticated;
