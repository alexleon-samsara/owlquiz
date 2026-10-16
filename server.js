// Owlquiz — servidor de juego en vivo (Express + Socket.IO).
// Un solo juego por servidor. Presentador en /host (con PIN), jugadores en /.

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const HOST_PIN = String(process.env.HOST_PIN || 'samsara');
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const QUIZ_DIR = path.join(__dirname, 'quizzes');
const REVEAL_AUTO_MS = 7000; // espera en avance automático
const GRACE_MS = 600; // tolerancia de red al cerrar una pregunta
const TIME_CHOICES = [10, 15, 20, 30];

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/health', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000 });

// ---------- Quizzes ----------

let quizzes = new Map(); // id -> quiz

function slugify(s) {
  return String(s || 'quiz')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'quiz';
}

// Formato: { title, questions: [{ text, options: [..2-4], answer: 1-4, time? }] }
function validateQuiz(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'El quiz debe ser un objeto JSON.' };
  const title = String(raw.title || '').trim();
  if (!title) return { error: 'Falta "title".' };
  if (!Array.isArray(raw.questions) || raw.questions.length === 0) return { error: 'Falta "questions" (al menos 1).' };
  if (raw.questions.length > 100) return { error: 'Máximo 100 preguntas.' };
  const questions = [];
  for (let i = 0; i < raw.questions.length; i++) {
    const q = raw.questions[i] || {};
    const n = i + 1;
    const text = String(q.text || '').trim();
    if (!text) return { error: `Pregunta ${n}: falta "text".` };
    if (!Array.isArray(q.options)) return { error: `Pregunta ${n}: falta "options".` };
    const options = q.options.map((o) => String(o == null ? '' : o).trim()).filter(Boolean);
    if (options.length < 2 || options.length > 4) return { error: `Pregunta ${n}: debe tener de 2 a 4 opciones.` };
    const answer = Number(q.answer);
    if (!Number.isInteger(answer) || answer < 1 || answer > options.length) {
      return { error: `Pregunta ${n}: "answer" debe ser el número de la opción correcta (1 a ${options.length}).` };
    }
    let time = q.time == null ? 10 : Number(q.time);
    if (!Number.isFinite(time)) time = 10;
    time = Math.min(120, Math.max(5, Math.round(time)));
    questions.push({ text: text.slice(0, 300), options: options.map((o) => o.slice(0, 120)), answer, time });
  }
  const id = raw.id ? slugify(raw.id) : slugify(title);
  return { quiz: { id, title: title.slice(0, 120), questions } };
}

function loadQuizzes() {
  const map = new Map();
  if (!fs.existsSync(QUIZ_DIR)) fs.mkdirSync(QUIZ_DIR, { recursive: true });
  for (const file of fs.readdirSync(QUIZ_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(QUIZ_DIR, file), 'utf8'));
      const { quiz, error } = validateQuiz({ ...raw, id: file.replace(/\.json$/, '') });
      if (error) { console.warn(`[quiz] ${file}: ${error}`); continue; }
      map.set(quiz.id, quiz);
    } catch (e) {
      console.warn(`[quiz] ${file}: JSON inválido (${e.message})`);
    }
  }
  quizzes = map;
}

function saveQuizFile(quiz) {
  const { id, ...body } = quiz;
  try {
    fs.writeFileSync(path.join(QUIZ_DIR, `${id}.json`), JSON.stringify(body, null, 2));
    return true;
  } catch (e) {
    console.warn(`[quiz] no se pudo guardar ${id}: ${e.message}`);
    return false;
  }
}

function quizList() {
  return [...quizzes.values()]
    .map((q) => ({ id: q.id, title: q.title, count: q.questions.length }))
    .sort((a, b) => a.title.localeCompare(b.title, 'es'));
}

loadQuizzes();

// ---------- Estado del juego ----------

const players = new Map(); // id -> player
const game = {
  phase: 'lobby', // lobby | question | reveal | final
  quizId: null,
  qIndex: -1,
  startedAt: 0,
  endsAt: 0,
  answers: new Map(), // playerId -> { choice, ms }
  autoAdvance: false,
  timeOverride: null, // null = tiempo de cada pregunta; o 10/15/20/30
  duration: 0, // segundos de la pregunta actual
  revealEndsAt: 0,
};
let questionTimer = null;
let advanceTimer = null;
let joinUrl = PUBLIC_URL;
let qrDataUrl = '';

function currentQuiz() { return game.quizId ? quizzes.get(game.quizId) : null; }
function currentQuestion() { const q = currentQuiz(); return q ? q.questions[game.qIndex] : null; }

function connectedPlayers() { return [...players.values()].filter((p) => p.connected); }

function ranking() {
  return [...players.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'es'));
}

function rankOf(id) {
  const r = ranking();
  const i = r.findIndex((p) => p.id === id);
  return i === -1 ? null : i + 1;
}

function cleanName(s) {
  return String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
}

function uniqueName(name, selfId) {
  const taken = new Set([...players.values()].filter((p) => p.id !== selfId).map((p) => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; i < 1000; i++) {
    const n = `${name.slice(0, 17)} ${i}`;
    if (!taken.has(n.toLowerCase())) return n;
  }
  return `${name.slice(0, 14)} ${crypto.randomInt(1000, 9999)}`;
}

function resetScores() {
  for (const p of players.values()) {
    p.score = 0; p.streak = 0; p.correctCount = 0; p.history = []; p.last = null;
  }
}

function clearTimers() {
  clearTimeout(questionTimer); questionTimer = null;
  clearTimeout(advanceTimer); advanceTimer = null;
  game.revealEndsAt = 0;
}

function startQuestion(index) {
  const quiz = currentQuiz();
  if (!quiz || index >= quiz.questions.length) return showFinal();
  clearTimers();
  const q = quiz.questions[index];
  game.phase = 'question';
  game.qIndex = index;
  game.answers = new Map();
  game.startedAt = Date.now();
  game.duration = game.timeOverride || q.time;
  game.endsAt = game.startedAt + game.duration * 1000;
  for (const p of players.values()) p.last = null;
  questionTimer = setTimeout(endQuestion, game.duration * 1000 + GRACE_MS);
  broadcast(true);
}

function endQuestion() {
  if (game.phase !== 'question') return;
  clearTimers();
  const q = currentQuestion();
  const duration = game.duration * 1000;
  for (const p of players.values()) {
    const a = game.answers.get(p.id);
    let points = 0;
    let correct = false;
    if (a) {
      correct = a.choice === q.answer;
      if (correct) points = Math.round(1000 * (1 - Math.min(a.ms, duration) / duration / 2));
    }
    if (correct) { p.streak += 1; p.correctCount += 1; } else { p.streak = 0; }
    p.score += points;
    p.history[game.qIndex] = a ? { choice: a.choice, correct, ms: a.ms, points } : { choice: null, correct: false, ms: null, points: 0 };
    p.last = { answered: !!a, correct, points };
  }
  game.phase = 'reveal';
  if (game.autoAdvance) {
    game.revealEndsAt = Date.now() + REVEAL_AUTO_MS;
    advanceTimer = setTimeout(next, REVEAL_AUTO_MS);
  }
  broadcast(true);
}

function showFinal() {
  clearTimers();
  game.phase = 'final';
  broadcast(true);
}

function next() {
  if (game.phase === 'question') return endQuestion();
  if (game.phase === 'reveal') {
    const quiz = currentQuiz();
    if (game.qIndex + 1 < quiz.questions.length) return startQuestion(game.qIndex + 1);
    return showFinal();
  }
}

function backToLobby() {
  clearTimers();
  game.phase = 'lobby';
  game.qIndex = -1;
  game.answers = new Map();
  resetScores();
  // Fuera jugadores desconectados al volver a la sala.
  for (const [id, p] of players) if (!p.connected) players.delete(id);
  broadcast(true);
}

// ---------- Vistas del estado ----------

function leaderboard(n) {
  return ranking().slice(0, n).map((p, i) => ({
    rank: i + 1, name: p.name, score: p.score, streak: p.streak,
    gained: p.last ? p.last.points : 0,
  }));
}

function publicState() {
  const quiz = currentQuiz();
  const q = currentQuestion();
  const s = {
    phase: game.phase,
    quizTitle: quiz ? quiz.title : '',
    qIndex: game.qIndex,
    total: quiz ? quiz.questions.length : 0,
    playerCount: connectedPlayers().length,
    serverNow: Date.now(),
  };
  if (q && (game.phase === 'question' || game.phase === 'reveal')) {
    s.question = { text: q.text, options: q.options, time: game.duration };
    s.endsAt = game.endsAt;
    s.answeredCount = game.answers.size;
  }
  if (game.phase === 'reveal') {
    const counts = q.options.map(() => 0);
    for (const a of game.answers.values()) counts[a.choice - 1] += 1;
    s.reveal = { answer: q.answer, counts };
    s.leaderboard = leaderboard(5);
    s.revealEndsAt = game.revealEndsAt;
    s.isLast = game.qIndex + 1 >= quiz.questions.length;
  }
  if (game.phase === 'final') s.leaderboard = leaderboard(3);
  return s;
}

function meState(p) {
  const a = game.answers.get(p.id);
  return {
    id: p.id, name: p.name, score: p.score, streak: p.streak,
    rank: rankOf(p.id), total: players.size,
    answered: !!a, choice: a ? a.choice : null, last: p.last,
  };
}

function hostState() {
  return {
    ...publicState(),
    autoAdvance: game.autoAdvance,
    timeOverride: game.timeOverride,
    timeChoices: TIME_CHOICES,
    quizId: game.quizId,
    quizzes: quizList(),
    joinUrl, qrDataUrl,
    players: ranking().map((p) => ({
      id: p.id, name: p.name, score: p.score, connected: p.connected,
      answered: game.answers.has(p.id),
    })),
    fullLeaderboard: game.phase === 'final' || game.phase === 'reveal'
      ? ranking().map((p, i) => ({ rank: i + 1, name: p.name, score: p.score, correct: p.correctCount }))
      : [],
  };
}

let broadcastPending = null;
function broadcast(immediate) {
  if (immediate) { clearTimeout(broadcastPending); broadcastPending = null; return flush(); }
  if (broadcastPending) return;
  broadcastPending = setTimeout(() => { broadcastPending = null; flush(); }, 150);
}

function flush() {
  const pub = publicState();
  for (const p of players.values()) {
    if (p.socketId) io.to(p.socketId).emit('state', { ...pub, me: meState(p) });
  }
  io.to('hosts').emit('host:state', hostState());
}

// ---------- Link y QR ----------

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}

async function ensureJoinUrl(socket) {
  if (PUBLIC_URL) joinUrl = PUBLIC_URL;
  else {
    const h = socket.handshake.headers;
    const proto = (h['x-forwarded-proto'] || 'http').split(',')[0].trim();
    let host = (h['x-forwarded-host'] || h.host || `localhost:${PORT}`).split(',')[0].trim();
    if (/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host)) {
      const ip = lanAddress();
      if (ip) host = host.replace(/^(localhost|127\.0\.0\.1|\[::1\])/, ip);
    }
    joinUrl = `${proto}://${host}`;
  }
  qrDataUrl = await QRCode.toDataURL(joinUrl, {
    margin: 1, width: 640, errorCorrectionLevel: 'M',
    color: { dark: '#1f1d1a', light: '#ffffff' },
  });
}

// ---------- CSV ----------

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function resultsCsv() {
  const quiz = currentQuiz();
  const qs = quiz ? quiz.questions : [];
  const head = ['Lugar', 'Nombre', 'Puntos', 'Aciertos'];
  qs.forEach((q, i) => head.push(`P${i + 1} respuesta`, `P${i + 1} correcta`, `P${i + 1} segundos`, `P${i + 1} puntos`));
  const rows = [head];
  ranking().forEach((p, idx) => {
    const row = [idx + 1, p.name, p.score, p.correctCount];
    qs.forEach((q, i) => {
      const h = p.history[i];
      if (!h || h.choice == null) row.push('', 'No', '', 0);
      else row.push(q.options[h.choice - 1], h.correct ? 'Sí' : 'No', (h.ms / 1000).toFixed(1), h.points);
    });
    rows.push(row);
  });
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\n');
}

// ---------- Sockets ----------

io.on('connection', (socket) => {
  // ----- Jugador -----
  socket.on('player:join', (data, ack) => {
    if (typeof ack !== 'function') return;
    const name = cleanName(data && data.name);
    if (!name) return ack({ ok: false, error: 'Escribe tu nombre.' });
    let p = data && data.id ? players.get(String(data.id)) : null;
    if (p) {
      if (p.socketId && p.socketId !== socket.id) io.to(p.socketId).emit('player:replaced');
      p.name = uniqueName(name, p.id);
    } else {
      p = {
        id: crypto.randomUUID(), name: uniqueName(name, null),
        score: 0, streak: 0, correctCount: 0, history: [], last: null,
      };
      players.set(p.id, p);
    }
    p.socketId = socket.id;
    p.connected = true;
    socket.data.playerId = p.id;
    ack({ ok: true, id: p.id, name: p.name });
    broadcast(true);
  });

  socket.on('player:answer', (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const p = players.get(socket.data.playerId);
    const q = currentQuestion();
    if (!p || game.phase !== 'question' || !q) return reply({ ok: false });
    if (game.answers.has(p.id)) return reply({ ok: false });
    const now = Date.now();
    if (now > game.endsAt + GRACE_MS) return reply({ ok: false, late: true });
    const choice = Number(data && data.choice);
    if (!Number.isInteger(choice) || choice < 1 || choice > q.options.length) return reply({ ok: false });
    game.answers.set(p.id, { choice, ms: Math.max(0, now - game.startedAt) });
    reply({ ok: true });
    const online = connectedPlayers();
    if (online.length > 0 && online.every((x) => game.answers.has(x.id))) endQuestion();
    else broadcast(false);
  });

  socket.on('player:leave', () => {
    const id = socket.data.playerId;
    if (id && players.has(id)) { players.delete(id); socket.data.playerId = null; broadcast(true); }
  });

  // ----- Presentador -----
  socket.on('host:auth', async (data, ack) => {
    if (typeof ack !== 'function') return;
    if (!data || String(data.pin) !== HOST_PIN) return ack({ ok: false, error: 'PIN incorrecto.' });
    socket.data.host = true;
    socket.join('hosts');
    try { await ensureJoinUrl(socket); } catch (e) { console.warn('[qr]', e.message); }
    ack({ ok: true });
    socket.emit('host:state', hostState());
  });

  const hostOnly = (fn) => (...args) => {
    const ack = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : () => {};
    if (!socket.data.host) return ack({ ok: false, error: 'No autorizado.' });
    try { fn(...args); } catch (e) { console.error(e); ack({ ok: false, error: 'Error del servidor.' }); }
  };

  socket.on('host:select', hostOnly((data, ack) => {
    if (game.phase !== 'lobby') return ack && ack({ ok: false, error: 'Termina la partida primero.' });
    if (!quizzes.has(data && data.id)) return ack && ack({ ok: false, error: 'Quiz no encontrado.' });
    game.quizId = data.id;
    broadcast(true);
    ack && ack({ ok: true });
  }));

  socket.on('host:start', hostOnly((data, ack) => {
    if (!currentQuiz()) return ack && ack({ ok: false, error: 'Elige un quiz.' });
    resetScores();
    startQuestion(0);
    ack && ack({ ok: true });
  }));

  socket.on('host:next', hostOnly((data, ack) => { next(); ack && ack({ ok: true }); }));
  socket.on('host:lobby', hostOnly((data, ack) => { backToLobby(); ack && ack({ ok: true }); }));

  socket.on('host:settings', hostOnly((data, ack) => {
    if (data && 'timeOverride' in data) {
      const t = Number(data.timeOverride);
      game.timeOverride = TIME_CHOICES.includes(t) ? t : null; // aplica desde la siguiente pregunta
    }
    if (!data || !('autoAdvance' in data)) { broadcast(true); return ack && ack({ ok: true }); }
    game.autoAdvance = !!data.autoAdvance;
    if (game.phase === 'reveal') {
      clearTimeout(advanceTimer);
      advanceTimer = null;
      game.revealEndsAt = 0;
      if (game.autoAdvance) {
        game.revealEndsAt = Date.now() + REVEAL_AUTO_MS;
        advanceTimer = setTimeout(next, REVEAL_AUTO_MS);
      }
    }
    broadcast(true);
    ack && ack({ ok: true });
  }));

  socket.on('host:kick', hostOnly((data, ack) => {
    const p = players.get(data && data.id);
    if (p) {
      if (p.socketId) io.to(p.socketId).emit('player:kicked');
      players.delete(p.id);
      game.answers.delete(p.id);
      broadcast(true);
    }
    ack && ack({ ok: true });
  }));

  socket.on('host:getQuiz', hostOnly((data, ack) => {
    const q = quizzes.get(data && data.id);
    ack(q ? { ok: true, quiz: q } : { ok: false, error: 'Quiz no encontrado.' });
  }));

  socket.on('host:saveQuiz', hostOnly((data, ack) => {
    const { quiz, error } = validateQuiz(data && data.quiz);
    if (error) return ack({ ok: false, error });
    if (data.originalId && data.originalId !== quiz.id && quizzes.has(data.originalId)) {
      // Cambió el título: conserva el id original para no duplicar.
      quiz.id = data.originalId;
    }
    if (!data.originalId) {
      let id = quiz.id, n = 2;
      while (quizzes.has(id)) id = `${quiz.id}-${n++}`;
      quiz.id = id;
    }
    if (game.phase !== 'lobby' && quiz.id === game.quizId) {
      return ack({ ok: false, error: 'No puedes editar el quiz que se está jugando.' });
    }
    quizzes.set(quiz.id, quiz);
    const saved = saveQuizFile(quiz);
    broadcast(true);
    ack({ ok: true, id: quiz.id, saved });
  }));

  socket.on('host:deleteQuiz', hostOnly((data, ack) => {
    const id = data && data.id;
    if (!quizzes.has(id)) return ack({ ok: false, error: 'Quiz no encontrado.' });
    if (game.quizId === id && game.phase !== 'lobby') return ack({ ok: false, error: 'Se está jugando.' });
    quizzes.delete(id);
    try { fs.unlinkSync(path.join(QUIZ_DIR, `${id}.json`)); } catch (e) { /* ya no existe */ }
    if (game.quizId === id) game.quizId = null;
    broadcast(true);
    ack({ ok: true });
  }));

  socket.on('host:reloadQuizzes', hostOnly((data, ack) => {
    loadQuizzes();
    if (game.quizId && !quizzes.has(game.quizId) && game.phase === 'lobby') game.quizId = null;
    broadcast(true);
    ack && ack({ ok: true });
  }));

  socket.on('host:csv', hostOnly((data, ack) => ack({ ok: true, csv: resultsCsv() })));

  socket.on('disconnect', () => {
    const p = players.get(socket.data.playerId);
    if (p && p.socketId === socket.id) {
      p.connected = false;
      p.socketId = null;
      if (game.phase === 'question') {
        const online = connectedPlayers();
        if (online.length > 0 && online.every((x) => game.answers.has(x.id))) return endQuestion();
      }
      broadcast(false);
    }
  });
});

server.listen(PORT, () => {
  const ip = lanAddress();
  console.log(`Owlquiz listo en http://localhost:${PORT}`);
  if (ip) console.log(`En tu red: http://${ip}:${PORT}  (presentador: /host)`);
  console.log(`Quizzes cargados: ${quizzes.size}. PIN del presentador: ${HOST_PIN === 'samsara' ? 'samsara (cámbialo con HOST_PIN)' : 'definido en HOST_PIN'}`);
});
