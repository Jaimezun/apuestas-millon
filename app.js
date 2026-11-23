// El Millón. La página solo presenta: el resultado de cada apuesta lo sortea
// la base (RPC `apostar`) y las animaciones se limitan a mostrarlo.
(() => {
  'use strict';

  const INICIAL = 1000000;
  const JUEGOS = {
    moneda: { nombre: 'Moneda', factor: 0.9, opciones: 2 },
    caballos: { nombre: 'Caballos', factor: 2.7, opciones: 4 },
    copas: { nombre: 'Copas', factor: 1.8, opciones: 3 },
  };
  // Lo que la casa se queda en promedio de cada peso apostado: 1 menos lo
  // que regresa (apuesta + premio) por la probabilidad de acertar.
  const ventaja = (juego) => 1 - (1 + JUEGOS[juego].factor) / JUEGOS[juego].opciones;
  const CABALLOS = ['Relámpago', 'Tormenta', 'Canelo', 'Lucero'];
  const LUGAR_COPA = ['la copa izquierda', 'la copa de en medio', 'la copa derecha'];
  const ROTULO_COPA = ['Copa izquierda', 'Copa de en medio', 'Copa derecha'];
  const X_COPA = ['18%', '50%', '82%'];
  const LLAVE_SESION = 'millon.jugador';
  const MAX_RECIENTES = 10;

  const $ = (id) => document.getElementById(id);
  const todos = (sel) => Array.from(document.querySelectorAll(sel));
  const SIN_MOVIMIENTO = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const dormir = (ms) => new Promise((r) => setTimeout(r, SIN_MOVIMIENTO ? Math.min(ms, 120) : ms));

  const db = window.supabase.createClient(window.MILLON_CONFIG.url, window.MILLON_CONFIG.llave, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  // ── Dinero ──────────────────────────────────────────────────────────────

  const formato = new Intl.NumberFormat('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const dinero = (n) => (n < 0 ? '−$' : '$') + formato.format(Math.abs(n));
  const conSigno = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + '$' + formato.format(Math.abs(n));
  const claseSigno = (n) => (n > 0.004 ? 'sube' : n < -0.004 ? 'baja' : 'igual');
  const centavos = (n) => Math.round(n * 100) / 100;

  // ── Estado ──────────────────────────────────────────────────────────────

  let sesion = leerSesion(); // { id, llave, nombre } o null
  const jugadores = new Map(); // id → { id, nombre, saldo, apuestas }
  const casa = new Map(); // juego → { apuestas, apostado, ganancia_casa }
  let recientes = []; // últimas apuestas, la más nueva primero
  let juegoActivo = 'moneda';
  const eleccion = { moneda: 0, caballos: 0 };
  let ocupado = false; // hay una ronda en curso: controles bloqueados
  let cola = null; // eventos de tiempo real retenidos hasta que acabe la animación
  let faseCopas = 'listo'; // listo → revolviendo → eligiendo → resolviendo
  let giro = 0;
  let pintadoPendiente = false;
  let notaError = null; // aviso sobre el monto

  function leerSesion() {
    try {
      const s = JSON.parse(localStorage.getItem(LLAVE_SESION) || 'null');
      return s && s.id && s.llave ? s : null;
    } catch (_) {
      return null;
    }
  }
  function guardarSesion(s) {
    sesion = s;
    try {
      if (s) localStorage.setItem(LLAVE_SESION, JSON.stringify(s));
      else localStorage.removeItem(LLAVE_SESION);
    } catch (_) { /* sin almacenamiento: la sesión dura lo que la pestaña */ }
  }
  const yo = () => (sesion ? jugadores.get(sesion.id) : null);
  const miSaldo = () => (yo() ? yo().saldo : 0);

  // ── Datos ───────────────────────────────────────────────────────────────

  const filaJugador = (r) => ({ id: r.id, nombre: r.nombre, saldo: Number(r.saldo), apuestas: Number(r.apuestas) });
  const filaCasa = (r) => ({ apuestas: Number(r.apuestas), apostado: Number(r.apostado), ganancia_casa: Number(r.ganancia_casa) });
  const filaApuesta = (r) => ({
    id: Number(r.id), jugador_id: r.jugador_id, juego: r.juego,
    monto: Number(r.monto), neto: Number(r.neto),
  });

  async function cargar() {
    if (cola) return; // una ronda en curso: lo que llegue revelaría el resultado
    const [j, c, a] = await Promise.all([
      db.from('jugadores').select('id,nombre,saldo,apuestas').order('saldo', { ascending: false }).limit(1000),
      db.from('casa_juegos').select('juego,apuestas,apostado,ganancia_casa'),
      db.from('apuestas').select('id,jugador_id,juego,monto,neto').order('id', { ascending: false }).limit(MAX_RECIENTES),
    ]);
    if (j.error || c.error || a.error) {
      estadoVivo('sin conexión', 'mal');
      return;
    }
    if (cola) return;
    jugadores.clear();
    j.data.forEach((r) => jugadores.set(r.id, filaJugador(r)));
    c.data.forEach((r) => casa.set(r.juego, filaCasa(r)));
    recientes = a.data.map(filaApuesta);

    if (sesion && !jugadores.has(sesion.id)) {
      // Fuera de los primeros mil, o un jugador que ya no existe.
      const mio = await db.from('jugadores').select('id,nombre,saldo,apuestas').eq('id', sesion.id).maybeSingle();
      if (!mio.error && mio.data) jugadores.set(mio.data.id, filaJugador(mio.data));
      else if (!mio.error) guardarSesion(null);
    }
    pintar();
  }

  function aplicar(ev) {
    if (ev.tabla === 'jugadores') {
      if (ev.tipo === 'DELETE') jugadores.delete(ev.viejo.id);
      else jugadores.set(ev.nuevo.id, filaJugador(ev.nuevo));
    } else if (ev.tabla === 'casa_juegos') {
      casa.set(ev.nuevo.juego, filaCasa(ev.nuevo));
    } else if (ev.tabla === 'apuestas') {
      const fila = filaApuesta(ev.nuevo);
      if (!recientes.some((r) => r.id === fila.id)) {
        recientes.unshift(fila);
        recientes.sort((x, y) => y.id - x.id);
        recientes.length = Math.min(recientes.length, MAX_RECIENTES);
      }
    }
  }

  function alLlegar(tabla) {
    return (p) => {
      const ev = { tabla, tipo: p.eventType, nuevo: p.new, viejo: p.old };
      if (cola) cola.push(ev);
      else {
        aplicar(ev);
        pintarPronto();
      }
    };
  }

  function suscribir() {
    db.channel('millon')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jugadores' }, alLlegar('jugadores'))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'casa_juegos' }, alLlegar('casa_juegos'))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'apuestas' }, alLlegar('apuestas'))
      .subscribe((estado) => {
        if (estado === 'SUBSCRIBED') {
          estadoVivo('en vivo', 'bien');
          cargar();
        } else if (estado === 'CHANNEL_ERROR' || estado === 'TIMED_OUT' || estado === 'CLOSED') {
          estadoVivo('reconectando…', 'mal');
        }
      });
  }

  function estadoVivo(texto, clase) {
    const el = $('vivo');
    el.textContent = texto;
    el.className = 'vivo ' + clase;
  }

  // ── Pintar ──────────────────────────────────────────────────────────────

  function pintarPronto() {
    if (pintadoPendiente) return;
    pintadoPendiente = true;
    requestAnimationFrame(() => {
      pintadoPendiente = false;
      pintar();
    });
  }

  function crear(etiqueta, clase, texto) {
    const el = document.createElement(etiqueta);
    if (clase) el.className = clase;
    if (texto !== undefined) el.textContent = texto;
    return el;
  }

  function ordenados() {
    return Array.from(jugadores.values()).sort(
      (a, b) => b.saldo - a.saldo || a.nombre.localeCompare(b.nombre, 'es'));
  }

  function pintar() {
    const lista = ordenados();
    pintarYo(lista);
    pintarPosiciones(lista);
    pintarCasa();
    pintarRecientes();
    pintarNota();
  }

  function pintarYo(lista) {
    const mio = yo();
    $('yo').hidden = !mio;
    $('entrar').hidden = !!mio;
    if (!mio) return;
    const neto = mio.saldo - INICIAL;
    const lugar = lista.findIndex((j) => j.id === mio.id) + 1;
    $('yo-nombre').textContent = mio.nombre;
    $('yo-lugar').textContent = lugar ? `Lugar ${lugar} de ${lista.length}` : '';
    $('yo-saldo').textContent = dinero(mio.saldo);
    $('yo-neto').textContent = neto === 0 ? 'sin cambios' : conSigno(neto);
    $('yo-neto').className = 'yo-neto ' + claseSigno(neto);
  }

  function pintarPosiciones(lista) {
    const ol = $('posiciones');
    const filas = lista.map((j, i) => {
      const neto = j.saldo - INICIAL;
      const quebrado = j.saldo < 0.01;
      const li = crear('li', 'fila');
      if (i === 0) li.classList.add('primero');
      if (sesion && j.id === sesion.id) li.classList.add('yo-fila');
      if (quebrado) li.classList.add('quebrado');
      li.append(crear('span', 'lugar', i === 0 ? '👑' : String(i + 1)));
      const nombre = crear('span', 'nombre', j.nombre);
      if (sesion && j.id === sesion.id) nombre.append(crear('small', '', 'tú'));
      if (quebrado) nombre.append(crear('small', 'quiebra', 'en quiebra'));
      li.append(nombre);
      const d = crear('span', 'dinero');
      d.append(crear('span', 'saldo', dinero(j.saldo)));
      d.append(crear('span', 'neto ' + claseSigno(neto), neto === 0 ? 'sin cambios' : conSigno(neto)));
      li.append(d);
      return li;
    });
    ol.replaceChildren(...filas);
    $('posiciones-vacio').hidden = lista.length > 0;
  }

  function pintarCasa() {
    let neta = 0;
    let apostado = 0;
    const filas = Object.keys(JUEGOS).map((juego) => {
      const c = casa.get(juego) || { apuestas: 0, apostado: 0, ganancia_casa: 0 };
      neta += c.ganancia_casa;
      apostado += c.apostado;
      const tr = crear('tr');
      tr.append(crear('td', '', JUEGOS[juego].nombre));
      tr.append(crear('td', '', formato.format(c.apuestas)));
      tr.append(crear('td', claseSigno(c.ganancia_casa), conSigno(c.ganancia_casa)));
      return tr;
    });
    $('casa-juegos').replaceChildren(...filas);
    $('casa-neta').textContent = conSigno(neta);
    $('casa-neta').className = 'cifra-valor ' + claseSigno(neta);
    $('jugadores-neto').textContent = conSigno(-neta);
    $('jugadores-neto').className = 'cifra-valor ' + claseSigno(-neta);
    $('casa-apostado').textContent = dinero(apostado);
    pintarEsperado();
  }

  // La sección de matemática: lo que la casa debería llevar contra lo que lleva.
  function pintarEsperado() {
    const porciento = (parte, total) => (total > 0
      ? ` (${parte < 0 ? '−' : ''}${Math.abs(100 * parte / total).toFixed(1)}%)` : '');
    let apostado = 0;
    let esperado = 0;
    let real = 0;
    const fila = (nombre, a, e, r, clase) => {
      const tr = crear('tr', clase);
      tr.append(crear('th', '', nombre));
      tr.lastChild.scope = 'row';
      tr.append(crear('td', '', dinero(a)));
      tr.append(crear('td', '', conSigno(e) + porciento(e, a)));
      tr.append(crear('td', claseSigno(r), conSigno(r) + porciento(r, a)));
      return tr;
    };
    const filas = Object.keys(JUEGOS).map((juego) => {
      const c = casa.get(juego) || { apostado: 0, ganancia_casa: 0 };
      const e = centavos(c.apostado * ventaja(juego));
      apostado += c.apostado;
      esperado += e;
      real += c.ganancia_casa;
      return fila(JUEGOS[juego].nombre, c.apostado, e, c.ganancia_casa, '');
    });
    filas.push(fila('Total', apostado, esperado, real, 'mates-total'));
    $('mates-real').replaceChildren(...filas);
  }

  function pintarRecientes() {
    const ul = $('recientes');
    if (!recientes.length) {
      ul.replaceChildren(crear('li', 'nada', 'Aún no hay jugadas.'));
      return;
    }
    ul.replaceChildren(...recientes.map((a) => {
      const li = crear('li');
      const quien = crear('span', 'quien');
      const j = jugadores.get(a.jugador_id);
      quien.append(crear('b', '', j ? j.nombre : 'Alguien'));
      quien.append(` · ${JUEGOS[a.juego] ? JUEGOS[a.juego].nombre : a.juego} · apostó ${dinero(a.monto)}`);
      li.append(quien);
      li.append(crear('span', 'cuanto ' + claseSigno(a.neto), conSigno(a.neto)));
      return li;
    }));
  }

  // ── La apuesta ──────────────────────────────────────────────────────────

  function montoEscrito() {
    const texto = $('monto').value.replace(/[$,\s]/g, '');
    if (!/^\d*\.?\d*$/.test(texto) || texto === '' || texto === '.') return NaN;
    return centavos(Number(texto));
  }

  function ponerMonto(n) {
    $('monto').value = formato.format(centavos(n));
    avisarNota(null);
  }

  function pintarNota() {
    const nota = $('apuesta-nota');
    nota.classList.toggle('mal', !!notaError);
    if (notaError) {
      nota.textContent = notaError;
      return;
    }
    const m = montoEscrito();
    if (!(m > 0)) {
      nota.textContent = 'Escribe cuánto quieres apostar.';
      return;
    }
    const gana = centavos(m * JUEGOS[juegoActivo].factor);
    nota.textContent = `Si ganas: ${conSigno(gana)} · si pierdes: ${conSigno(-m)}`;
  }

  // El aviso se queda hasta que el jugador cambie el monto o el juego.
  function avisarNota(texto) {
    notaError = texto || null;
    pintarNota();
  }

  // Valida lo que se puede saber aquí; la base vuelve a validar todo.
  function montoValido() {
    if (!sesion || !yo()) {
      abrirAlta();
      return null;
    }
    const m = montoEscrito();
    if (!(m > 0)) {
      avisarNota('Escribe un monto mayor a cero.');
      $('monto').focus();
      return null;
    }
    if (miSaldo() < 0.01) {
      avisarNota('Te quedaste sin dinero: estás en quiebra.');
      return null;
    }
    if (m > miSaldo()) {
      avisarNota(`No te alcanza: tienes ${dinero(miSaldo())}.`);
      $('monto').focus();
      return null;
    }
    return m;
  }

  function bloquear(si) {
    ocupado = si;
    todos('.pestana, .opcion, .ficha, .boton-jugar, #monto, #salir').forEach((el) => { el.disabled = si; });
  }

  function mostrarResultado(texto, clase) {
    const el = $('resultado');
    el.className = 'resultado' + (clase ? ' ' + clase : '');
    el.textContent = texto;
  }

  function textoError(error) {
    const m = (error && error.message) || '';
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'No se pudo conectar. Revisa tu conexión e inténtalo de nuevo.';
    return m || 'Algo salió mal. Inténtalo de nuevo.';
  }

  // Una ronda: pide el resultado a la base, lo anima y solo entonces lo aplica.
  async function ronda(juego, elegido, monto, animar) {
    bloquear(true);
    cola = [];
    notaError = null;
    mostrarResultado('');
    let data = null;
    let error = null;
    try {
      const r = await db.rpc('apostar', {
        p_jugador: sesion.id, p_llave: sesion.llave, p_juego: juego, p_eleccion: elegido, p_monto: monto,
      });
      data = r.data;
      error = r.error;
    } catch (e) {
      error = e;
    }
    if (!error && data) {
      try {
        await animar(Number(data.resultado));
      } catch (e) {
        console.error(e);
      }
      const mio = yo();
      if (mio) mio.saldo = Number(data.saldo);
    }
    const retenidos = cola;
    cola = null;
    retenidos.forEach(aplicar);
    bloquear(false);

    if (error || !data) {
      if (error && /no reconocido/i.test(error.message || '')) {
        guardarSesion(null);
        mostrarResultado('Este navegador ya no tiene un jugador válido. Entra de nuevo.', 'error');
      } else {
        mostrarResultado(textoError(error), 'error');
      }
    } else {
      const neto = Number(data.neto);
      const detalle = {
        moneda: () => `Cayó ${data.resultado === 0 ? 'águila' : 'sol'}.`,
        caballos: () => `Ganó ${CABALLOS[data.resultado]} (${data.resultado + 1}).`,
        copas: () => `La piedrita estaba en ${LUGAR_COPA[data.resultado]}.`,
      }[juego]();
      if (data.gano) mostrarResultado(`¡Ganaste ${conSigno(neto)}! ${detalle}`, 'gano');
      else mostrarResultado(`Perdiste ${dinero(monto)}. ${detalle}`, 'perdio');
      if (montoEscrito() > miSaldo() && miSaldo() >= 0.01) ponerMonto(miSaldo());
    }
    pintar();
    cargar();
    return !error && !!data;
  }

  // ── Moneda ──────────────────────────────────────────────────────────────

  async function animarMoneda(resultado) {
    const vuelo = $('moneda-vuelo');
    giro = Math.ceil(giro / 360) * 360 + 360 * 6 + (resultado === 1 ? 180 : 0);
    vuelo.classList.remove('volando');
    void vuelo.offsetWidth; // reinicia la animación del vuelo
    vuelo.classList.add('volando');
    $('moneda').style.transform = `rotateX(${giro}deg)`;
    await dormir(2350);
  }

  async function jugarMoneda() {
    if (ocupado) return;
    const m = montoValido();
    if (m === null) return;
    await ronda('moneda', eleccion.moneda, m, animarMoneda);
  }

  // ── Caballos ────────────────────────────────────────────────────────────

  function marcarCarril() {
    todos('.carril').forEach((c) => c.classList.toggle('elegido', Number(c.dataset.caballo) === eleccion.caballos));
  }

  // Cada caballo avanza con su propio ritmo; el sorteado es el único que
  // cruza la meta primero. El ritmo es adorno: el ganador ya viene decidido.
  function animarCaballos(ganador) {
    const carriles = todos('.carril');
    const BASE = 3600;
    const perfiles = carriles.map((_, i) => ({
      t: i === ganador ? BASE : BASE + 260 + Math.random() * 1100,
      a: (Math.random() * 2 - 1) * 0.15,
      b: (Math.random() * 2 - 1) * 0.07,
    }));
    carriles.forEach((c) => {
      c.classList.remove('ganador');
      c.style.setProperty('--p', '0');
    });
    const terminar = () => carriles.forEach((c, i) => {
      c.style.setProperty('--p', '1');
      c.classList.toggle('ganador', i === ganador);
    });
    if (SIN_MOVIMIENTO) {
      terminar();
      return dormir(100);
    }
    const fin = Math.max(...perfiles.map((p) => p.t));
    return new Promise((resolver) => {
      const t0 = performance.now();
      function cuadro(ahora) {
        const t = ahora - t0;
        carriles.forEach((c, i) => {
          const u = Math.min(1, t / perfiles[i].t);
          const p = u + perfiles[i].a * Math.sin(Math.PI * u) + perfiles[i].b * Math.sin(2 * Math.PI * u);
          c.style.setProperty('--p', p.toFixed(4));
          if (u >= 1 && i === ganador) c.classList.add('ganador');
        });
        if (t < fin) requestAnimationFrame(cuadro);
        else {
          terminar();
          setTimeout(resolver, 450);
        }
      }
      requestAnimationFrame(cuadro);
    });
  }

  async function jugarCaballos() {
    if (ocupado) return;
    const m = montoValido();
    if (m === null) return;
    await ronda('caballos', eleccion.caballos, m, animarCaballos);
  }

  // ── Copas ───────────────────────────────────────────────────────────────

  const copas = todos('.copa');

  function ponerCopa(copa, lugar) {
    copa.dataset.lugar = String(lugar);
    copa.style.setProperty('--x', X_COPA[lugar]);
    copa.setAttribute('aria-label', ROTULO_COPA[lugar]);
  }

  function barajar(lista) {
    for (let i = lista.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [lista[i], lista[j]] = [lista[j], lista[i]];
    }
    return lista;
  }

  function avisoCopas(texto) {
    $('copas-aviso').textContent = texto;
  }

  // Las copas se juntan en el centro y se separan en otro orden: no hay forma
  // de seguirlas con la vista. Dónde quedó la piedrita lo sortea la base al
  // elegir, con la misma probabilidad para las tres.
  async function revolverCopas() {
    if (ocupado) return;
    if (montoValido() === null) return;
    bloquear(true);
    faseCopas = 'revolviendo';
    mostrarResultado('');
    const mesa = $('mesa');
    const piedra = $('piedra');
    copas.forEach((c, i) => {
      c.disabled = true;
      c.classList.remove('arriba', 'elegida');
      ponerCopa(c, i);
    });
    piedra.classList.remove('visible');
    piedra.style.setProperty('--x', X_COPA[1]);
    await dormir(350);

    avisoCopas('La piedrita entra en una copa…');
    const medio = copas.find((c) => c.dataset.lugar === '1');
    medio.classList.add('arriba');
    await dormir(300);
    piedra.classList.add('visible');
    await dormir(650);
    medio.classList.remove('arriba');
    await dormir(420);
    piedra.classList.remove('visible');

    avisoCopas('Se revuelven…');
    for (let k = 0; k < 3; k++) {
      copas.forEach((c) => c.style.setProperty('--x', '50%'));
      await dormir(360);
      mesa.classList.add('revolviendo');
      await dormir(520);
      mesa.classList.remove('revolviendo');
      const orden = barajar([0, 1, 2]);
      copas.forEach((c, i) => ponerCopa(c, orden[i]));
      await dormir(420);
    }

    avisoCopas('¿Dónde quedó la piedrita? Toca una copa.');
    faseCopas = 'eligiendo';
    copas.forEach((c) => { c.disabled = false; });
    const primera = copas.find((c) => c.dataset.lugar === '0');
    if (document.activeElement === document.body || document.activeElement === $('jugar-copas')) primera.focus();
  }

  async function elegirCopa(copa) {
    if (faseCopas !== 'eligiendo') return;
    faseCopas = 'resolviendo';
    copas.forEach((c) => { c.disabled = true; });
    copa.classList.add('elegida');
    avisoCopas('A ver…');
    const m = montoEscrito();
    const lugar = Number(copa.dataset.lugar);
    await ronda('copas', lugar, m, async (resultado) => {
      const piedra = $('piedra');
      piedra.style.setProperty('--x', X_COPA[resultado]);
      piedra.classList.add('visible');
      copa.classList.add('arriba');
      await dormir(750);
      copas.forEach((c) => c.classList.add('arriba'));
      await dormir(700);
    });
    faseCopas = 'listo';
    avisoCopas('Revuelve las copas y luego toca la que creas que tiene la piedrita.');
  }

  // ── Alta de jugador ─────────────────────────────────────────────────────

  function abrirAlta() {
    const d = $('alta');
    $('alta-error').textContent = '';
    if (!d.open) d.showModal();
    $('alta-nombre').focus();
  }

  async function crearJugador(ev) {
    ev.preventDefault();
    const nombre = $('alta-nombre').value.trim().replace(/\s+/g, ' ');
    if (nombre.length < 2) {
      $('alta-error').textContent = 'Escribe un nombre de al menos 2 letras.';
      return;
    }
    $('alta-crear').disabled = true;
    $('alta-error').textContent = '';
    let data = null;
    let error = null;
    try {
      const r = await db.rpc('crear_jugador', { p_nombre: nombre });
      data = r.data;
      error = r.error;
    } catch (e) {
      error = e;
    }
    $('alta-crear').disabled = false;
    if (error || !data) {
      $('alta-error').textContent = textoError(error);
      return;
    }
    guardarSesion({ id: data.id, llave: data.llave, nombre: data.nombre });
    jugadores.set(data.id, { id: data.id, nombre: data.nombre, saldo: Number(data.saldo), apuestas: 0 });
    $('alta').close();
    $('alta-nombre').value = '';
    mostrarResultado(`¡Bienvenido, ${data.nombre}! Tienes ${dinero(INICIAL)} para empezar.`);
    pintar();
  }

  function salir() {
    if (ocupado) return;
    const ok = window.confirm(
      'Si sales, este navegador olvida a tu jugador y ya no podrás volver a él (seguirá en la tabla). ¿Salir?');
    if (!ok) return;
    guardarSesion(null);
    mostrarResultado('');
    pintar();
    abrirAlta();
  }

  // ── Controles ───────────────────────────────────────────────────────────

  function elegirJuego(juego) {
    if (ocupado) return;
    juegoActivo = juego;
    todos('.pestana').forEach((p) => p.setAttribute('aria-selected', String(p.dataset.juego === juego)));
    Object.keys(JUEGOS).forEach((j) => { $('panel-' + j).hidden = j !== juego; });
    avisarNota(null);
    mostrarResultado('');
  }

  function conectarOpciones(juego) {
    const botones = todos(`#panel-${juego} .opcion`);
    botones.forEach((b) => b.addEventListener('click', () => {
      eleccion[juego] = Number(b.dataset.eleccion);
      botones.forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      if (juego === 'caballos') marcarCarril();
    }));
  }

  function iniciar() {
    todos('.pestana').forEach((p) => p.addEventListener('click', () => elegirJuego(p.dataset.juego)));
    conectarOpciones('moneda');
    conectarOpciones('caballos');
    marcarCarril();
    copas.forEach((c, i) => {
      ponerCopa(c, i);
      c.addEventListener('click', () => elegirCopa(c));
    });

    $('jugar-moneda').addEventListener('click', jugarMoneda);
    $('jugar-caballos').addEventListener('click', jugarCaballos);
    $('jugar-copas').addEventListener('click', revolverCopas);

    $('monto').addEventListener('input', () => avisarNota(null));
    $('monto').addEventListener('blur', () => {
      const m = montoEscrito();
      if (m > 0) ponerMonto(m);
    });
    todos('.ficha').forEach((f) => f.addEventListener('click', () => {
      const v = f.dataset.monto;
      if (v === 'todo' || v === 'mitad') {
        if (!yo()) {
          abrirAlta();
          return;
        }
        ponerMonto(v === 'todo' ? miSaldo() : Math.floor(miSaldo() * 50) / 100);
      } else {
        ponerMonto(Number(v));
      }
    }));

    $('entrar').addEventListener('click', abrirAlta);
    $('salir').addEventListener('click', salir);
    $('alta-forma').addEventListener('submit', crearJugador);
    $('alta-mirar').addEventListener('click', () => $('alta').close());

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) cargar();
    });
    setInterval(cargar, 30000);

    pintar();
    suscribir();
    cargar().then(() => {
      if (!sesion) abrirAlta();
    });
  }

  iniciar();
})();
