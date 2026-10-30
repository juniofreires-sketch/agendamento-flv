create or replace function private.assign_requested_supplier()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  requested_name text;
  linked_supplier bigint;
begin
  if old.status = 'pending' and new.status = 'active'
     and old.role = 'supplier' and new.role = 'supplier' then
    if not (select private.is_admin()) then
      raise exception 'Apenas administradores podem aprovar cadastros.';
    end if;
    if new.supplier_id is null then
      requested_name := nullif(trim(old.requested_supplier_name), '');
      if requested_name is null then raise exception 'Fornecedor não informado.'; end if;
      insert into public.suppliers(name) values(requested_name) on conflict do nothing;
      select id into linked_supplier from public.suppliers
        where lower(name) = lower(requested_name) limit 1;
      if linked_supplier is null then raise exception 'Não foi possível vincular o fornecedor.'; end if;
      new.supplier_id := linked_supplier;
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.admin_approve_user(p_user_id uuid, p_role text)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not (select private.is_admin()) then
    raise exception 'Apenas administradores podem aprovar acessos.';
  end if;
  if p_role is null or p_role not in ('supplier','admin') then
    raise exception 'Escolha fornecedor ou administrador.';
  end if;
  if not exists (
    select 1 from public.profiles
    where id=p_user_id and role='supplier' and status='pending'
  ) then
    raise exception 'Solicitação pendente não encontrada.';
  end if;
  if p_role='admin' then
    update public.profiles
      set role='admin', status='active', supplier_id=null, requested_supplier_name=null
      where id=p_user_id;
  else
    update public.profiles set status='active'
      where id=p_user_id;
  end if;
end;
$$;
revoke all on function public.admin_approve_user(uuid,text) from public, anon, authenticated;
grant execute on function public.admin_approve_user(uuid,text) to authenticated;
