-- Apply the new FLV schedule and let suppliers choose from open slots.
update public.scheduling_settings
set start_time=time '05:00',
    end_time=time '09:00',
    interval_minutes=30,
    vehicles_per_slot=9,
    daily_vehicle_limit=81,
    updated_at=now()
where id=1;

create or replace function private.assign_booking()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  requester public.profiles%rowtype;
  config public.scheduling_settings%rowtype;
  local_day date := (now() at time zone 'America/Sao_Paulo')::date;
  selected_slot time;
  daily_count integer;
  slot_count integer;
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
  if requester.role <> 'admin' then
    new.supplier_id := requester.supplier_id;
  end if;
  if new.supplier_id is null or not exists(select 1 from public.suppliers where id=new.supplier_id) then
    raise exception 'Selecione um fornecedor válido.';
  end if;
  if new.day <= local_day or extract(dow from new.day)=0 then
    raise exception 'Os agendamentos estão disponíveis de segunda a sábado, somente a partir do dia seguinte. Para entregas fora da janela, entre em contato com o setor comercial.';
  end if;

  -- One lock per day prevents concurrent bookings from exceeding daily or slot capacity.
  perform pg_catalog.pg_advisory_xact_lock(414950, (new.day - date '2000-01-01')::integer);
  select count(*) into daily_count from public.bookings b where b.day=new.day and b.status='active';
  if daily_count >= config.daily_vehicle_limit then
    raise exception 'O limite de % veículos para esta data foi atingido. Escolha outro dia ou entre em contato com o setor comercial.',config.daily_vehicle_limit;
  end if;

  selected_slot := new.slot;
  if selected_slot is null or not exists (
    select 1
    from pg_catalog.generate_series(0, floor(extract(epoch from (config.end_time-config.start_time))/(config.interval_minutes*60))::integer) as slot_range(slot_index)
    where (config.start_time + pg_catalog.make_interval(mins => slot_range.slot_index * config.interval_minutes))::time=selected_slot
  ) then
    raise exception 'Selecione um horário válido para esta data.';
  end if;
  select count(*) into slot_count from public.bookings b where b.day=new.day and b.slot=selected_slot and b.status='active';
  if slot_count >= config.vehicles_per_slot then
    raise exception 'O horário selecionado acabou de ser preenchido. Atualize a disponibilidade e escolha outro horário.';
  end if;
  new.slot := selected_slot;
  new.user_id := (select auth.uid());
  new.status := 'active';
  new.cancelled_at := null;
  return new;
end;
$$;
revoke all on function private.assign_booking() from public, anon, authenticated;

create or replace function public.available_booking_slots(p_day date)
returns table(slot time without time zone) language plpgsql security definer set search_path = ''
as $$
declare
  requester public.profiles%rowtype;
  config public.scheduling_settings%rowtype;
  local_day date := (now() at time zone 'America/Sao_Paulo')::date;
  daily_count integer;
begin
  if (select auth.uid()) is null then raise exception 'Faça login para consultar horários.'; end if;
  select * into requester from public.profiles where id=(select auth.uid());
  if requester.id is null or requester.status <> 'active' then
    raise exception 'Seu cadastro precisa estar aprovado para consultar horários.';
  end if;
  if requester.role not in ('admin','supplier') then
    raise exception 'Este perfil não pode consultar horários de agendamento.';
  end if;
  if p_day is null or p_day <= local_day or extract(dow from p_day)=0 then
    raise exception 'Escolha uma data disponível a partir de amanhã. Domingos não recebem agendamentos.';
  end if;
  select * into config from public.scheduling_settings where id=1;
  select count(*) into daily_count from public.bookings b where b.day=p_day and b.status='active';
  if daily_count >= config.daily_vehicle_limit then return; end if;
  return query
    select candidate.available_slot
    from (
      select (config.start_time + pg_catalog.make_interval(mins => slot_range.slot_index * config.interval_minutes))::time as available_slot
      from pg_catalog.generate_series(0, floor(extract(epoch from (config.end_time-config.start_time))/(config.interval_minutes*60))::integer) as slot_range(slot_index)
    ) candidate
    where (select count(*) from public.bookings b where b.day=p_day and b.slot=candidate.available_slot and b.status='active') < config.vehicles_per_slot
    order by candidate.available_slot;
end;
$$;
revoke all on function public.available_booking_slots(date) from public, anon, authenticated;
grant execute on function public.available_booking_slots(date) to authenticated;
