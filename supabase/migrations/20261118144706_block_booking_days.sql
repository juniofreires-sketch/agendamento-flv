-- Operational closures apply to every supplier, including direct booking inserts.
create table public.blocked_booking_days (
  day date primary key,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.blocked_booking_days enable row level security;
revoke all on public.blocked_booking_days from public, anon, authenticated;
grant select on public.blocked_booking_days to authenticated;
create policy blocked_booking_days_read on public.blocked_booking_days
  for select to authenticated using ((select auth.uid()) is not null);

create or replace function public.admin_set_booking_day_block(p_day date, p_blocked boolean)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  local_day date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if (select auth.uid()) is null or not (select private.is_admin()) then
    raise exception 'Apenas administradores podem configurar dias bloqueados.';
  end if;
  if p_day is null or p_blocked is null then
    raise exception 'Informe uma data válida.';
  end if;
  if p_blocked and (p_day<=local_day or extract(dow from p_day)=0) then
    raise exception 'Escolha uma data futura de segunda a sábado.';
  end if;

  -- Serialize a closure with bookings for that day.
  perform pg_catalog.pg_advisory_xact_lock(414950, (p_day - date '2000-01-01')::integer);
  if p_blocked then
    insert into public.blocked_booking_days(day,created_by)
      values(p_day,(select auth.uid())) on conflict (day) do nothing;
  else
    delete from public.blocked_booking_days where day=p_day;
  end if;
end;
$$;
revoke all on function public.admin_set_booking_day_block(date,boolean) from public, anon, authenticated;
grant execute on function public.admin_set_booking_day_block(date,boolean) to authenticated;

create or replace function private.reject_blocked_booking_day()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.day is not null then
    perform pg_catalog.pg_advisory_xact_lock(414950, (new.day - date '2000-01-01')::integer);
    if exists (select 1 from public.blocked_booking_days where day=new.day) then
      raise exception 'Os agendamentos para % estão bloqueados. Escolha outra data.',
        pg_catalog.to_char(new.day,'DD/MM/YYYY');
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.reject_blocked_booking_day() from public, anon, authenticated;
create trigger reject_blocked_booking_day
  before insert on public.bookings for each row
  execute function private.reject_blocked_booking_day();

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
  if exists (select 1 from public.blocked_booking_days where day=p_day) then return; end if;
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
