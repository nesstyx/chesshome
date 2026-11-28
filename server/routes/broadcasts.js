// routes/broadcasts.js — трансляции сторонних соревнований (lichess broadcasts)
//
// СХЕМА: сервер НЕ ходит в lichess (исходящих запросов нет). Скрипт
// scripts/broadcast-pusher.js запускается на любом ПК с интернетом,
// опрашивает PGN трансляции на lichess.org и пушит его сюда
// (POST /api/broadcasts/push с ключом BROADCAST_PUSH_KEY в заголовке
// x-broadcast-key — по образцу durka.js).
//
// Страницы:  /broadcasts        — список ТУРНИРОВ (+ форма добавления для админов)
//            /broadcasts/t/:id  — страница турнира (список его партий)
//            /broadcasts/:id    — партия на весь экран
// API:       GET  /api/broadcasts          — список (без PGN), ?tournament=<id> — фильтр
//            GET  /api/broadcasts/:id      — детали + свежий PGN (поллинг фронтенда)
//            POST /api/broadcasts          — создать трансляцию (только admin), можно с tournamentId
//            POST /api/broadcasts/:id/delete — удалить трансляцию (только admin)
//            POST /api/broadcasts/:id/set-tournament — привязать/отвязать партию к турниру (только admin)
//            POST /api/broadcasts/push     — приём PGN от скрипта на ПК (по ключу)
// Турниры (группы партий):
//            GET  /api/broadcast-tournaments          — список турниров со сводным статусом
//            POST /api/broadcast-tournaments          — создать турнир (только admin)
//            POST /api/broadcast-tournaments/:id/delete — удалить турнир ВМЕСТЕ с его партиями (только admin)
// Чат трансляции:
//            GET  /api/broadcasts/:id/chat          — последние сообщения (?after=ts — инкрементально)
//            POST /api/broadcasts/:id/chat          — написать (только авторизованные)
//            POST /api/broadcasts/:id/chat/:mid/delete — удалить сообщение (админ или автор)

const {
  db,
  app,
  path,
  uuidv4,
  sendVersionedHtml,
  limiterStrict,
  rateLimit,
  safeSecretEqual,
  authMiddleware,
  requireAdmin,
} = require('../core');

module.exports = function register(app) {

// ── Таблицы (идемпотентно, при старте, СТРОГО последовательно —
//    broadcast_pgn ссылается на broadcasts через FK) ───────────────
(async () => {
  try {
    // Турниры — группы партий. Удаляется турнир → каскадом удаляются его
    // партии (FK ниже), а вместе с партиями — их PGN и чат (CASCADE там).
    await db(`
      CREATE TABLE IF NOT EXISTS broadcast_tournaments (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        description  TEXT,
        starts_at    BIGINT NOT NULL DEFAULT 0,
        created_by   TEXT,
        created_at   BIGINT NOT NULL,
        updated_at   BIGINT NOT NULL
      )
    `);
    await db(`
      CREATE TABLE IF NOT EXISTS broadcasts (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        description   TEXT,
        starts_at     BIGINT NOT NULL DEFAULT 0,
        round_id      TEXT,
        source_url    TEXT,
        tournament_id TEXT REFERENCES broadcast_tournaments(id) ON DELETE CASCADE,
        created_by    TEXT,
        created_at    BIGINT NOT NULL,
        updated_at    BIGINT NOT NULL
      )
    `);
    // Для БД, созданных до появления турниров: добавляем колонку (идемпотентно).
    await db(`
      ALTER TABLE broadcasts
      ADD COLUMN IF NOT EXISTS tournament_id
      TEXT REFERENCES broadcast_tournaments(id) ON DELETE CASCADE
    `);
    await db(`
      CREATE TABLE IF NOT EXISTS broadcast_pgn (
        broadcast_id TEXT PRIMARY KEY REFERENCES broadcasts(id) ON DELETE CASCADE,
        pgn          TEXT NOT NULL,
        result       TEXT,
        white        TEXT,
        black        TEXT,
        plies        INT NOT NULL DEFAULT 0,
        updated_at   BIGINT NOT NULL
      )
    `);
    await db(`
      CREATE TABLE IF NOT EXISTS broadcast_chat (
        id           TEXT PRIMARY KEY,
        broadcast_id TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
        user_id      TEXT NOT NULL,
        username     TEXT NOT NULL,
        text         TEXT NOT NULL,
        created_at   BIGINT NOT NULL
      )
    `);
    await db(`CREATE INDEX IF NOT EXISTS idx_broadcast_chat ON broadcast_chat (broadcast_id, created_at)`);
  } catch (e) {
    console.error('[Broadcasts] create tables:', e.message);
  }
})();

// ── Хелперы ────────────────────────────────────────────────────────

// Из ссылки вида https://lichess.org/broadcast/<slug>/<round>/<id>#boards
// берём последний сегмент — это ID раунда для API lichess.
function extractRoundId(input) {
  const clean = String(input || '').split('#')[0].split('?')[0].replace(/\/+$/, '');
  const seg = clean.substring(clean.lastIndexOf('/') + 1);
  return /^[A-Za-z0-9]{4,16}$/.test(seg) ? seg : null;
}

// Быстрые метаданные PGN без полного парсинга: теги + число ходов.
function pgnMeta(pgn) {
  const tag = (name) => {
    const m = pgn.match(new RegExp('\\[' + name + ' "([^"]*)"\\]'));
    return m ? m[1] : null;
  };
  // lichess пишет [%clk ...] после каждого хода — считаем их.
  let plies = (pgn.match(/\[%clk/g) || []).length;
  if (!plies) {
    // Fallback: считаем SAN-токены в movetext без комментариев.
    const movetext = pgn.replace(/\[[^\]]*\]\s*/g, ' ').replace(/\{[^}]*\}/g, ' ');
    const tokens = movetext.trim().split(/\s+/).filter(Boolean);
    plies = 0;
    for (const t of tokens) {
      if (/^(\d+)\.*$/.test(t)) continue;
      if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t)) continue;
      plies++;
    }
  }
  return { result: tag('Result'), white: tag('White'), black: tag('Black'), plies };
}

// Статус трансляции: upcoming → live/paused → finished.
function broadcastStatus(row) {
  const now = Date.now();
  if (!row.pgn_updated_at) return (Number(row.starts_at) > now) ? 'upcoming' : 'pending';
  if (row.result && row.result !== '*') return 'finished';
  return (now - Number(row.pgn_updated_at)) < 15 * 60 * 1000 ? 'live' : 'paused';
}

function rowToBroadcast(row, withPgn) {
  const b = {
    id: row.id,
    name: row.name,
    description: row.description || '',
    startsAt: Number(row.starts_at) || 0,
    roundId: row.round_id || null,
    sourceUrl: row.source_url || null,
    tournamentId: row.tournament_id || null,
    tournamentName: row.t_name || null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    status: broadcastStatus(row),
    result: row.result || null,
    white: row.white || null,
    black: row.black || null,
    plies: Number(row.plies) || 0,
    lastMoveAt: row.pgn_updated_at ? Number(row.pgn_updated_at) : null,
  };
  if (withPgn) b.pgn = row.pgn;
  return b;
}

const LIST_SQL = `
  SELECT b.id, b.name, b.description, b.starts_at, b.round_id, b.source_url,
         b.tournament_id, t.name AS t_name,
         b.created_at, b.updated_at,
         p.pgn, p.result, p.white, p.black, p.plies, p.updated_at AS pgn_updated_at
  FROM broadcasts b
  LEFT JOIN broadcast_tournaments t ON t.id = b.tournament_id
  LEFT JOIN broadcast_pgn p ON p.broadcast_id = b.id
`;

// ── API: список ТУРНИРОВ со сводным статусом ───────────────────────
// Статус турнира выводится из статусов его партий:
// live > paused > finished/unfinished миксы и т.д. (см. ниже).
function tournamentStatus(games, startsAt) {
  if (!games.length) return (startsAt > Date.now()) ? 'upcoming' : 'pending';
  if (games.some(g => g.status === 'live')) return 'live';
  if (games.every(g => g.status === 'finished')) return 'finished';
  if (games.some(g => g.status === 'paused')) return 'paused';
  if (games.some(g => g.status === 'upcoming')) return 'upcoming';
  return 'pending';
}

app.get('/api/broadcast-tournaments', async (req, res) => {
  try {
    const r = await db(`
      SELECT t.id, t.name, t.description, t.starts_at, t.created_at, t.updated_at,
             b.id AS b_id, b.starts_at AS b_starts_at, b.created_at AS b_created_at,
             p.result, p.white, p.black, p.updated_at AS pgn_updated_at
      FROM broadcast_tournaments t
      LEFT JOIN broadcasts b ON b.tournament_id = t.id
      LEFT JOIN broadcast_pgn p ON p.broadcast_id = b.id
      ORDER BY t.starts_at DESC, t.created_at DESC, b.starts_at ASC
    `);
    const map = new Map();
    for (const row of r.rows) {
      let t = map.get(row.id);
      if (!t) {
        t = {
          id: row.id, name: row.name, description: row.description || '',
          startsAt: Number(row.starts_at) || 0,
          createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
          games: [],
        };
        map.set(row.id, t);
      }
      if (row.b_id) {
        t.games.push({
          status: broadcastStatus({
            pgn_updated_at: row.pgn_updated_at,
            starts_at: row.b_starts_at,
            result: row.result,
          }),
          white: row.white || null,
          black: row.black || null,
          result: row.result || null,
          pgnUpdatedAt: row.pgn_updated_at ? Number(row.pgn_updated_at) : null,
        });
      }
    }
    const out = [...map.values()].map(t => {
      const g = t.games;
      const withPlayers = g
        .filter(x => x.white || x.black)
        .sort((a, b) => (b.pgnUpdatedAt || 0) - (a.pgnUpdatedAt || 0))[0] || null;
      const lastMoveAt = g.reduce((acc, x) => Math.max(acc || 0, x.pgnUpdatedAt || 0), 0) || null;
      return {
        id: t.id,
        name: t.name,
        description: t.description,
        startsAt: t.startsAt,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        status: tournamentStatus(g, t.startsAt),
        gamesCount: g.length,
        liveCount: g.filter(x => x.status === 'live' || x.status === 'paused').length,
        finishedCount: g.filter(x => x.status === 'finished').length,
        players: withPlayers ? { white: withPlayers.white, black: withPlayers.black } : null,
        lastMoveAt,
      };
    });
    res.json(out);
  } catch (e) {
    console.error('[Broadcasts] tournaments list:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ── API: создать турнир (только админ) ─────────────────────────────
app.post('/api/broadcast-tournaments', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    try {
      const { name, startsAt, description } = req.body || {};

      const nameClean = String(name || '').trim();
      if (!nameClean || nameClean.length > 120) {
        return res.status(400).json({ error: 'Название обязательно (до 120 символов)' });
      }

      let starts = Number(startsAt);
      if (!Number.isFinite(starts) || starts < 0) {
        const parsed = Date.parse(String(startsAt || ''));
        if (Number.isNaN(parsed)) return res.status(400).json({ error: 'Некорректное время начала' });
        starts = parsed;
      }

      const descClean = description ? String(description).trim().substring(0, 500) : null;
      const id = uuidv4();
      const now = Date.now();
      await db(`
        INSERT INTO broadcast_tournaments (id, name, description, starts_at, created_by, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        [id, nameClean, descClean, Math.round(starts), req.user.username || 'admin', now]);

      console.log(`[Broadcasts] Создан турнир "${nameClean}" (${id}) админом ${req.user.username}`);
      res.json({ ok: true, id });
    } catch (e) {
      console.error('[Broadcasts] tournament create:', e.message);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  });
});

// ── API: удалить турнир ВМЕСТЕ со всеми его партиями (только админ).
// Каскад: broadcast_tournaments → broadcasts → broadcast_pgn/broadcast_chat.
app.post('/api/broadcast-tournaments/:id/delete', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    try {
      const r = await db(
        `DELETE FROM broadcast_tournaments WHERE id = $1 RETURNING id`,
        [String(req.params.id)]);
      if (!r.rows.length) return res.status(404).json({ error: 'Турнир не найден' });
      res.json({ ok: true });
    } catch (e) {
      console.error('[Broadcasts] tournament delete:', e.message);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  });
});

// ── HTML-страницы ──────────────────────────────────────────────────
app.get('/broadcasts', (req, res) =>
  sendVersionedHtml(res, path.join(__dirname, '../../public/broadcasts.html')));

// Страница турнира. Регистрируется ДО /broadcasts/:id, чтобы «t» не
// съелось как id партии.
app.get('/broadcasts/t/:id', (req, res) =>
  sendVersionedHtml(res, path.join(__dirname, '../../public/broadcast-tournament.html')));

app.get('/broadcasts/:id', (req, res) =>
  sendVersionedHtml(res, path.join(__dirname, '../../public/broadcast.html')));

// ── API: список трансляций (?tournament=<id> — только партии турнира) ──
app.get('/api/broadcasts', async (req, res) => {
  const tId = String(req.query.tournament || '');
  const r = tId
    ? await db(`${LIST_SQL} WHERE b.tournament_id = $1 ORDER BY b.starts_at ASC, b.created_at ASC LIMIT 200`, [tId])
    : await db(`${LIST_SQL} ORDER BY b.starts_at DESC, b.created_at DESC LIMIT 200`);
  res.json(r.rows.map(row => rowToBroadcast(row, false)));
});

// ── API: приём PGN от скрипта на ПК ────────────────────────────────
function pushKeyMiddleware(req, res, next) {
  const key = process.env.BROADCAST_PUSH_KEY;
  if (!key) return res.status(500).json({ error: 'BROADCAST_PUSH_KEY не настроен на сервере' });
  if (typeof req.headers['x-broadcast-key'] !== 'string' ||
      !safeSecretEqual(req.headers['x-broadcast-key'], key)) {
    return res.status(403).json({ error: 'Неверный ключ' });
  }
  next();
}

app.post('/api/broadcasts/push',
  rateLimit(limiterStrict, 'Слишком много запросов.'),
  pushKeyMiddleware,
  async (req, res) => {
    try {
      const { roundId, pgn } = req.body || {};
      if (typeof roundId !== 'string' || !/^[A-Za-z0-9]{4,16}$/.test(roundId)) {
        return res.status(400).json({ error: 'Некорректный roundId' });
      }
      if (typeof pgn !== 'string' || !pgn.includes('[Event') || pgn.length > 1.5 * 1024 * 1024) {
        return res.status(400).json({ error: 'Некорректный PGN' });
      }

      const rows = await db(`SELECT id FROM broadcasts WHERE round_id = $1`, [roundId]);
      if (!rows.rows.length) {
        return res.status(404).json({ error: 'Нет трансляции с таким roundId (создайте её в админке)' });
      }

      const meta = pgnMeta(pgn);
      const now = Date.now();
      for (const row of rows.rows) {
        await db(`
          INSERT INTO broadcast_pgn (broadcast_id, pgn, result, white, black, plies, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (broadcast_id) DO UPDATE SET
            pgn = EXCLUDED.pgn, result = EXCLUDED.result, white = EXCLUDED.white,
            black = EXCLUDED.black, plies = EXCLUDED.plies, updated_at = EXCLUDED.updated_at`,
          [row.id, pgn, meta.result, meta.white, meta.black, meta.plies, now]);
        await db(`UPDATE broadcasts SET updated_at = $1 WHERE id = $2`, [now, row.id]);
      }

      res.json({ ok: true, updated: rows.rows.length, plies: meta.plies });
    } catch (e) {
      console.error('[Broadcasts] push error:', e.message);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  });

// ── API: одна трансляция (детали + PGN для поллинга) ───────────────
app.get('/api/broadcasts/:id', async (req, res) => {
  const r = await db(`${LIST_SQL} WHERE b.id = $1`, [String(req.params.id)]);
  if (!r.rows.length) return res.status(404).json({ error: 'Трансляция не найдена' });
  res.json(rowToBroadcast(r.rows[0], true));
});

// ── API: создать трансляцию (только админ) ─────────────────────────
app.post('/api/broadcasts', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    const { name, startsAt, roundId, sourceUrl, description, tournamentId } = req.body || {};

    const nameClean = String(name || '').trim();
    if (!nameClean || nameClean.length > 120) {
      return res.status(400).json({ error: 'Название обязательно (до 120 символов)' });
    }

    let starts = Number(startsAt);
    if (!Number.isFinite(starts) || starts < 0) {
      const parsed = Date.parse(String(startsAt || ''));
      if (Number.isNaN(parsed)) return res.status(400).json({ error: 'Некорректное время начала' });
      starts = parsed;
    }

    const roundClean = (roundId && /^[A-Za-z0-9]{4,16}$/.test(String(roundId)))
      ? String(roundId)
      : extractRoundId(sourceUrl);
    const urlClean = sourceUrl ? String(sourceUrl).trim().substring(0, 300) : null;
    const descClean = description ? String(description).trim().substring(0, 500) : null;

    // необязательная привязка к турниру
    let tourClean = null;
    if (tournamentId) {
      const t = await db(`SELECT id FROM broadcast_tournaments WHERE id = $1`, [String(tournamentId)]);
      if (!t.rows.length) return res.status(400).json({ error: 'Турнир не найден' });
      tourClean = String(tournamentId);
    }

    const id = uuidv4();
    const now = Date.now();
    await db(`
      INSERT INTO broadcasts (id, name, description, starts_at, round_id, source_url, tournament_id, created_by, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
      [id, nameClean, descClean, Math.round(starts), roundClean, urlClean, tourClean, req.user.username || 'admin', now]);

    console.log(`[Broadcasts] Создана трансляция "${nameClean}" (${id}) админом ${req.user.username}`);
    res.json({ ok: true, id });
  });
});

// ── Чат трансляции ─────────────────────────────────────────────────

app.get('/api/broadcasts/:id/chat', async (req, res) => {
  try {
    const after = Number(req.query.after) || 0;
    const r = after
      ? await db(
          `SELECT id, user_id, username, text, created_at FROM broadcast_chat
           WHERE broadcast_id = $1 AND created_at > $2
           ORDER BY created_at ASC LIMIT 100`,
          [String(req.params.id), after])
      : await db(
          `SELECT id, user_id, username, text, created_at FROM (
             SELECT id, user_id, username, text, created_at FROM broadcast_chat
             WHERE broadcast_id = $1 ORDER BY created_at DESC LIMIT 100
           ) t ORDER BY created_at ASC`,
          [String(req.params.id)]);
    res.json({ messages: r.rows.map(m => ({
      id: m.id, userId: m.user_id, username: m.username,
      text: m.text, createdAt: Number(m.created_at),
    })) });
  } catch (e) {
    console.error('[Broadcasts] chat get:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/broadcasts/:id/chat',
  rateLimit(limiterStrict, 'Слишком много сообщений. Подождите немного.'),
  authMiddleware,
  async (req, res) => {
    try {
      const text = String((req.body || {}).text || '').trim();
      if (!text || text.length > 300) {
        return res.status(400).json({ error: 'Сообщение пустое или длиннее 300 символов' });
      }
      const b = await db(`SELECT id FROM broadcasts WHERE id = $1`, [String(req.params.id)]);
      if (!b.rows.length) return res.status(404).json({ error: 'Трансляция не найдена' });

      const id = uuidv4();
      const now = Date.now();
      await db(
        `INSERT INTO broadcast_chat (id, broadcast_id, user_id, username, text, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, String(req.params.id),
         String(req.user.username || 'user'),
         String(req.user.username || 'user'),
         text, now]);
      res.json({ ok: true, id });
    } catch (e) {
      console.error('[Broadcasts] chat post:', e.message);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  });

// Удалить сообщение: админ сайта ИЛИ автор сообщения (модерация).
app.post('/api/broadcasts/:id/chat/:mid/delete', authMiddleware, async (req, res) => {
  try {
    const m = await db(
      `SELECT id, user_id FROM broadcast_chat WHERE id = $1 AND broadcast_id = $2`,
      [String(req.params.mid), String(req.params.id)]);
    if (!m.rows.length) return res.status(404).json({ error: 'Сообщение не найдено' });
    const isAuthor = m.rows[0].user_id === String(req.user.username || '');
    if (!isAuthor) {
      return await requireAdmin(req, res, async () => {
        await db(`DELETE FROM broadcast_chat WHERE id = $1`, [String(req.params.mid)]);
        res.json({ ok: true });
      });
    }
    await db(`DELETE FROM broadcast_chat WHERE id = $1`, [String(req.params.mid)]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[Broadcasts] chat delete:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ── API: привязать партию к турниру / отвязать (только админ).
// body: { tournamentId: '<id>' } — привязать (можно и с другого турнира —
// просто перенесёт), { tournamentId: null } — отвязать («без турнира»).
app.post('/api/broadcasts/:id/set-tournament', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    try {
      const b = await db(`SELECT id FROM broadcasts WHERE id = $1`, [String(req.params.id)]);
      if (!b.rows.length) return res.status(404).json({ error: 'Трансляция не найдена' });

      const { tournamentId } = req.body || {};
      if (tournamentId == null || tournamentId === '') {
        await db(`UPDATE broadcasts SET tournament_id = NULL, updated_at = $1 WHERE id = $2`,
          [Date.now(), String(req.params.id)]);
        return res.json({ ok: true, tournamentId: null });
      }
      const t = await db(`SELECT id FROM broadcast_tournaments WHERE id = $1`, [String(tournamentId)]);
      if (!t.rows.length) return res.status(400).json({ error: 'Турнир не найден' });
      await db(`UPDATE broadcasts SET tournament_id = $1, updated_at = $2 WHERE id = $3`,
        [String(tournamentId), Date.now(), String(req.params.id)]);
      res.json({ ok: true, tournamentId: String(tournamentId) });
    } catch (e) {
      console.error('[Broadcasts] set-tournament:', e.message);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  });
});

// ── API: удалить трансляцию (только админ). DELETE-метод режется
// nginx/WAF, поэтому POST-дубль на /delete — как у blog/news/forum.
app.post('/api/broadcasts/:id/delete', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    const r = await db(`DELETE FROM broadcasts WHERE id = $1 RETURNING id`, [String(req.params.id)]);
    if (!r.rows.length) return res.status(404).json({ error: 'Трансляция не найдена' });
    res.json({ ok: true });
  });
});

};