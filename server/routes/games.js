// routes/games.js — API партий
const {
  db,
  app,
  tournaments,
  activeGames,
  usersCache,
} = require('../core');

module.exports = function register(app) {
// Список активных партий для страницы /tv (публичные поля, без чата и доски)
app.get('/api/tv', (req, res) => {
  const list = [];
  for (const g of activeGames.values()) {
    list.push({
      id: g.id,
      white: g.white,
      black: g.black,
      whiteRating: usersCache.get(String(g.white || '').toLowerCase())?.rating ?? 1200,
      blackRating: usersCache.get(String(g.black || '').toLowerCase())?.rating ?? 1200,
      timeControl: g.timeControl || '10+0',
      moves: g.moves || [],
      moveCount: (g.moves || []).length,
      tournamentId: g.tournamentId || null,
    });
  }
  res.json(list);
});
app.get('/api/games/:gameId', async (req, res) => {
  const active = activeGames.get(req.params.gameId);
  if (active) {
    // Активная партия отдаётся белым списком полей: в объекте из activeGames
    // есть приватный чат игроков, внутренняя доска и счётчики античита —
    // наружу они попадать не должны.
    return res.json({
      id: active.id,
      white: active.white,
      black: active.black,
      turn: active.turn,
      moves: active.moves,
      timeControl: active.timeControl,
      whiteTime: active.whiteTime,
      blackTime: active.blackTime,
      tournamentId: active.tournamentId || null,
      rated: active.rated !== false,
    });
  }
  const r = await db('SELECT * FROM games WHERE id = $1', [req.params.gameId]);
  if (!r.rows[0]) {
    // Фоллбэк: старые турнирные партии, сохранённые до записи в таблицу games
    for (const t of tournaments) {
      const tg = (t.games || []).find(g => g.id === req.params.gameId);
      if (tg) {
        return res.json({
          id: tg.id, white: tg.white, black: tg.black,
          result: tg.result, reason: tg.reason, moves: tg.moves,
          timeControl: tg.timeControl, endedAt: tg.endedAt || null,
          berserk: tg.berserk, accuracy: tg.accuracy, tournamentId: t.id,
        });
      }
    }
    return res.status(404).json({ error: 'Не найдена' });
  }
  const row = r.rows[0];
  res.json({
    id: row.id, white: row.white, black: row.black,
    result: row.result, reason: row.reason, moves: row.moves,
    timeControl: row.time_control, endedAt: row.ended_at ? Number(row.ended_at) : null,
    rated: row.rated !== false,
  });
});


};
