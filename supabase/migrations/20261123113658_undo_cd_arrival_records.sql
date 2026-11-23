alter table private.unscheduled_arrivals
  add column status text not null default 'recorded'
  check (status in ('recorded','pending'));

-- Keep the existing booking guard, allowing only the CD/Admin status reversal.
create or replace function private.cancel_booking_guard()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if old.user_id is not null and new.user_id is null
     and (to_jsonb(new) - 'user_id') = (to_jsonb(old) - 'user_id') then
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

create or replace function public.undo_cd_booking_no_show(p_booking_id bigint)
returns void language plpgsql security definer set search_path = ''
as $$
declare booking_status text;
begin
  if not exists (select 1 from public.profiles p where p.id=(select auth.uid())
    and p.status='active' and p.role in ('admin','cd')) then
    raise exception 'Apenas CD e administradores podem estornar No show.';
  end if;
  select b.status into booking_status from public.bookings b where b.id=p_booking_id for update;
  if not found then raise exception 'Agendamento não encontrado.'; end if;
  if booking_status<>'no_show' then raise exception 'Somente registros No show podem ser estornados.'; end if;
  if exists (select 1 from public.booking_arrivals a where a.booking_id=p_booking_id) then
    raise exception 'Este fornecedor já possui horário de chegada registrado.';
  end if;
  update public.bookings b set status='active' where b.id=p_booking_id;
end;
$$;
revoke all on function public.undo_cd_booking_no_show(bigint) from public,anon,authenticated;
grant execute on function public.undo_cd_booking_no_show(bigint) to authenticated;

drop function public.list_unscheduled_arrivals(date);
create function public.list_unscheduled_arrivals(p_day date)
returns table(id bigint,day date,supplier_id bigint,supplier_name text,arrival_time time without time zone,created_at timestamptz,status text)
language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.profiles p where p.id=(select auth.uid())
    and p.status='active' and p.role in ('admin','cd')) then
    raise exception 'Apenas CD e administradores podem consultar veículos fora da agenda.';
  end if;
  if p_day is null then raise exception 'Informe a data de chegada.'; end if;
  return query
    select u.id,u.day,u.supplier_id,s.name,u.arrival_time,u.created_at,u.status
    from private.unscheduled_arrivals u join public.suppliers s on s.id=u.supplier_id
    where u.day=p_day order by u.arrival_time,s.name,u.id;
end;
$$;
revoke all on function public.list_unscheduled_arrivals(date) from public,anon,authenticated;
grant execute on function public.list_unscheduled_arrivals(date) to authenticated;

create or replace function public.undo_unscheduled_arrival(p_id bigint)
returns void language plpgsql security definer set search_path = ''
as $$
declare current_status text;
begin
  if not exists (select 1 from public.profiles p where p.id=(select auth.uid())
    and p.status='active' and p.role in ('admin','cd')) then
    raise exception 'Apenas CD e administradores podem estornar chegadas.';
  end if;
  select u.status into current_status from private.unscheduled_arrivals u where u.id=p_id for update;
  if not found then raise exception 'Registro fora da agenda não encontrado.'; end if;
  if current_status<>'recorded' then raise exception 'Este registro já está aguardando correção.'; end if;
  update private.unscheduled_arrivals u set status='pending' where u.id=p_id;
end;
$$;
revoke all on function public.undo_unscheduled_arrival(bigint) from public,anon,authenticated;
grant execute on function public.undo_unscheduled_arrival(bigint) to authenticated;

create or replace function public.rerecord_unscheduled_arrival(
  p_id bigint,p_supplier_id bigint,p_arrival_time time without time zone)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  record_day date;
  current_status text;
  local_day date := (now() at time zone 'America/Sao_Paulo')::date;
  local_time time := (now() at time zone 'America/Sao_Paulo')::time;
begin
  if not exists (select 1 from public.profiles p where p.id=(select auth.uid())
    and p.status='active' and p.role in ('admin','cd')) then
    raise exception 'Apenas CD e administradores podem refazer chegadas.';
  end if;
  select u.day,u.status into record_day,current_status
    from private.unscheduled_arrivals u where u.id=p_id for update;
  if not found then raise exception 'Registro fora da agenda não encontrado.'; end if;
  if current_status<>'pending' then raise exception 'Somente registros estornados podem ser refeitos.'; end if;
  if p_supplier_id is null or not exists(select 1 from public.suppliers s
    where s.id=p_supplier_id and s.archived_at is null) then
    raise exception 'Selecione um fornecedor disponível.';
  end if;
  if p_arrival_time is null or record_day>local_day
     or (record_day=local_day and p_arrival_time>local_time) then
    raise exception 'Informe um horário de chegada que não esteja no futuro.';
  end if;
  update private.unscheduled_arrivals u
    set supplier_id=p_supplier_id,arrival_time=p_arrival_time,status='recorded',recorded_by=(select auth.uid())
    where u.id=p_id;
end;
$$;
revoke all on function public.rerecord_unscheduled_arrival(bigint,bigint,time without time zone) from public,anon,authenticated;
grant execute on function public.rerecord_unscheduled_arrival(bigint,bigint,time without time zone) to authenticated;

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
    where u.status='recorded' and u.day between p_from and through_day
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
    where u.status='recorded' and u.day between p_from and through_day and (p_supplier_id is null or u.supplier_id=p_supplier_id)
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
