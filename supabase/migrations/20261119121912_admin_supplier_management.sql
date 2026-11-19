alter table public.suppliers
  add column if not exists created_by uuid,
  add column if not exists archived_at timestamptz;

create or replace function public.admin_create_supplier(p_name text)
returns public.suppliers language plpgsql security definer set search_path = ''
as $$
declare supplier public.suppliers%rowtype;
begin
  if (select auth.uid()) is null or not (select private.is_admin()) then
    raise exception 'Apenas administradores podem cadastrar fornecedores.';
  end if;
  p_name := btrim(regexp_replace(coalesce(p_name,''), '\s+', ' ', 'g'));
  if char_length(p_name) not between 3 and 160 then
    raise exception 'Informe a razão social com 3 a 160 caracteres.';
  end if;
  if exists(select 1 from public.suppliers where lower(name)=lower(p_name)) then
    raise exception 'Este fornecedor já está cadastrado.';
  end if;
  insert into public.suppliers(name,created_by) values (p_name,(select auth.uid())) returning * into supplier;
  return supplier;
end;
$$;
revoke all on function public.admin_create_supplier(text) from public,anon,authenticated;
grant execute on function public.admin_create_supplier(text) to authenticated;

create or replace function public.admin_update_user_role(p_user_id uuid,p_role text,p_supplier_id bigint default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare target public.profiles%rowtype;
begin
  if (select auth.uid()) is null or not (select private.is_admin()) then
    raise exception 'Apenas administradores podem alterar perfis.';
  end if;
  if p_user_id=(select auth.uid()) then
    raise exception 'Não é possível alterar o próprio perfil.';
  end if;
  if p_role is null or p_role not in ('admin','supplier','commercial','cd') then
    raise exception 'Selecione Administrador, Fornecedor, Comercial ou CD.';
  end if;
  select * into target from public.profiles where id=p_user_id for update;
  if target.id is null then raise exception 'Usuário não encontrado.'; end if;
  if target.status<>'active' then raise exception 'Altere o perfil pela aprovação pendente deste usuário.'; end if;
  if p_role='supplier' and (p_supplier_id is null or not exists(
    select 1 from public.suppliers where id=p_supplier_id and archived_at is null
  )) then
    raise exception 'Selecione um fornecedor disponível para este usuário.';
  end if;
  update public.profiles
    set role=p_role,
        supplier_id=case when p_role='supplier' then p_supplier_id else null end,
        requested_supplier_name=null
    where id=p_user_id;
end;
$$;

create or replace function public.admin_update_user_role_with_supplier(
  p_user_id uuid,p_role text,p_supplier_id bigint,p_supplier_name text)
returns void language plpgsql security definer set search_path = ''
as $$
declare supplier public.suppliers%rowtype;
begin
  if nullif(btrim(coalesce(p_supplier_name,'')),'') is not null then
    if p_role <> 'supplier' or p_supplier_id is not null then
      raise exception 'Escolha um fornecedor existente ou informe uma nova razão social.';
    end if;
    supplier := public.admin_create_supplier(p_supplier_name);
    p_supplier_id := supplier.id;
  end if;
  if p_role = 'supplier' and p_supplier_id is not null
    and not exists(select 1 from public.suppliers where id=p_supplier_id and archived_at is null) then
    raise exception 'Selecione um fornecedor disponível.';
  end if;
  perform public.admin_update_user_role(p_user_id,p_role,p_supplier_id);
end;
$$;
revoke all on function public.admin_update_user_role_with_supplier(uuid,text,bigint,text) from public,anon,authenticated;
grant execute on function public.admin_update_user_role_with_supplier(uuid,text,bigint,text) to authenticated;

create or replace function public.admin_archive_supplier(p_supplier_id bigint)
returns void language plpgsql security definer set search_path = ''
as $$
declare supplier public.suppliers%rowtype;
begin
  if (select auth.uid()) is null or not (select private.is_admin()) then
    raise exception 'Apenas administradores podem excluir fornecedores.';
  end if;
  select * into supplier from public.suppliers where id=p_supplier_id for update;
  if supplier.id is null or supplier.created_by is null or supplier.archived_at is not null then
    raise exception 'Fornecedor criado manualmente não encontrado.';
  end if;
  if exists(select 1 from public.profiles where supplier_id=p_supplier_id) then
    raise exception 'Altere o vínculo dos usuários deste fornecedor antes de excluí-lo.';
  end if;
  update public.suppliers set archived_at=now() where id=p_supplier_id;
end;
$$;
revoke all on function public.admin_archive_supplier(bigint) from public,anon,authenticated;
grant execute on function public.admin_archive_supplier(bigint) to authenticated;

create or replace function private.reject_archived_supplier()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if not exists(select 1 from public.suppliers where id=new.supplier_id and archived_at is null) then
    raise exception 'Este fornecedor não está disponível para novos agendamentos.';
  end if;
  return new;
end;
$$;
drop trigger if exists bookings_reject_archived_supplier on public.bookings;
create trigger bookings_reject_archived_supplier before insert on public.bookings
for each row execute function private.reject_archived_supplier();
