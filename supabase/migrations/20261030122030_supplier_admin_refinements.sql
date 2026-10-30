alter table public.profiles
  add column if not exists requested_supplier_name text
  check (requested_supplier_name is null or char_length(requested_supplier_name) between 3 and 160);

alter table public.bookings alter column user_id drop not null;
alter table public.bookings drop constraint if exists bookings_user_id_fkey;
alter table public.bookings add constraint bookings_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;

create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  supplier_text text := new.raw_user_meta_data ->> 'supplier_id';
  selected_supplier bigint;
  requested_name text := nullif(trim(regexp_replace(coalesce(new.raw_user_meta_data ->> 'supplier_name', ''), '\s+', ' ', 'g')), '');
  display_name text := trim(coalesce(new.raw_user_meta_data ->> 'name', ''));
begin
  if lower(new.email) = 'junior.matheus64@gmail.com' then
    if coalesce(new.raw_app_meta_data ->> 'flv_admin_bootstrap', '') <> 'true' then
      raise exception 'O cadastro administrativo e feito pela equipe do portal.';
    end if;
    if char_length(display_name) < 2 or char_length(display_name) > 120 then
      raise exception 'Informe seu nome com 2 a 120 caracteres.';
    end if;
    insert into public.profiles(id,name,email,supplier_id,role,status)
    values(new.id,display_name,lower(new.email),null,'admin','active');
    return new;
  end if;
  if supplier_text ~ '^[0-9]+$' then selected_supplier := supplier_text::bigint; end if;
  if selected_supplier is not null and not exists (select 1 from public.suppliers where id=selected_supplier) then
    raise exception 'Selecione um fornecedor válido.';
  end if;
  if selected_supplier is null and (requested_name is null or char_length(requested_name) not between 3 and 160) then
    raise exception 'Selecione ou informe um fornecedor válido.';
  end if;
  if char_length(display_name) < 2 or char_length(display_name) > 120 then
    raise exception 'Informe seu nome com 2 a 120 caracteres.';
  end if;
  insert into public.profiles(id,name,email,supplier_id,requested_supplier_name,role,status)
  values(new.id,display_name,lower(new.email),selected_supplier,
    case when selected_supplier is null then requested_name else null end,'supplier','pending');
  return new;
end;
$$;

create or replace function private.assign_requested_supplier()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  requested_name text;
  linked_supplier bigint;
begin
  if old.status = 'pending' and new.status = 'active' and old.role = 'supplier' then
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
revoke all on function private.assign_requested_supplier() from public, anon, authenticated;
drop trigger if exists assign_requested_supplier on public.profiles;
create trigger assign_requested_supplier before update of status on public.profiles
  for each row execute function private.assign_requested_supplier();

alter table public.profiles drop constraint if exists supplier_profile_requires_supplier;
alter table public.profiles add constraint supplier_profile_requires_supplier
  check (role = 'admin' or status = 'pending' or supplier_id is not null);

create or replace function public.admin_delete_supplier_user(p_user_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not (select private.is_admin()) then
    raise exception 'Apenas administradores podem excluir usuários.';
  end if;
  if p_user_id is null or p_user_id = (select auth.uid()) then
    raise exception 'Este usuário não pode ser excluído.';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id and role = 'supplier') then
    raise exception 'Fornecedor não encontrado.';
  end if;
  delete from auth.users where id = p_user_id;
  if not found then raise exception 'Usuário não encontrado.'; end if;
end;
$$;
revoke all on function public.admin_delete_supplier_user(uuid) from public, anon, authenticated;
grant execute on function public.admin_delete_supplier_user(uuid) to authenticated;
