// Owlquiz — consola del presentador.
const SHAPES = [
  '<svg class="shape" viewBox="0 0 24 24"><path d="M12 2.5 22.5 20.5h-21z"/></svg>',
  '<svg class="shape" viewBox="0 0 24 24"><path d="M12 1.5 22.5 12 12 22.5 1.5 12z"/></svg>',
  '<svg class="shape" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10.5"/></svg>',
  '<svg class="shape" viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="2.5"/></svg>',
];
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n || 0).toLocaleString('es-MX');
const ss = {
  get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} },
  del(k) { try { sessionStorage.removeItem(k); } catch (e) {} },
};
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};

const socket = io({ transports: ['websocket', 'polling'] });
let authed = false;
let S = null; // último host:state
let offset = 0;
let staticKey = '';
let raf = null;
let lastSecond = null;
let soundOn = ls.get('shoot_sound') !== 'off';

function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 3200);
}

function call(event, data) {
  return new Promise((resolve) => socket.emit(event, data || {}, (res) => resolve(res || { ok: false })));
}

// ---------- Sonido ----------
let actx = null;
function audio() {
  if (!soundOn) return null;
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    return actx;
  } catch (e) { return null; }
}
function beep(freq, dur, type, vol) {
  const a = audio(); if (!a) return;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type || 'sine'; o.frequency.value = freq;
  g.gain.setValueAtTime(vol || 0.15, a.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
  o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + dur);
}
const sfx = {
  tick: () => beep(880, 0.08, 'square', 0.06),
  end: () => { beep(523, 0.18, 'triangle', 0.18); setTimeout(() => beep(392, 0.3, 'triangle', 0.18), 160); },
  start: () => { beep(523, 0.12, 'triangle'); setTimeout(() => beep(659, 0.12, 'triangle'), 110); setTimeout(() => beep(784, 0.2, 'triangle'), 220); },
  win: () => [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => beep(f, 0.25, 'triangle', 0.18), i * 140)),
};

// ---------- Conexión y PIN ----------
socket.on('connect', async () => {
  $('offline').classList.add('hidden');
  const pin = ss.get('shoot_pin');
  if (pin) await auth(pin, true);
});
socket.on('disconnect', () => $('offline').classList.remove('hidden'));

async function auth(pin, silent) {
  const res = await call('host:auth', { pin });
  if (!res.ok) {
    ss.del('shoot_pin');
    if (!silent) toast(res.error || 'PIN incorrecto.');
    show('sPin');
    return false;
  }
  ss.set('shoot_pin', pin);
  authed = true;
  $('controls').classList.remove('hidden');
  return true;
}
$('pinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  audio();
  auth($('pinInput').value.trim());
});

socket.on('host:state', (s) => {
  offset = s.serverNow - Date.now();
  const prev = S;
  S = s;
  render(prev);
});

// ---------- Render ----------
function show(id) {
  for (const sid of ['sPin', 'sLobby', 'sQuestion', 'sReveal', 'sFinal']) $(sid).classList.toggle('hidden', sid !== id);
}

function render(prev) {
  if (!authed || !S) return;
  $('tAuto').classList.toggle('on', !!S.autoAdvance);
  $('tSound').classList.toggle('on', soundOn);
  if (document.activeElement !== $('tTime')) $('tTime').value = S.timeOverride ? String(S.timeOverride) : '';
  $('tTime').parentElement.classList.toggle('on', !!S.timeOverride);
  $('tReset').classList.toggle('hidden', S.phase === 'lobby');
  const key = `${S.phase}|${S.qIndex}`;
  const changed = key !== staticKey;
  staticKey = key;
  if (S.phase === 'lobby') renderLobby();
  else if (S.phase === 'question') renderQuestion(changed);
  else if (S.phase === 'reveal') renderReveal(changed);
  else if (S.phase === 'final') renderFinal(changed);
  if (changed && prev) {
    if (S.phase === 'question') sfx.start();
    if (S.phase === 'reveal') sfx.end();
    if (S.phase === 'final') sfx.win();
  }
}

function renderLobby() {
  show('sLobby');
  stopTimer();
  if (S.qrDataUrl && $('qr').src !== S.qrDataUrl) $('qr').src = S.qrDataUrl;
  $('joinUrl').textContent = (S.joinUrl || '').replace(/^https?:\/\//, '');
  // Selector de quiz
  const sel = $('quizSelect');
  const opts = S.quizzes.map((q) => `<option value="${esc(q.id)}">${esc(q.title)} · ${q.count} preg.</option>`).join('');
  const html = S.quizzes.length ? opts : '<option value="">No hay quizzes — crea o importa uno</option>';
  if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
  if (S.quizId) sel.value = S.quizId;
  else if (S.quizzes.length) { sel.value = S.quizzes[0].id; call('host:select', { id: S.quizzes[0].id }); }
  $('startBtn').disabled = !S.quizId;
  // Jugadores
  const list = S.players;
  $('pCount').textContent = list.filter((p) => p.connected).length;
  $('pLabel').textContent = list.filter((p) => p.connected).length === 1 ? 'jugador' : 'jugadores';
  const box = $('players');
  const sig = list.map((p) => p.id + p.name + p.connected).join(',');
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    box.innerHTML = list.length ? list.map((p) =>
      `<button class="pchip ${p.connected ? '' : 'off'}" data-id="${esc(p.id)}" title="Sacar a ${esc(p.name)}">${esc(p.name)}</button>`).join('')
      : '<span class="muted">Esperando jugadores… escanea el QR con tu celular.</span>';
    box.querySelectorAll('.pchip').forEach((b) => b.addEventListener('click', () => {
      if (confirm(`¿Sacar a ${b.textContent} del juego?`)) call('host:kick', { id: b.dataset.id });
    }));
  }
}

function optHtml(o, i, extra) {
  return `<div class="opt opt-${i} ${extra || ''}">${SHAPES[i]}<span>${esc(o)}</span></div>`;
}

function renderQuestion(changed) {
  show('sQuestion');
  const q = S.question;
  if (changed) {
    $('qNum').textContent = `Pregunta ${S.qIndex + 1} de ${S.total}`;
    $('qQuiz').textContent = S.quizTitle;
    $('qText').textContent = q.text;
    $('qOpts').innerHTML = q.options.map((o, i) => optHtml(o, i)).join('');
    lastSecond = null;
    startTimer();
  }
  $('answered').textContent = `${S.answeredCount}/${S.playerCount}`;
}

function renderReveal(changed) {
  show('sReveal');
  stopTimer();
  const q = S.question, r = S.reveal;
  $('rNum').textContent = `Pregunta ${S.qIndex + 1} de ${S.total}`;
  $('nextBtn').textContent = S.isLast ? 'Ver resultados 🏆' : 'Siguiente ▶';
  if (changed) {
    $('rText').textContent = q.text;
    const max = Math.max(1, ...r.counts);
    $('rOpts').innerHTML = q.options.map((o, i) => {
      const ok = i + 1 === r.answer;
      return `<div class="opt opt-${i} ${ok ? '' : 'dim'}" style="padding:1.6vh 24px">
        ${SHAPES[i]}
        <div class="bar-row" style="flex:1"><span>${esc(o)}</span><div class="bar-track"><div data-w="${(r.counts[i] / max) * 100}"></div></div></div>
        <span class="cnt">${r.counts[i]}${ok ? ' ✓' : ''}</span></div>`;
    }).join('');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      $('rOpts').querySelectorAll('[data-w]').forEach((d) => { d.style.width = d.dataset.w + '%'; });
    }));
    $('lb').innerHTML = S.leaderboard.length ? S.leaderboard.map((p) => `
      <div class="lb-row"><span class="r">${p.rank}</span><span class="n">${esc(p.name)}${p.streak >= 3 ? ' 🔥' : ''}</span>
      ${p.gained ? `<span class="g">+${fmt(p.gained)}</span>` : ''}<span>${fmt(p.score)}</span></div>`).join('')
      : '<span class="muted">Nadie jugó esta pregunta.</span>';
  }
  updateAutoLabel();
}

function updateAutoLabel() {
  if (S && S.phase === 'reveal' && S.revealEndsAt) {
    const left = Math.max(0, Math.ceil((S.revealEndsAt - (Date.now() + offset)) / 1000));
    $('rAuto').textContent = `Siguiente en ${left} s`;
    clearTimeout(updateAutoLabel._t);
    updateAutoLabel._t = setTimeout(updateAutoLabel, 250);
  } else $('rAuto').textContent = '';
}

function renderFinal(changed) {
  show('sFinal');
  stopTimer();
  if (!changed && $('allList').dataset.done) return;
  const top = S.leaderboard;
  const order = [1, 0, 2].filter((i) => top[i]);
  $('podium').innerHTML = order.map((i) => `
    <div class="step p${i + 1}"><div class="who">${esc(top[i].name)}</div><div class="pts">${fmt(top[i].score)} pts</div>
    <div class="block">${i + 1}</div></div>`).join('') || '<p class="muted">Nadie jugó.</p>';
  $('allList').innerHTML = S.fullLeaderboard.map((p) => `
    <div class="all-row"><span>${p.rank}.</span><span class="n">${esc(p.name)}</span><span class="muted">${p.correct} ✓</span><span>${fmt(p.score)}</span></div>`).join('');
  $('allList').dataset.done = '1';
}

// ---------- Temporizador ----------
function startTimer() {
  stopTimer();
  const tick = () => {
    if (!S || S.phase !== 'question') return;
    const total = S.question.time * 1000;
    const left = Math.max(0, S.endsAt - (Date.now() + offset));
    const sec = Math.ceil(left / 1000);
    $('timerNum').textContent = sec;
    $('timer').style.setProperty('--p', `${(left / total) * 100}%`);
    if (sec !== lastSecond) { if (lastSecond !== null && sec <= 5 && sec > 0) sfx.tick(); lastSecond = sec; }
    raf = requestAnimationFrame(tick);
  };
  tick();
}
function stopTimer() { if (raf) cancelAnimationFrame(raf); raf = null; }

// ---------- Controles ----------
$('quizSelect').addEventListener('change', async (e) => {
  const res = await call('host:select', { id: e.target.value });
  if (!res.ok) toast(res.error);
});
$('startBtn').addEventListener('click', async () => {
  audio();
  if (!S || !S.players.some((p) => p.connected) && !confirm('No hay jugadores conectados. ¿Iniciar de todos modos?')) return;
  const res = await call('host:start');
  if (!res.ok) toast(res.error);
});
$('endQ').addEventListener('click', () => call('host:next'));
$('nextBtn').addEventListener('click', () => call('host:next'));
$('lobbyBtn').addEventListener('click', () => { $('allList').dataset.done = ''; call('host:lobby'); });
$('csvBtn').addEventListener('click', async () => {
  const res = await call('host:csv');
  if (!res.ok) return toast('No se pudo generar el CSV.');
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  download(`${date}-owlquiz-resultados.csv`, res.csv, 'text/csv;charset=utf-8');
});
$('tTime').addEventListener('change', async (e) => {
  const v = e.target.value ? Number(e.target.value) : null;
  await call('host:settings', { timeOverride: v });
  if (S && S.phase === 'question') toast('El nuevo tiempo aplica desde la siguiente pregunta.');
  e.target.blur();
});
$('tReset').addEventListener('click', () => {
  if (!confirm('¿Reiniciar el juego? Se borran los puntos y todos vuelven a la sala de espera.')) return;
  $('allList').dataset.done = '';
  call('host:lobby');
});
$('tAuto').addEventListener('click',() => call('host:settings', { autoAdvance: !(S && S.autoAdvance) }));
$('tSound').addEventListener('click', () => {
  soundOn = !soundOn; ls.set('shoot_sound', soundOn ? 'on' : 'off');
  $('tSound').classList.toggle('on', soundOn);
  if (soundOn) sfx.tick();
});
$('tFull').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
});
document.addEventListener('fullscreenchange', () => $('tFull').classList.toggle('on', !!document.fullscreenElement));

document.addEventListener('keydown', (e) => {
  if (!authed || !S || !$('editor').classList.contains('hidden')) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (['input', 'textarea', 'select'].includes(tag)) return;
  if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') {
    e.preventDefault();
    if (S.phase === 'lobby') $('startBtn').click();
    else if (S.phase === 'question' || S.phase === 'reveal') call('host:next');
  }
});

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- Editor de quizzes ----------
const panel = $('panel');
$('openEditor').addEventListener('click', () => { $('editor').classList.remove('hidden'); editorList(); });
$('editor').addEventListener('click', (e) => { if (e.target.id === 'editor') closeEditor(); });
function closeEditor() { $('editor').classList.add('hidden'); }

const FORMAT_HELP = `<div class="help"><b>Formato JSON</b> (para importar o pedirle a Claude):<br>
<code>{"title": "Mi quiz", "questions": [{"text": "¿Pregunta?", "options": ["A","B","C","D"], "answer": 2, "time": 10}]}</code><br>
<code>answer</code> = número de la opción correcta (1 = primera). <code>time</code> en segundos (5–120, default 10). De 2 a 4 opciones.
También puedes pegar una lista <code>[ {...}, {...} ]</code> con varios quizzes.</div>`;

function editorList() {
  const list = (S && S.quizzes) || [];
  panel.innerHTML = `
    <div class="panel-head"><h2>Quizzes</h2>
      <div class="setup-row">
        <button class="btn btn-sm btn-ghost" id="eReload" title="Volver a leer la carpeta quizzes">Recargar carpeta</button>
        <button class="btn btn-sm btn-ghost" id="eImport">Importar JSON</button>
        <button class="btn btn-sm btn-yellow" id="eNew">+ Nuevo quiz</button>
        <button class="btn btn-sm" id="eClose">Cerrar</button>
      </div></div>
    ${list.length ? list.map((q) => `
      <div class="qz-row"><span class="t">${esc(q.title)} <span class="muted">· ${q.count} preguntas</span></span>
        <button class="btn btn-sm btn-ghost" data-a="edit" data-id="${esc(q.id)}">Editar</button>
        <button class="btn btn-sm btn-ghost" data-a="dup" data-id="${esc(q.id)}">Duplicar</button>
        <button class="btn btn-sm btn-ghost" data-a="exp" data-id="${esc(q.id)}">Exportar</button>
        <button class="btn btn-sm btn-danger" data-a="del" data-id="${esc(q.id)}">Borrar</button></div>`).join('')
      : '<p class="muted">Aún no hay quizzes.</p>'}
    ${FORMAT_HELP}`;
  $('eClose').onclick = closeEditor;
  $('eNew').onclick = () => editorForm(null, { title: '', questions: [blankQ()] });
  $('eImport').onclick = editorImport;
  $('eReload').onclick = async () => { await call('host:reloadQuizzes'); setTimeout(editorList, 200); toast('Carpeta recargada.'); };
  panel.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.id, a = b.dataset.a;
    if (a === 'del') {
      if (!confirm('¿Borrar este quiz? No se puede deshacer.')) return;
      const r = await call('host:deleteQuiz', { id });
      if (!r.ok) return toast(r.error);
      setTimeout(editorList, 150);
      return;
    }
    const r = await call('host:getQuiz', { id });
    if (!r.ok) return toast(r.error);
    if (a === 'edit') editorForm(id, r.quiz);
    if (a === 'dup') {
      const copy = { title: `${r.quiz.title} (copia)`, questions: r.quiz.questions };
      const s = await call('host:saveQuiz', { quiz: copy });
      if (!s.ok) return toast(s.error);
      toast('Quiz duplicado.'); setTimeout(editorList, 150);
    }
    if (a === 'exp') {
      const { id: _id, ...body } = r.quiz;
      download(`${id}.json`, JSON.stringify(body, null, 2), 'application/json');
    }
  }));
}

function blankQ() { return { text: '', options: ['', '', '', ''], answer: 1, time: 10 }; }

function editorForm(originalId, quiz) {
  const draft = JSON.parse(JSON.stringify(quiz));
  draft.questions = draft.questions.map((q) => ({ ...q, options: [...q.options, '', '', '', ''].slice(0, 4) }));
  const draw = () => {
    panel.innerHTML = `
      <div class="panel-head"><h2>${originalId ? 'Editar quiz' : 'Nuevo quiz'}</h2>
        <div class="setup-row"><button class="btn btn-sm btn-ghost" id="fCancel">Cancelar</button>
        <button class="btn btn-sm btn-yellow" id="fSave">Guardar</button></div></div>
      <input type="text" id="fTitle" placeholder="Título del quiz" value="${esc(draft.title)}" style="font-size:20px;font-weight:800">
      ${draft.questions.map((q, qi) => `
        <div class="qcard" data-qi="${qi}">
          <div class="qcard-head"><span>Pregunta ${qi + 1}</span>
            <div class="setup-row">
              <span class="time-in">Tiempo <input type="number" min="5" max="120" data-f="time" value="${q.time}"> s</span>
              <button class="btn btn-sm btn-ghost" data-m="up" ${qi === 0 ? 'disabled' : ''}>↑</button>
              <button class="btn btn-sm btn-ghost" data-m="down" ${qi === draft.questions.length - 1 ? 'disabled' : ''}>↓</button>
              <button class="btn btn-sm btn-danger" data-m="del" ${draft.questions.length === 1 ? 'disabled' : ''}>✕</button>
            </div></div>
          <textarea data-f="text" placeholder="Escribe la pregunta">${esc(q.text)}</textarea>
          <div class="opt-edit">${q.options.map((o, oi) => `
            <div class="opt-in opt-${oi}"><span class="sw">${SHAPES[oi]}</span>
              <input type="text" data-o="${oi}" placeholder="Opción ${oi + 1}${oi > 1 ? ' (opcional)' : ''}" value="${esc(o)}">
              <label><input type="radio" name="ans${qi}" data-a="${oi + 1}" ${q.answer === oi + 1 ? 'checked' : ''}> correcta</label>
            </div>`).join('')}</div>
        </div>`).join('')}
      <button class="btn btn-ghost" id="fAdd">+ Agregar pregunta</button>`;
    $('fCancel').onclick = editorList;
    $('fAdd').onclick = () => { collect(); draft.questions.push(blankQ()); draw(); };
    $('fSave').onclick = save;
    panel.querySelectorAll('[data-m]').forEach((b) => b.addEventListener('click', () => {
      collect();
      const qi = Number(b.closest('.qcard').dataset.qi), qs = draft.questions;
      if (b.dataset.m === 'del') qs.splice(qi, 1);
      if (b.dataset.m === 'up') [qs[qi - 1], qs[qi]] = [qs[qi], qs[qi - 1]];
      if (b.dataset.m === 'down') [qs[qi + 1], qs[qi]] = [qs[qi], qs[qi + 1]];
      draw();
    }));
  };
  const collect = () => {
    draft.title = $('fTitle').value;
    panel.querySelectorAll('.qcard').forEach((c) => {
      const q = draft.questions[Number(c.dataset.qi)];
      q.text = c.querySelector('[data-f=text]').value;
      q.time = Number(c.querySelector('[data-f=time]').value) || 10;
      q.options = [...c.querySelectorAll('[data-o]')].map((i) => i.value);
      const r = c.querySelector('[data-a]:checked');
      q.answer = r ? Number(r.dataset.a) : 1;
    });
  };
  const save = async () => {
    collect();
    // Quita opciones vacías y ajusta la respuesta correcta.
    const out = { title: draft.title.trim(), questions: [] };
    for (let i = 0; i < draft.questions.length; i++) {
      const q = draft.questions[i];
      const filled = q.options.map((t, idx) => ({ t: t.trim(), idx: idx + 1 })).filter((o) => o.t);
      const ans = filled.findIndex((o) => o.idx === q.answer);
      if (ans === -1) return toast(`Pregunta ${i + 1}: la respuesta correcta está vacía.`);
      out.questions.push({ text: q.text, options: filled.map((o) => o.t), answer: ans + 1, time: q.time });
    }
    const r = await call('host:saveQuiz', { quiz: out, originalId });
    if (!r.ok) return toast(r.error);
    toast(r.saved ? 'Quiz guardado.' : 'Guardado en memoria (no se pudo escribir el archivo).');
    if (S && S.phase === 'lobby') call('host:select', { id: r.id });
    setTimeout(editorList, 150);
  };
  draw();
}

function editorImport() {
  panel.innerHTML = `
    <div class="panel-head"><h2>Importar JSON</h2>
      <div class="setup-row"><button class="btn btn-sm btn-ghost" id="iCancel">Cancelar</button>
      <button class="btn btn-sm btn-yellow" id="iSave">Importar</button></div></div>
    <input type="file" id="iFile" accept=".json,application/json">
    <textarea class="json" id="iText" placeholder="Pega aquí el JSON que te dio Claude"></textarea>
    ${FORMAT_HELP}`;
  $('iCancel').onclick = editorList;
  $('iFile').onchange = async (e) => { const f = e.target.files[0]; if (f) $('iText').value = await f.text(); };
  $('iSave').onclick = async () => {
    let data;
    const raw = $('iText').value.trim().replace(/^```(?:json)?\s*|```$/g, '');
    try { data = JSON.parse(raw); } catch (e) { return toast('JSON inválido: revisa comas y comillas.'); }
    const items = Array.isArray(data) ? data : [data];
    let ok = 0;
    for (const quiz of items) {
      const r = await call('host:saveQuiz', { quiz });
      if (!r.ok) { toast(`“${(quiz && quiz.title) || 'sin título'}”: ${r.error}`); return; }
      ok++;
      if (S && S.phase === 'lobby') call('host:select', { id: r.id });
    }
    toast(`${ok} ${ok === 1 ? 'quiz importado' : 'quizzes importados'}.`);
    setTimeout(editorList, 150);
  };
}
