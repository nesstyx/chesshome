#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
//  broadcast-pusher.js — мост Lichess → ChessHome
// ═══════════════════════════════════════════════════════════════════
// Запускается на ПК с доступом в интернет (Node >= 18, без зависимостей).
// Опрашивает PGN трансляции на lichess.org и отправляет его на сервер
// ChessHome. Сам сервер в lichess НЕ ходит (исходящих запросов нет).
//
// Перед запуском создайте трансляцию в админке на сайте и укажите там
// ссылку на раунд lichess ( round_id должен совпадать с --lichess ).
//
// Запуск:
//   node scripts/broadcast-pusher.js \
//     --lichess "https://lichess.org/broadcast/fide-world-chess-championship-2026/game-1/xLgOJ6cb" \
//     --site https://chesshome.pro \
//     --key СЕКРЕТНЫЙ_КЛЮЧ
//
// Или через переменные окружения (BROADCAST_ROUND_ID / BROADCAST_SITE /
// BROADCAST_PUSH_KEY) — тогда аргументы не нужны.
//
// Остановить: Ctrl+C.
// ═══════════════════════════════════════════════════════════════════

'use strict';

// ── аргументы ──────────────────────────────────────────────────────
function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return (i !== -1 && process.argv[i + 1]) ? process.argv[i + 1] : null;
}

const lichessInput = arg('lichess') || arg('round') || process.env.BROADCAST_ROUND_ID || null;
const SITE         = (arg('site')     || process.env.BROADCAST_SITE     || '').replace(/\/+$/, '');
const KEY          = arg('key')       || process.env.BROADCAST_PUSH_KEY || null;
let INTERVAL       = parseInt(arg('interval') || '', 10) || 2500;

if (!lichessInput || !SITE || !KEY) {
  console.error(`
Не хватает параметров. Пример:
  node scripts/broadcast-pusher.js \\
    --lichess "https://lichess.org/broadcast/fide-world-chess-championship-2026/game-1/xLgOJ6cb" \\
    --site https://chesshome.pro \\
    --key СЕКРЕТНЫЙ_КЛЮЧ

Или задайте переменные окружения BROADCAST_ROUND_ID, BROADCAST_SITE, BROADCAST_PUSH_KEY.`);
  process.exit(1);
}

// ID раунда = последний сегмент ссылки без #хэша и ?query
function extractRoundId(input) {
  const clean = String(input).split('#')[0].split('?')[0].replace(/\/+$/, '');
  const seg = clean.substring(clean.lastIndexOf('/') + 1);
  return /^[A-Za-z0-9]{4,16}$/.test(seg) ? seg : null;
}

const ROUND_ID = extractRoundId(lichessInput);
if (!ROUND_ID) {
  console.error('Не удалось извлечь ID раунда из "' + lichessInput + '"');
  process.exit(1);
}

const PGN_URL = `https://lichess.org/api/broadcast/round/${ROUND_ID}.pgn?clocks=true&evals=true`;

// ── лог ────────────────────────────────────────────────────────────
function log(msg) {
  const t = new Date().toLocaleTimeString('ru-RU', { hour12: false });
  console.log(`[${t}] ${msg}`);
}

// ── fetch с таймаутом ──────────────────────────────────────────────
function fetchTimeout(url, opts = {}, ms = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// ── основной цикл ──────────────────────────────────────────────────
let lastPgn = null;          // последний отправленный PGN
let consecutiveErrors = 0;   // подряд (для бэкоффа)

async function tick() {
  let delay = INTERVAL;

  try {
    // 1. Забираем PGN с lichess
    const r = await fetchTimeout(PGN_URL, { headers: { Accept: 'application/x-chess-pgn' } });
    if (r.status === 429) throw new Error('lichess: rate limit (429), замедляюсь');
    if (!r.ok) throw new Error(`lichess: HTTP ${r.status}`);
    const pgn = await r.text();
    if (!pgn.includes('[Event')) throw new Error('lichess: пустой PGN');

    // 2. Отправляем на сайт только если что-то изменилось
    if (pgn !== lastPgn) {
      const pr = await fetchTimeout(`${SITE}/api/broadcasts/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-broadcast-key': KEY },
        body: JSON.stringify({ roundId: ROUND_ID, pgn }),
      });

      if (pr.status === 403) {
        log('ФАТАЛЬНО: сервер отклонил ключ (403). Проверьте BROADCAST_PUSH_KEY на сервере и --key.');
        process.exit(1);
      }
      if (pr.status === 404) {
        log('Сервер: нет трансляции с roundId=' + ROUND_ID +
            '. Создайте её в админке /broadcasts (укажите ссылку на этот раунд lichess).');
      } else if (!pr.ok) {
        throw new Error(`сайт: HTTP ${pr.status}`);
      } else {
        const body = await pr.json().catch(() => ({}));
        const plies = body.plies != null ? body.plies : '?';
        log(`Отправлено на сайт: ходов ${plies}${lastPgn === null ? ' (первая загрузка)' : ''}`);
      }
      lastPgn = pgn;
    }

    consecutiveErrors = 0;
  } catch (e) {
    consecutiveErrors++;
    // Логируем первую ошибку серии и каждую 10-ю, не спамим.
    if (consecutiveErrors === 1 || consecutiveErrors % 10 === 0) {
      log(`Ошибка (серия ${consecutiveErrors}): ${e.message || e}`);
    }
    // Бэкофф: до 5x интервала (максимум 60с). При 429 lichess — сильнее.
    delay = Math.min(INTERVAL * Math.min(consecutiveErrors, 5) * (String(e.message).includes('429') ? 2 : 1), 60000);
  }

  setTimeout(tick, delay);
}

log(`Мост запущен: раунд ${ROUND_ID}`);
log(`Lichess:  ${PGN_URL}`);
log(`Сайт:     ${SITE}/api/broadcasts/push  (интервал ${INTERVAL} мс)`);
tick();

// Корректное завершение
process.on('SIGINT',  () => { log('Остановлено (Ctrl+C)'); process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
