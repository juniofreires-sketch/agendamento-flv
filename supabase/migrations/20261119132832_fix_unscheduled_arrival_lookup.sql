-- Qualify profile columns: the RETURNS TABLE columns are also PL/pgSQL variables.
create or replace function public.list_unscheduled_arrivals(p_day date)
returns table(id bigint,day date,supplier_id bigint,supplier_name text,arrival_time time without time zone,created_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
declare requester public.profiles%rowtype;
begin
  select p.* into requester from public.profiles p where p.id=(select auth.uid());
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
