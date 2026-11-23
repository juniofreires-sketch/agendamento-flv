-- Suppliers may change or cancel an active booking only before its delivery day.
-- This also covers direct Data API updates and the supplier edit RPC.
create or replace function private.supplier_future_booking_guard()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if old.status = 'active' and new.status in ('active','cancelled')
     and old.day <= (now() at time zone 'America/Sao_Paulo')::date
     and exists (
       select 1 from public.profiles p
       where p.id = (select auth.uid()) and p.role = 'supplier'
     ) then
    raise exception 'Fornecedores só podem editar ou cancelar agendamentos futuros.';
  end if;
  return new;
end;
$$;
revoke all on function private.supplier_future_booking_guard() from public,anon,authenticated;
drop trigger if exists supplier_future_booking_guard on public.bookings;
create trigger supplier_future_booking_guard
  before update on public.bookings for each row
  execute function private.supplier_future_booking_guard();
