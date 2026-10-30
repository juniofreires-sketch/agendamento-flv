-- The client must submit the supplier-selected slot; the trigger still validates it.
grant insert(slot) on public.bookings to authenticated;
