create or replace function private.cancel_booking_guard()
returns trigger language plpgsql set search_path = ''
as $$
begin
  -- A exclusão da conta desvincula o autor sem apagar a entrega.
  if old.user_id is not null and new.user_id is null
     and (to_jsonb(new) - 'user_id') = (to_jsonb(old) - 'user_id') then
    return new;
  end if;
  if old.status <> 'active' or new.status <> 'cancelled' then
    raise exception 'Este agendamento não pode ser cancelado.';
  end if;
  if (to_jsonb(new) - 'status' - 'cancelled_at') is distinct from
     (to_jsonb(old) - 'status' - 'cancelled_at') then
    raise exception 'Apenas o cancelamento é permitido.';
  end if;
  new.cancelled_at := now();
  return new;
end;
$$;
