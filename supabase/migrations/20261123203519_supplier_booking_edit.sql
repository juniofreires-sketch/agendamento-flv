-- Keep the cancellation and CD transitions intact while allowing only the
-- validated supplier edit function to change booking details.
create or replace function private.cancel_booking_guard()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if old.user_id is not null and new.user_id is null
     and (to_jsonb(new) - 'user_id') = (to_jsonb(old) - 'user_id') then
    return new;
  end if;
  if old.status='active' and new.status='active'
     and (to_jsonb(new) - 'day' - 'slot' - 'order_number' - 'invoice_number'
       - 'weight_kg' - 'item_count' - 'box_count' - 'vehicle_type' - 'cargo_type')
       = (to_jsonb(old) - 'day' - 'slot' - 'order_number' - 'invoice_number'
       - 'weight_kg' - 'item_count' - 'box_count' - 'vehicle_type' - 'cargo_type') then
    if current_user <> 'postgres' or not exists (
      select 1 from public.profiles p where p.id=(select auth.uid())
        and p.status='active' and p.role='supplier' and p.supplier_id=old.supplier_id
    ) then
      raise exception 'Apenas o fornecedor vinculado pode editar este agendamento.';
    end if;
    return new;
  end if;
  if old.status='no_show' and new.status='active' then
    if not exists (select 1 from public.profiles p where p.id=(select auth.uid())
      and p.status='active' and p.role in ('admin','cd')) then
      raise exception 'Apenas CD e administradores podem estornar No show.';
    end if;
    if exists (select 1 from public.booking_arrivals a where a.booking_id=old.id) then
      raise exception 'Este fornecedor já possui horário de chegada registrado.';
    end if;
    if (to_jsonb(new)-'status'-'no_show_at') is distinct from
       (to_jsonb(old)-'status'-'no_show_at') then
      raise exception 'Apenas o status No show pode ser estornado.';
    end if;
    new.no_show_at := null;
    return new;
  end if;
  if old.status='active' and new.status='no_show' then
    if not exists (select 1 from public.profiles p where p.id=(select auth.uid())
      and p.status='active' and p.role in ('admin','cd')) then
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
    if (to_jsonb(new)-'status'-'no_show_at') is distinct from
       (to_jsonb(old)-'status'-'no_show_at') then
      raise exception 'Apenas o status No show pode ser alterado.';
    end if;
    new.no_show_at := now();
    return new;
  end if;
  if old.status <> 'active' or new.status <> 'cancelled' then
    raise exception 'Este agendamento não pode ser cancelado.';
  end if;
  if (to_jsonb(new)-'status'-'cancelled_at') is distinct from
     (to_jsonb(old)-'status'-'cancelled_at') then
    raise exception 'Apenas o cancelamento é permitido.';
  end if;
  new.cancelled_at := now();
  return new;
end;
$$;
revoke all on function private.cancel_booking_guard() from public,anon,authenticated;

create or replace function public.supplier_booking_edit_slots(p_booking_id bigint, p_day date)
returns table(slot time without time zone) language plpgsql security definer set search_path = ''
as $$
declare
  booking public.bookings%rowtype;
  config public.scheduling_settings%rowtype;
  local_day date := (now() at time zone 'America/Sao_Paulo')::date;
  local_time time := (now() at time zone 'America/Sao_Paulo')::time;
begin
  select b.* into booking from public.bookings b where b.id=p_booking_id;
  if booking.id is null or booking.status <> 'active' or booking.day < local_day
     or not exists (select 1 from public.profiles p where p.id=(select auth.uid())
       and p.status='active' and p.role='supplier' and p.supplier_id=booking.supplier_id) then
    raise exception 'Este agendamento não pode ser editado por este usuário.';
  end if;
  if p_day is null or p_day < local_day or extract(dow from p_day)=0
     or (p_day=local_day and booking.day<>local_day) then
    raise exception 'Escolha uma data disponível para edição.';
  end if;
  if p_day<>booking.day and exists(select 1 from public.blocked_booking_days where day=p_day) then
    return;
  end if;
  select * into config from public.scheduling_settings where id=1;
  if p_day<>booking.day and (select count(*) from public.bookings b where b.day=p_day and b.status='active')>=config.daily_vehicle_limit then return; end if;
  return query
    select candidate.available_slot from (
      select booking.slot as available_slot
      union
      select (config.start_time + pg_catalog.make_interval(mins => slot_range.slot_index * config.interval_minutes))::time as available_slot
      from pg_catalog.generate_series(0, floor(extract(epoch from (config.end_time-config.start_time))/(config.interval_minutes*60))::integer) as slot_range(slot_index)
    ) candidate
    where (p_day>local_day or candidate.available_slot>=local_time or (p_day=booking.day and candidate.available_slot=booking.slot))
      and ((p_day=booking.day and candidate.available_slot=booking.slot)
        or (select count(*) from public.bookings b where b.day=p_day and b.slot=candidate.available_slot and b.status='active' and b.id<>booking.id)<config.vehicles_per_slot)
    order by candidate.available_slot;
end;
$$;
revoke all on function public.supplier_booking_edit_slots(bigint,date) from public,anon,authenticated;
grant execute on function public.supplier_booking_edit_slots(bigint,date) to authenticated;

create or replace function public.supplier_edit_booking(
  p_booking_id bigint, p_day date, p_slot time without time zone,
  p_order_number text, p_invoice_number text, p_weight_kg numeric,
  p_item_count integer, p_box_count integer, p_vehicle_type text, p_cargo_type text
)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  booking public.bookings%rowtype;
  locked_booking public.bookings%rowtype;
  config public.scheduling_settings%rowtype;
  local_day date := (now() at time zone 'America/Sao_Paulo')::date;
  local_time time := (now() at time zone 'America/Sao_Paulo')::time;
begin
  if p_booking_id is null or p_day is null then raise exception 'Informe o agendamento e a data.'; end if;
  select b.* into booking from public.bookings b where b.id=p_booking_id;
  if booking.id is null or booking.status<>'active' or booking.day<local_day
     or not exists (select 1 from public.profiles p where p.id=(select auth.uid())
       and p.status='active' and p.role='supplier' and p.supplier_id=booking.supplier_id) then
    raise exception 'Este agendamento não pode ser editado por este usuário.';
  end if;
  if p_day<local_day or extract(dow from p_day)=0 or (p_day=local_day and booking.day<>local_day) then
    raise exception 'Agendamentos anteriores, domingos e novas entregas para hoje não podem ser selecionados.';
  end if;
  if p_weight_kg is null or p_weight_kg<=0 or p_item_count is null or p_item_count<0
     or p_box_count is null or p_box_count<0 then
    raise exception 'Informe peso positivo e quantidades inteiras maiores ou iguais a zero.';
  end if;
  if p_vehicle_type is null or p_vehicle_type<>all(array['3/4','BITREM','CARRETA 24','CARRETA 26','CARRETA 28','CARRETA 30','FIORINO','TOCO','TRUCK','VUC']) then
    raise exception 'Selecione um tipo de veículo válido.';
  end if;
  if p_cargo_type is null or p_cargo_type<>any(array['Batida / Paletizada','Carga batida','Paletizada','Pallet sobreposto']) then
    raise exception 'Selecione um tipo de carga válido.';
  end if;
  if char_length(coalesce(p_order_number,''))>80 or char_length(coalesce(p_invoice_number,''))>80 then
    raise exception 'Número do pedido ou nota fiscal muito longo.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(414950, (p_day-date '2000-01-01')::integer);
  select b.* into locked_booking from public.bookings b where b.id=p_booking_id for update;
  if locked_booking.id is null or locked_booking.status<>'active' or locked_booking.day<>booking.day
     or locked_booking.day<local_day then
    raise exception 'Este agendamento mudou. Atualize a página e tente novamente.';
  end if;
  if exists (select 1 from public.booking_arrivals a where a.booking_id=p_booking_id) then
    raise exception 'A chegada já foi registrada para este agendamento.';
  end if;
  if p_day<>locked_booking.day and exists (select 1 from public.blocked_booking_days where day=p_day) then
    raise exception 'Os agendamentos para esta data estão bloqueados.';
  end if;
  select * into config from public.scheduling_settings where id=1 for share;
  if p_slot is null or ((p_day,p_slot) is distinct from (locked_booking.day,locked_booking.slot) and not exists (
    select 1 from pg_catalog.generate_series(0, floor(extract(epoch from (config.end_time-config.start_time))/(config.interval_minutes*60))::integer) as slot_range(slot_index)
    where (config.start_time+pg_catalog.make_interval(mins=>slot_range.slot_index*config.interval_minutes))::time=p_slot
  )) then raise exception 'Selecione um horário válido para esta data.'; end if;
  if p_day=local_day and p_slot<>locked_booking.slot and p_slot<local_time then
    raise exception 'Selecione um horário de hoje que ainda não passou.';
  end if;
  if p_day<>locked_booking.day and (select count(*) from public.bookings b where b.day=p_day and b.status='active')>=config.daily_vehicle_limit then
    raise exception 'O limite de veículos para esta data foi atingido.';
  end if;
  if (p_day,p_slot) is distinct from (locked_booking.day,locked_booking.slot)
     and (select count(*) from public.bookings b where b.day=p_day and b.slot=p_slot and b.status='active' and b.id<>p_booking_id)>=config.vehicles_per_slot then
    raise exception 'O horário selecionado acabou de ser preenchido.';
  end if;
  update public.bookings set day=p_day, slot=p_slot,
    order_number=nullif(trim(p_order_number),''), invoice_number=nullif(trim(p_invoice_number),''),
    weight_kg=p_weight_kg, item_count=p_item_count, box_count=p_box_count,
    vehicle_type=p_vehicle_type, cargo_type=p_cargo_type
  where id=p_booking_id;
end;
$$;
revoke all on function public.supplier_edit_booking(bigint,date,time without time zone,text,text,numeric,integer,integer,text,text) from public,anon,authenticated;
grant execute on function public.supplier_edit_booking(bigint,date,time without time zone,text,text,numeric,integer,integer,text,text) to authenticated;
