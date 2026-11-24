# Трансляции (lichess broadcasts) — ChessHome

Страница `/broadcasts` — список турниров, `/broadcasts/<id>` — партия на весь
экран с обновлением в реальном времени. Сервер сам НЕ ходит в lichess
(исходящих запросов у него нет): ходы подтягивает скрипт на твоём ПК.

## Как это работает

```
[lichess.org] --(PGN, опрос раз в 2.5 c)--> [broadcast-pusher.js на твоём ПК]
      --> [POST /api/broadcasts/push с ключом] --> [PostgreSQL ChessHome]
      <-- [поллинг /api/broadcasts/<id> раз в 2 c] <-- [браузеры зрителей]
```

## Файлы

**Новые:**
- `server/routes/broadcasts.js` — роуты и таблицы (создаются сами при старте)
- `public/broadcasts.html` — список трансляций + форма добавления для админов
- `public/broadcast.html` — страница партии (доска, часы, ходы, LIVE)
- `scripts/broadcast-pusher.js` — мост Lichess→сервер, запускать на ПК

**Изменённые:**
- `server/routes/index.js` — добавлена строка `require('./broadcasts')(app);`
- `server/env.example` — добавлен `BROADCAST_PUSH_KEY=`

## Установка на сервере

1. Скопируй файлы в репозиторий.
2. Добавь в `.env` сервера (придумай длинный случайный ключ):

```env
BROADCAST_PUSH_KEY=длинный_случайный_ключ
```

3. Перезапусти сервер (`npm start`). Таблицы создадутся автоматически,
   миграция запускается не нужна.

## Создание трансляции

Зайди на `/broadcasts` под админом (роль admin, как у chesshome/marina64) —
появится форма «Добавить трансляцию»:

- Название — например `FIDE World Chess Championship 2026 — Game 1`
- Дата и время начала — локальное время
- Ссылка на раунд Lichess — та самая:
  `https://lichess.org/broadcast/fide-world-chess-championship-2026/game-1/xLgOJ6cb`
  (ID раунда `xLgOJ6cb` вытащится из ссылки автоматически)
- Описание — например `GM Gukesh D — GM Sindarov, Javokhir`

## Запуск моста на ПК

Node >= 18, зависимостей не нужно:

```bash
node scripts/broadcast-pusher.js \
  --lichess "https://lichess.org/broadcast/fide-world-chess-championship-2026/game-1/xLgOJ6cb" \
  --site https://chesshome.pro \
  --key БРОАДКАСТ_КЛЮЧ_ИЗ_ENV
```

Скрипт опрашивает `https://lichess.org/api/broadcast/round/<id>.pgn?clocks=true&evals=true`
и отправляет PGN на сервер только когда он изменился. При ошибках — бэкофф,
при неверном ключе — сразу выход с понятной ошибкой. Раунд в lichess
заканчивается — просто запусти скрипт со ссылкой на следующий раунд.

Остановка: Ctrl+C.

## Эндпоинты API

| Метод | Путь | Кто |
|---|---|---|
| GET | `/api/broadcasts` | список трансляций (статусы, игроки, число ходов) |
| GET | `/api/broadcasts/:id` | детали + свежий PGN (поллинг страницы партии) |
| POST | `/api/broadcasts` | создать трансляцию — только admin (сессионная кука) |
| POST | `/api/broadcasts/:id/delete` | удалить — только admin |
| POST | `/api/broadcasts/push` | приём PGN от скрипта на ПК, ключ в заголовке `x-broadcast-key` |

Статусы трансляции: `upcoming` (есть время начала, партии нет) → `live`
(PGN обновляется) / `paused` (нет обновлений >15 мин) → `finished` (есть
результат в PGN).

## Нюансы

- Статика `/broadcasts.html` и `/broadcast/<id>` отдаётся и напрямую, и через
  красивые пути `/broadcasts`, `/broadcasts/<id>`.
- Если в раунде несколько партий (многобоевые турниры) — над доской появится
  селектор партий, каждая партия со своим списком ходов и часами.
- Часы и дебют берутся из PGN Lichess (`[%clk ...]`, тег `Opening`).
- Ссылку «Трансляции» в шапку сайта добавь в нужные страницы
  (`<li><a href="/broadcasts">📡 Трансляции</a></li>`).
