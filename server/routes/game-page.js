// routes/game-page.js — маршрут /game/:gameId
//
// Раньше здесь всегда рендерилась статичная страница-реплей (chessboard2).
// Из-за этого перезагрузка страницы во время АКТИВНОЙ партии показывала
// «Партия завершена» (SPA-страница игры существует на /game/<id> только
// после клиентской навигации через pushState — при перезагрузке браузер
// попадал сюда). Теперь:
//   • партия ещё идёт (activeGames)  → 302 на /game?rejoin=<id>:
//     SPA загрузится, а app/core.js по параметру ?rejoin= автоматически
//     вернёт игрока в партию (данные придут через game_start после auth);
//   • партия завершена (games в БД или фоллбэк турниров) → мост-страница,
//     которая кладёт данные партии в localStorage (страховка на случай,
//     если GET /api/games/:id не знает про старые турнирные партии) и
//     открывает /analysis?game=<id> — раздел «Анализ» с уже загруженной
//     партией.

const {
  db,
  tournaments,
  activeGames,
} = require('../core');

const GAME_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = function register(app) {
  app.get('/game/:gameId', async (req, res) => {
    const gameId = req.params.gameId;
    if (!GAME_ID_RE.test(gameId)) {
      return res.status(404).send('Игра не найдена');
    }

    // ── Активная партия: вернуться в бой ────────────────────────────────
    if (activeGames.get(gameId)) {
      res.set('Cache-Control', 'no-store');
      return res.redirect(302, '/game?rejoin=' + encodeURIComponent(gameId));
    }

    // ── Завершённая партия: достаём данные ──────────────────────────────
    let game = null;
    const dbGame = await db('SELECT * FROM games WHERE id = $1', [gameId]);
    if (dbGame.rows.length > 0) {
      const row = dbGame.rows[0];
      game = {
        id: row.id, white: row.white, black: row.black,
        result: row.result, reason: row.reason, moves: row.moves,
        timeControl: row.time_control, endedAt: row.ended_at ? Number(row.ended_at) : null,
      };
    } else {
      // Фоллбэк: старые турнирные партии, сохранённые до записи в таблицу games
      for (const t of tournaments) {
        const tg = (t.games || []).find(g => g.id === gameId);
        if (tg) {
          game = {
            id: tg.id, white: tg.white, black: tg.black,
            result: tg.result, reason: tg.reason, moves: tg.moves,
            timeControl: tg.timeControl, endedAt: tg.endedAt || null,
            tournamentId: t.id, tournamentName: t.name,
          };
          break;
        }
      }
    }
    if (!game) {
      return res.status(404).send('Игра не найдена');
    }

    // ── Мост: stash в localStorage + редирект в анализ ──────────────────
    // jsonForInline — экранирует <, >, &, U+2028/29, чтобы JSON можно было
    // безопасно встроить в инлайновый <script> (аналогично старому коду).
    const jsonForInline = (v) => JSON.stringify(v)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
    const gameDataJson = jsonForInline(game);
    const gameIdJson = jsonForInline(gameId);

    res.set('Cache-Control', 'no-store');
    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Открываем анализ партии…</title>
</head>
<body style="background:#12121f;color:#8a8aa0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;text-align:center;padding-top:40vh;margin:0">
  Открываем анализ партии…
  <script>
    (function () {
      try { localStorage.setItem('ch_analysis_game_stash', JSON.stringify(${gameDataJson})); } catch (e) {}
      location.replace('/analysis?game=' + encodeURIComponent(${gameIdJson}));
    })();
  </script>
</body>
</html>`);
  });
};