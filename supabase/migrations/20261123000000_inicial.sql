-- El Millón: esquema inicial.
--
-- Todo el dinero se mueve dentro de la base: el navegador solo lee las tablas
-- y llama dos RPC (`crear_jugador` y `apostar`). El resultado de cada apuesta
-- lo sortea el servidor con bytes criptográficos (`azar`), nunca el navegador.

create extension if not exists pgcrypto with schema extensions;

-- ── Tablas ────────────────────────────────────────────────────────────────

create table public.jugadores (
  id         uuid primary key default gen_random_uuid(),
  nombre     text not null,
  saldo      numeric(30,2) not null default 1000000,
  apuestas   integer not null default 0,
  creado_en  timestamptz not null default now(),
  constraint jugadores_nombre_chk check (
    nombre = btrim(nombre)
    and char_length(nombre) between 2 and 20
    and nombre !~ '[[:cntrl:]<>]'
  ),
  constraint jugadores_saldo_chk check (saldo >= 0)
);
create unique index jugadores_nombre_uq on public.jugadores (lower(nombre));
create index jugadores_saldo_idx on public.jugadores (saldo desc);

-- La llave secreta de cada jugador (solo su hash). Nadie la lee por la API.
create table public.jugador_llaves (
  jugador_id  uuid primary key references public.jugadores(id) on delete cascade,
  llave_hash  bytea not null
);

create table public.apuestas (
  id          bigint generated always as identity primary key,
  jugador_id  uuid not null references public.jugadores(id) on delete cascade,
  juego       text not null,
  eleccion    smallint not null,
  resultado   smallint not null,
  monto       numeric(30,2) not null,
  neto        numeric(30,2) not null,
  creado_en   timestamptz not null default now(),
  constraint apuestas_juego_chk check (juego in ('moneda', 'caballos', 'copas')),
  constraint apuestas_monto_chk check (monto > 0)
);
create index apuestas_jugador_idx on public.apuestas (jugador_id, id desc);

-- Acumulado de la casa por juego: lo que pintan las estadísticas.
create table public.casa_juegos (
  juego          text primary key,
  apuestas       bigint not null default 0,
  apostado       numeric(30,2) not null default 0,
  ganancia_casa  numeric(30,2) not null default 0,
  constraint casa_juegos_juego_chk check (juego in ('moneda', 'caballos', 'copas'))
);
insert into public.casa_juegos (juego) values ('moneda'), ('caballos'), ('copas');

-- ── RLS y privilegios: todos leen, nadie escribe salvo las RPC ─────────────

alter table public.jugadores      enable row level security;
alter table public.jugador_llaves enable row level security;
alter table public.apuestas       enable row level security;
alter table public.casa_juegos    enable row level security;

create policy jugadores_leer   on public.jugadores   for select to anon, authenticated using (true);
create policy apuestas_leer    on public.apuestas    for select to anon, authenticated using (true);
create policy casa_juegos_leer on public.casa_juegos for select to anon, authenticated using (true);
-- jugador_llaves: sin políticas, nadie la lee.

revoke all on public.jugadores, public.jugador_llaves, public.apuestas, public.casa_juegos
  from public, anon, authenticated;
grant usage on schema public to anon, authenticated;
grant select on public.jugadores, public.apuestas, public.casa_juegos to anon, authenticated;

-- ── Azar ──────────────────────────────────────────────────────────────────

-- Entero uniforme en 0..n-1 a partir de bytes criptográficos. El muestreo por
-- rechazo quita el sesgo del módulo (para n = 3 se descarta el byte 255).
create function public.azar(n integer) returns integer
language plpgsql volatile
set search_path = ''
as $$
declare
  limite integer;
  b integer;
begin
  if n is null or n < 1 or n > 256 then
    raise exception 'azar: n fuera de rango';
  end if;
  limite := 256 - (256 % n);
  loop
    b := get_byte(extensions.gen_random_bytes(1), 0);
    exit when b < limite;
  end loop;
  return b % n;
end
$$;
revoke execute on function public.azar(integer) from public, anon, authenticated;

-- ── RPC ───────────────────────────────────────────────────────────────────

-- Alta de jugador: solo el nombre. Regresa la llave secreta, que el navegador
-- guarda y presenta en cada apuesta.
create function public.crear_jugador(p_nombre text) returns json
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_nombre text := btrim(regexp_replace(coalesce(p_nombre, ''), '\s+', ' ', 'g'));
  v_id     uuid;
  v_llave  uuid := gen_random_uuid();
begin
  if char_length(v_nombre) < 2 or char_length(v_nombre) > 20 then
    raise exception 'El nombre debe tener entre 2 y 20 caracteres';
  end if;
  if v_nombre ~ '[[:cntrl:]<>]' then
    raise exception 'El nombre tiene caracteres que no se permiten';
  end if;
  begin
    insert into public.jugadores (nombre) values (v_nombre) returning id into v_id;
  exception when unique_violation then
    raise exception 'Ese nombre ya está tomado, elige otro';
  end;
  insert into public.jugador_llaves (jugador_id, llave_hash)
  values (v_id, sha256(convert_to(v_llave::text, 'UTF8')));
  return json_build_object('id', v_id, 'llave', v_llave, 'nombre', v_nombre, 'saldo', 1000000);
end
$$;
revoke execute on function public.crear_jugador(text) from public;
grant execute on function public.crear_jugador(text) to anon, authenticated;

-- Una apuesta. Si gana, el jugador conserva lo apostado y recibe además
-- monto × factor (moneda 0.9, caballos 2.7, copas 1.8); si pierde, pierde lo
-- apostado. La elección va de 0 a opciones-1.
create function public.apostar(
  p_jugador  uuid,
  p_llave    uuid,
  p_juego    text,
  p_eleccion integer,
  p_monto    numeric
) returns json
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_opciones  integer;
  v_factor    numeric;
  v_saldo     numeric;
  v_resultado integer;
  v_gano      boolean;
  v_neto      numeric;
begin
  if p_juego = 'moneda' then
    v_opciones := 2; v_factor := 0.9;
  elsif p_juego = 'caballos' then
    v_opciones := 4; v_factor := 2.7;
  elsif p_juego = 'copas' then
    v_opciones := 3; v_factor := 1.8;
  else
    raise exception 'Juego desconocido';
  end if;

  if p_eleccion is null or p_eleccion < 0 or p_eleccion >= v_opciones then
    raise exception 'Elección inválida';
  end if;
  if p_monto is null or p_monto = 'NaN'::numeric or p_monto <= 0
     or p_monto <> round(p_monto, 2) then
    raise exception 'El monto debe ser mayor a cero, con dos decimales como máximo';
  end if;

  select j.saldo into v_saldo
    from public.jugadores j
    join public.jugador_llaves l on l.jugador_id = j.id
   where j.id = p_jugador
     and l.llave_hash = sha256(convert_to(p_llave::text, 'UTF8'))
     for update of j;
  if not found then
    raise exception 'Jugador no reconocido';
  end if;
  if p_monto > v_saldo then
    raise exception 'No tienes saldo suficiente';
  end if;

  v_resultado := public.azar(v_opciones);
  v_gano := (v_resultado = p_eleccion);
  v_neto := case when v_gano then round(p_monto * v_factor, 2) else -p_monto end;

  update public.jugadores
     set saldo = saldo + v_neto, apuestas = apuestas + 1
   where id = p_jugador
  returning saldo into v_saldo;

  insert into public.apuestas (jugador_id, juego, eleccion, resultado, monto, neto)
  values (p_jugador, p_juego, p_eleccion, v_resultado, p_monto, v_neto);

  update public.casa_juegos
     set apuestas = apuestas + 1,
         apostado = apostado + p_monto,
         ganancia_casa = ganancia_casa - v_neto
   where juego = p_juego;

  return json_build_object(
    'resultado', v_resultado, 'gano', v_gano, 'neto', v_neto, 'saldo', v_saldo);
end
$$;
revoke execute on function public.apostar(uuid, uuid, text, integer, numeric) from public;
grant execute on function public.apostar(uuid, uuid, text, integer, numeric) to anon, authenticated;

-- ── Tiempo real ───────────────────────────────────────────────────────────

alter publication supabase_realtime
  add table public.jugadores, public.apuestas, public.casa_juegos;
