alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings add constraint bookings_status_check
  check (status in ('active','cancelled','no_show'));
alter table public.bookings add column if not exists no_show_at timestamptz;

create or replace function private.cancel_booking_guard()
returns trigger language plpgsql set search_path = ''
as $$
begin
  -- Account deletion detaches its author without deleting the booking.
  if old.user_id is not null and new.user_id is null
     and (to_jsonb(new) - 'user_id') = (to_jsonb(old) - 'user_id') then
    return new;
  end if;
  if old.status = 'active' and new.status = 'no_show' then
    if not (select private.is_admin()) then
      raise exception 'Only administrators can mark a booking as No show.';
    end if;
    if (to_jsonb(new) - 'status' - 'no_show_at') is distinct from
       (to_jsonb(old) - 'status' - 'no_show_at') then
      raise exception 'Only the No show status can be changed.';
    end if;
    new.no_show_at := now();
    return new;
  end if;
  if old.status <> 'active' or new.status <> 'cancelled' then
    raise exception 'This booking cannot be cancelled.';
  end if;
  if (to_jsonb(new) - 'status' - 'cancelled_at') is distinct from
     (to_jsonb(old) - 'status' - 'cancelled_at') then
    raise exception 'Only the cancellation status can be changed.';
  end if;
  new.cancelled_at := now();
  return new;
end;
$$;

create or replace function public.admin_mark_booking_no_show(p_booking_id bigint)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  booking_day date;
  booking_status text;
begin
  if (select auth.uid()) is null or not (select private.is_admin()) then
    raise exception 'Only administrators can mark a booking as No show.';
  end if;
  select b.day,b.status into booking_day,booking_status
  from public.bookings b where b.id=p_booking_id for update;
  if not found then raise exception 'Booking not found.'; end if;
  if booking_status <> 'active' then raise exception 'Only confirmed bookings can be marked as No show.'; end if;
  if booking_day > ((now() at time zone 'America/Sao_Paulo')::date) then
    raise exception 'No show can only be recorded on or after the booking date.';
  end if;
  update public.bookings set status='no_show' where id=p_booking_id;
end;
$$;
revoke all on function public.admin_mark_booking_no_show(bigint) from public, anon, authenticated;
grant execute on function public.admin_mark_booking_no_show(bigint) to authenticated;

create or replace function public.dashboard_daily_supplier_summary(p_from date,p_to date)
returns table(day date,supplier_id bigint,supplier_name text,appointment_count bigint,slots text)
language plpgsql security definer set search_path = ''
as $$
declare
  requester public.profiles%rowtype;
begin
  select * into requester from public.profiles p where p.id=(select auth.uid());
  if requester.id is null or requester.status<>'active' or requester.role not in ('admin','commercial') then
    raise exception 'No permission to access this dashboard.';
  end if;
  if p_from is null or p_to is null or p_from>p_to then raise exception 'Invalid date range.'; end if;
  return query
    select b.day,b.supplier_id,s.name,count(*)::bigint,
      pg_catalog.string_agg(pg_catalog.to_char(b.slot,'HH24:MI'),', ' order by b.slot)
    from public.bookings b join public.suppliers s on s.id=b.supplier_id
    where b.day between p_from and p_to and b.status='active'
    group by b.day,b.supplier_id,s.name
    order by b.day,s.name;
end;
$$;
revoke all on function public.dashboard_daily_supplier_summary(date,date) from public, anon, authenticated;
grant execute on function public.dashboard_daily_supplier_summary(date,date) to authenticated;
