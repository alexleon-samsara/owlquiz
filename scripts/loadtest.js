#!/usr/bin/env node
// Owlquiz — prueba de carga.
// Simula N celulares conectados a tu servidor y juega preguntas reales para
// medir si aguanta. Sube por niveles (por ejemplo 50 → 100 → 150 → 200) y
// reporta en cada nivel cuánto tarda la pregunta en llegar a los celulares.
//
// Uso:
//   node scripts/loadtest.js <url> <pin> [opciones]
//
// Ejemplos:
//   node scripts/loadtest.js https://owlquiz.onrender.com MI_PIN
//   node scripts/loadtest.js https://owlquiz.onrender.com MI_PIN --max 300 --step 50
//   node scripts/loadtest.js http://localhost:3000 samsara --max 200 --step 200
//
// Opciones:
//   --max N        jugadores máximos (default 200)
//   --step N       cuántos agrega por nivel (default 50; igual a --max = un solo nivel)
//   --questions N  preguntas por nivel (default 2)
//   --force        corre aunque haya un juego en curso (lo reinicia)
//
// No lo corras durante una presentación real: reinicia el juego.

const { io } = require('socket.io-client');

// ---------- Argumentos ----------
const args = process.argv.slice(2);
const opts = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--force') opts.force = true;
  else if (a.startsWith('--')) opts[a.slice(2)] = args[++i];
  else positional.push(a);
}
const URL = (positional[0] || '').replace(/\/+$/, '');
const PIN = positional[1];
const MAX = Number(opts.max || 200);
const STEP = Number(opts.step || 50);
const QUESTIONS = Number(opts.questions || 2);
const FORCE = !!opts.force;

if (!URL || !PIN || !(MAX > 0) || !(STEP > 0)) {
  console.log('Uso: node scripts/loadtest.js <url> <pin> [--max 200] [--step 50] [--questions 2] [--force]');
  process.exit(1);
}

// Umbrales para dar el nivel por bueno.
const LIMIT_P95_MS = 1000;   // 95 % recibe la pregunta en menos de 1 s
const LIMIT_MAX_MS = 3000;   // nadie tarda más de 3 s
const JOIN_TIMEOUT_MS = 15000;
const PHASE_TIMEOUT_MS = 20000;
const BATCH = 20;            // conexiones nuevas al mismo tiempo

// ---------- Utilidades ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const ms = (v) => (v == null ? '–' : `${Math.round(v)} ms`);
const pad = (s, n) => String(s).padEnd(n);
const emit = (sock, ev, data, timeout = 10000) => new Promise((resolve) => {
  const t = setTimeout(() => resolve({ ok: false, error: 'timeout' }), timeout);
  sock.emit(ev, data || {}, (res) => { clearTimeout(t); resolve(res || { ok: false }); });
});
function waitFor(check, timeout) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (check()) return resolve(true);
      if (Date.now() - start > timeout) return resolve(false);
      setTimeout(tick, 20);
    };
    tick();
  });
}

// ---------- Despertar el servidor (plan gratis de Render se duerme) ----------
async function wake() {
  process.stdout.write(`Despertando ${URL} `);
  const start = Date.now();
  while (Date.now() - start < 120000) {
    try {
      const r = await fetch(`${URL}/health`, { signal: AbortSignal.timeout(10000) });
      if (r.ok) { console.log(`✓ (${((Date.now() - start) / 1000).toFixed(1)} s)`); return true; }
    } catch (e) { /* sigue intentando */ }
    process.stdout.write('.');
    await sleep(3000);
  }
  console.log('\n✗ El servidor no respondió en 2 minutos.');
  return false;
}

// ---------- Presentador ----------
async function connectHost() {
  const host = io(URL, { transports: ['websocket', 'polling'], forceNew: true, reconnection: false });
  host.state = null;
  host.on('host:state', (s) => { host.state = s; });
  const ok = await new Promise((resolve) => {
    host.once('connect', () => resolve(true));
    host.once('connect_error', (e) => { console.log(`✗ No se pudo conectar: ${e.message}`); resolve(false); });
  });
  if (!ok) return null;
  const auth = await emit(host, 'host:auth', { pin: PIN });
  if (!auth.ok) { console.log(`✗ ${auth.error || 'PIN incorrecto.'}`); host.disconnect(); return null; }
  await waitFor(() => host.state, 5000);
  return host;
}

// ---------- Bots ----------
const bots = [];
let disconnects = 0;
let connectErrors = 0;

function makeBot(i) {
  return new Promise((resolve) => {
    const t0 = now();
    const name = `Bot ${String(i + 1).padStart(3, '0')}`;
    const sock = io(URL, { transports: ['websocket', 'polling'], forceNew: true, reconnection: false, timeout: JOIN_TIMEOUT_MS });
    const bot = { i, name, sock, state: null, seen: {}, joined: false };
    const fail = (why) => { connectErrors++; bot.error = why; try { sock.disconnect(); } catch (e) {} resolve(bot); };
    const timer = setTimeout(() => fail('timeout'), JOIN_TIMEOUT_MS);
    sock.on('state', (s) => {
      bot.state = s;
      const key = `${s.phase}:${s.qIndex}`;
      if (!bot.seen[key]) bot.seen[key] = now();
    });
    sock.on('disconnect', (reason) => {
      if (bot.joined && !bot.leaving) { disconnects++; bot.dropped = reason; }
    });
    sock.once('connect_error', (e) => { clearTimeout(timer); fail(e.message); });
    sock.once('connect', async () => {
      const res = await emit(sock, 'player:join', { name }, JOIN_TIMEOUT_MS);
      clearTimeout(timer);
      if (!res.ok) return fail(res.error || 'join');
      bot.joined = true;
      bot.joinMs = now() - t0;
      resolve(bot);
    });
  });
}

async function addBots(target) {
  const joinTimes = [];
  while (bots.length < target) {
    const n = Math.min(BATCH, target - bots.length);
    const batch = await Promise.all(Array.from({ length: n }, (_, k) => makeBot(bots.length + k)));
    for (const b of batch) {
      bots.push(b);
      if (b.joined) joinTimes.push(b.joinMs);
    }
  }
  return joinTimes;
}

const liveBots = () => bots.filter((b) => b.joined && b.sock.connected);

// ---------- Una pregunta ----------
async function playQuestion(host, qIndex, isFirst) {
  const players = liveBots();
  for (const b of players) b.seen = {}; // cada nivel repite las mismas preguntas
  const t0 = now();
  const res = await emit(host, isFirst ? 'host:start' : 'host:next');
  if (!res.ok) return { error: res.error || 'el servidor rechazó el inicio' };

  const key = `question:${qIndex}`;
  await waitFor(() => players.every((b) => b.seen[key] || !b.sock.connected), PHASE_TIMEOUT_MS);
  const delivery = players.filter((b) => b.seen[key]).map((b) => b.seen[key] - t0);
  const missed = players.length - delivery.length;

  // Cada bot responde al azar entre 0.3 y 3 s.
  const nOpts = host.state && host.state.question ? host.state.question.options.length : 4;
  const answerAcks = [];
  let rejected = 0;
  await Promise.all(players.filter((b) => b.seen[key]).map(async (b) => {
    await sleep(300 + Math.random() * 2700);
    if (!b.sock.connected) return;
    const a0 = now();
    const r = await emit(b.sock, 'player:answer', { choice: 1 + Math.floor(Math.random() * nOpts) });
    if (r.ok) answerAcks.push(now() - a0); else rejected++;
  }));

  // Al responder todos, el servidor cierra la pregunta solo.
  const rKey = `reveal:${qIndex}`;
  const r0 = now();
  const revealed = await waitFor(() => players.every((b) => b.seen[rKey] || !b.sock.connected), PHASE_TIMEOUT_MS);
  const revealCount = players.filter((b) => b.seen[rKey]).length;
  const answered = host.state && host.state.reveal ? host.state.reveal.counts.reduce((a, b) => a + b, 0) : null;
  return {
    players: players.length, delivery, missed, answerAcks, rejected,
    revealOk: revealed, revealCount, revealMs: now() - r0, answered,
  };
}

// ---------- Programa ----------
(async () => {
  console.log('\nOwlquiz · prueba de carga');
  console.log(`Servidor: ${URL} · máximo ${MAX} jugadores · niveles de ${STEP} · ${QUESTIONS} preguntas por nivel\n`);

  if (!(await wake())) process.exit(1);
  const host = await connectHost();
  if (!host) process.exit(1);

  const s = host.state;
  if (s.phase !== 'lobby' && !FORCE) {
    console.log('✗ Hay un juego en curso. Termínalo o corre con --force (lo reinicia).');
    process.exit(1);
  }
  if (s.phase !== 'lobby') await emit(host, 'host:lobby');
  const quiz = (s.quizzes || []).find((q) => q.id === s.quizId) || (s.quizzes || [])[0];
  if (!quiz) { console.log('✗ El servidor no tiene quizzes cargados.'); process.exit(1); }
  await emit(host, 'host:select', { id: quiz.id });
  const prevTime = s.timeOverride == null ? null : s.timeOverride;
  const prevAuto = !!s.autoAdvance;
  await emit(host, 'host:settings', { timeOverride: 10, autoAdvance: false });
  const perLevel = Math.min(QUESTIONS, quiz.count);
  console.log(`Quiz: "${quiz.title}" (${quiz.count} preguntas; se juegan ${perLevel} por nivel)\n`);

  const levels = [];
  for (let n = Math.min(STEP, MAX); n <= MAX; n += STEP) levels.push(n);
  if (levels[levels.length - 1] !== MAX) levels.push(MAX);

  const results = [];
  let limitReached = null;

  for (const level of levels) {
    process.stdout.write(`▶ Nivel ${level}: conectando… `);
    const joinTimes = await addBots(level);
    await sleep(800);
    const live = liveBots().length;
    const seenByServer = host.state ? host.state.playerCount : null;
    console.log(`${live}/${level} conectados (el servidor ve ${seenByServer})`);

    const delivery = [], acks = [];
    let missed = 0, rejected = 0, revealFail = 0, errorMsg = null;
    for (let q = 0; q < perLevel; q++) {
      const r = await playQuestion(host, q, q === 0);
      if (r.error) { errorMsg = r.error; break; }
      delivery.push(...r.delivery); acks.push(...r.answerAcks);
      missed += r.missed; rejected += r.rejected;
      if (!r.revealOk) revealFail += r.players - r.revealCount;
      process.stdout.write(`   P${q + 1}: pregunta p95 ${ms(pct(r.delivery, 95))} · máx ${ms(Math.max(...r.delivery, 0))} · respuestas contadas ${r.answered}/${r.players}\n`);
    }
    await emit(host, 'host:lobby');
    await sleep(500);

    const row = {
      level, live, joinP95: pct(joinTimes, 95),
      p50: pct(delivery, 50), p95: pct(delivery, 95), max: delivery.length ? Math.max(...delivery) : null,
      ackP95: pct(acks, 95), missed, rejected, revealFail, disconnects, connectErrors, errorMsg,
    };
    row.pass = !errorMsg && live === level && disconnects === 0 && missed === 0 && revealFail === 0
      && row.p95 != null && row.p95 < LIMIT_P95_MS && row.max < LIMIT_MAX_MS;
    results.push(row);
    console.log(`   → ${row.pass ? '✓ aguanta' : '✗ falla'}\n`);
    if (!row.pass) { limitReached = level; break; }
  }

  // ---------- Limpieza ----------
  for (const b of bots) { b.leaving = true; try { b.sock.disconnect(); } catch (e) {} }
  await sleep(1500);
  await emit(host, 'host:lobby'); // quita de la sala a los bots desconectados
  await emit(host, 'host:settings', { timeOverride: prevTime, autoAdvance: prevAuto });
  host.disconnect();

  // ---------- Reporte ----------
  console.log('Resumen');
  console.log(pad('Jugadores', 11) + pad('Conectados', 12) + pad('Entrar p95', 12) + pad('Pregunta p50', 14) + pad('p95', 10) + pad('máx', 10) + pad('Respuesta p95', 15) + 'Resultado');
  for (const r of results) {
    const notes = [];
    if (r.disconnects) notes.push(`${r.disconnects} desconexiones`);
    if (r.connectErrors) notes.push(`${r.connectErrors} no entraron`);
    if (r.missed) notes.push(`${r.missed} sin pregunta`);
    if (r.rejected) notes.push(`${r.rejected} respuestas rechazadas`);
    if (r.revealFail) notes.push(`${r.revealFail} sin resultado`);
    if (r.errorMsg) notes.push(r.errorMsg);
    console.log(pad(r.level, 11) + pad(`${r.live}/${r.level}`, 12) + pad(ms(r.joinP95), 12) + pad(ms(r.p50), 14)
      + pad(ms(r.p95), 10) + pad(ms(r.max), 10) + pad(ms(r.ackP95), 15) + (r.pass ? '✓' : '✗') + (notes.length ? `  (${notes.join(', ')})` : ''));
  }
  const best = results.filter((r) => r.pass).pop();
  console.log('');
  if (!limitReached) console.log(`✓ Aguantó ${MAX} jugadores. Para buscar el límite, sube --max.`);
  else console.log(`✗ Falló en ${limitReached}. ${best ? `Último nivel bueno: ${best.level}.` : 'Ningún nivel pasó.'}`);
  console.log(`Criterio: todos conectados, 0 desconexiones, 95 % recibe la pregunta en < ${LIMIT_P95_MS} ms y nadie > ${LIMIT_MAX_MS} ms.`);
  process.exit(limitReached ? 2 : 0);
})().catch((e) => { console.error('Error:', e); process.exit(1); });
