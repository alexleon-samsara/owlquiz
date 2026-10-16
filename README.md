# Samsarahoot

Juego de preguntas en vivo para presentaciones. Tú proyectas la pantalla del presentador; la gente escanea el QR con su celular, escribe su nombre y juega. Nadie necesita cuenta ni app.

- Presentador: `https://TU-URL/host` (pide PIN)
- Jugadores: `https://TU-URL/` (el QR lleva aquí)

---

## Opción A · Publicarlo en internet (recomendado)

Así funciona con los datos del celular o con cualquier Wi-Fi. Gratis en Render.

1. Crea un repositorio en GitHub y sube esta carpeta completa.
2. Entra a [render.com](https://render.com) con tu cuenta de GitHub.
3. **New → Blueprint** → elige el repositorio. Render lee `render.yaml`.
4. Te pide `HOST_PIN`: escribe el PIN que usarás para abrir la consola.
5. **Apply**. En 2–3 minutos te da una URL, por ejemplo `https://samsarahoot.onrender.com`.
6. Abre `https://samsarahoot.onrender.com/host`, escribe tu PIN y listo.

**Importante en el plan gratis:**
- Se duerme tras 15 minutos sin uso. Abre `/host` **1–2 minutos antes** de presentar para despertarlo.
- Los quizzes que creas o editas desde la app se borran cuando el servidor se reinicia. Para que queden fijos, usa **Exportar** y sube el `.json` a la carpeta `quizzes/` del repositorio. Render vuelve a publicar solo.

## Opción B · Correrlo en tu laptop

Sirve si tú y los jugadores están en la misma red Wi-Fi.

1. Instala [Node.js](https://nodejs.org) (versión 18 o más reciente).
2. Abre una terminal en esta carpeta y corre:
   ```
   npm install
   HOST_PIN=tu-pin npm start
   ```
   En Windows (PowerShell): `$env:HOST_PIN="tu-pin"; npm start`
3. Abre `http://localhost:3000/host`. El QR usa la IP de tu laptop en la red.

Si los celulares no abren el link, la red bloquea conexiones entre equipos (pasa en Wi-Fi corporativo y de invitados). Usa la Opción A.

PIN por defecto si no defines `HOST_PIN`: `samsara`. Cámbialo.

---

## Durante la presentación

1. Abre `/host` → PIN → elige el quiz.
2. Proyecta la pantalla. La gente escanea el QR y escribe su nombre.
3. **Iniciar juego**. Cada pregunta corre su tiempo (10 s por defecto) o se cierra sola cuando todos respondieron.
4. Se muestra la respuesta correcta, los votos por opción y el Top 5.
5. **Siguiente** hasta el podio final. **Exportar CSV** guarda quién respondió qué y en cuánto tiempo.

Atajos: **Espacio / Enter / →** = siguiente. Arriba: avance automático, sonido y pantalla completa.
Toca un nombre en la sala para sacar a alguien.

Puntos: correcto = hasta 1000, según la rapidez (mínimo 500). Incorrecto o sin respuesta = 0.

---

## Agregar preguntas con Claude

Pídele a Claude algo así:

> Crea un quiz para Samsarahoot sobre [tema] con [N] preguntas de 4 opciones y 10 segundos cada una. Dame solo el JSON con este formato:
> `{"title": "...", "questions": [{"text": "...", "options": ["...", "...", "...", "..."], "answer": 1, "time": 10}]}`
> `answer` es el número de la opción correcta (1 = primera).

Luego:
- **Rápido:** en `/host` → **Editar quizzes → Importar JSON** → pega el JSON → **Importar**.
- **Permanente:** guarda el JSON como archivo en `quizzes/` (por ejemplo `quizzes/2026-11-01-mi-tema.json`) y súbelo al repositorio. Si el servidor ya está corriendo, usa **Recargar carpeta**.

Reglas del formato:
- De 2 a 4 opciones por pregunta.
- `time` entre 5 y 120 segundos. Si no lo pones, usa 10.
- Puedes pegar varios quizzes juntos: `[ {...}, {...} ]`.

También puedes crear y editar todo a mano desde **Editar quizzes**.

---

## Archivos

| Archivo | Qué hace |
| --- | --- |
| `server.js` | Servidor del juego (tiempos, puntos, jugadores) |
| `public/host.html`, `public/host.js` | Pantalla del presentador y editor de quizzes |
| `public/index.html` | Pantalla del jugador en el celular |
| `quizzes/*.json` | Quizzes guardados |
| `render.yaml` | Configuración para publicar en Render |
