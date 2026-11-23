-- Extend the existing deletion RPC to CD and Comercial while preserving
-- the booking and arrival history through the existing SET NULL foreign keys.
create or replace function public.admin_delete_supplier_user(p_user_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare target_role text;
begin
  if (select auth.uid()) is null or not (select private.is_admin()) then
    raise exception 'Apenas administradores podem excluir usuários.';
  end if;
  if p_user_id is null or p_user_id = (select auth.uid()) then
    raise exception 'Este usuário não pode ser excluído.';
  end if;

  select p.role into target_role from public.profiles p where p.id=p_user_id for update;
  if target_role is null then raise exception 'Usuário não encontrado.'; end if;
  if target_role not in ('supplier','cd','commercial') then
    raise exception 'Este perfil não pode ser excluído.';
  end if;

  delete from auth.users u where u.id=p_user_id;
  if not found then raise exception 'Usuário não encontrado.'; end if;
end;
$$;
revoke all on function public.admin_delete_supplier_user(uuid) from public,anon,authenticated;
grant execute on function public.admin_delete_supplier_user(uuid) to authenticated;
