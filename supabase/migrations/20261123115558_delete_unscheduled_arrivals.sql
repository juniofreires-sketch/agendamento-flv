-- Records previously reversed to pending are not scheduled deliveries.
delete from private.unscheduled_arrivals where status='pending';

drop function public.undo_unscheduled_arrival(bigint);
drop function public.rerecord_unscheduled_arrival(bigint,bigint,time without time zone);

create function public.delete_unscheduled_arrival(p_id bigint)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.profiles p
    where p.id=(select auth.uid()) and p.status='active' and p.role in ('admin','cd')
  ) then
    raise exception 'Apenas CD e administradores podem excluir veículos fora da agenda.';
  end if;

  delete from private.unscheduled_arrivals u where u.id=p_id;
  if not found then raise exception 'Registro fora da agenda não encontrado.'; end if;
end;
$$;
revoke all on function public.delete_unscheduled_arrival(bigint) from public,anon,authenticated;
grant execute on function public.delete_unscheduled_arrival(bigint) to authenticated;
