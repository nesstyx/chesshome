// sockets/challenges.js — вызовы (challenges): пул лобби и личные вызовы

const {
  uuidv4,
  io,
  pendingChallenges,
  findSocketByUsername,
  startGame,
  isUserInGame,
} = require('../core');

// Жизненный цикл вызовов (challenges)
const CHALLENGE_TTL_MS = 60000;
setInterval(() => {
  const now = Date.now();
  for (let i = pendingChallenges.length - 1; i >= 0; i--) {
    if (now - pendingChallenges[i].createdAt > CHALLENGE_TTL_MS) pendingChallenges.splice(i, 1);
  }
}, 30000).unref();

const MSG_SELF_BUSY = 'У вас уже есть незавершённая партия — вернитесь в неё или сдайтесь';
const MSG_OPP_BUSY  = 'Соперник уже играет другую партию';

module.exports = function registerChallenges(socket) {
  // Формат контрольного времени «10+0», «3+2», «60+0s» (для пулов) —
  const TIME_CONTROL_RE = /^\d{1,3}(\.\d)?s?\+\d{1,2}s?$/;

  socket.on('post_challenge', (data) => {
    if (!socket.username) return;
    if (typeof data !== 'object' || data === null) return;
    const nowTs = Date.now();
    if (socket._lastPostChallengeAt && nowTs - socket._lastPostChallengeAt < 1000) {
      return socket.emit('error', 'Слишком часто — подождите секунду');
    }
    socket._lastPostChallengeAt = nowTs;
    if (isUserInGame(socket.username)) return socket.emit('error', MSG_SELF_BUSY);
    const timeControl = typeof data.timeControl === 'string' && TIME_CONTROL_RE.test(data.timeControl) ? data.timeControl : '10+0';
    const color = ['white', 'black', 'random'].includes(data.color) ? data.color : 'random';
    const rated = data.rated !== false;
    const challenge = { id: uuidv4(), from: socket.username, timeControl, color, rated, createdAt: Date.now(), socketId: socket.id };
    const idx = pendingChallenges.findIndex(c => c.from === socket.username);
    if (idx !== -1) pendingChallenges.splice(idx, 1);
    pendingChallenges.push(challenge);
    io.emit('challenges_update', pendingChallenges.filter(c => Date.now() - c.createdAt < CHALLENGE_TTL_MS));
  });

  socket.on('cancel_challenge', () => {
    if (!socket.username) return;
    const idx = pendingChallenges.findIndex(c => c.from === socket.username);
    if (idx === -1) return;
    pendingChallenges.splice(idx, 1);
    io.emit('challenges_update', pendingChallenges.filter(c => Date.now() - c.createdAt < CHALLENGE_TTL_MS));
  });

  socket.on('accept_challenge', (challengeId) => {
    if (!socket.username) return;
    const idx = pendingChallenges.findIndex(c => c.id === challengeId);
    if (idx === -1) return socket.emit('error', 'Вызов не найден');
    const challenge = pendingChallenges[idx];
    if (challenge.from === socket.username) return socket.emit('error', 'Нельзя принять свой вызов');
    if (isUserInGame(socket.username)) return socket.emit('error', MSG_SELF_BUSY);
    if (isUserInGame(challenge.from)) {
      // Автор вызова уже играет — вызов протух, убираем из лобби
      pendingChallenges.splice(idx, 1);
      io.emit('challenges_update', pendingChallenges.filter(c => Date.now() - c.createdAt < CHALLENGE_TTL_MS));
      return socket.emit('error', MSG_OPP_BUSY);
    }
    if (Date.now() - challenge.createdAt > CHALLENGE_TTL_MS) {
      pendingChallenges.splice(idx, 1);
      io.emit('challenges_update', pendingChallenges);
      return socket.emit('error', 'Вызов устарел');
    }
    pendingChallenges.splice(idx, 1);
    io.emit('challenges_update', pendingChallenges.filter(c => Date.now() - c.createdAt < CHALLENGE_TTL_MS));
    // Свой открытый вызов принявший больше не нужен: он сейчас начнёт партию
    const ownIdx = pendingChallenges.findIndex(c => c.from === socket.username);
    if (ownIdx !== -1) {
      pendingChallenges.splice(ownIdx, 1);
      io.emit('challenges_update', pendingChallenges.filter(c => Date.now() - c.createdAt < CHALLENGE_TTL_MS));
    }
    setTimeout(() => {
      // Повторная проверка: за 50 мс игрок мог успеть принять другой вызов
      if (isUserInGame(socket.username) || isUserInGame(challenge.from)) {
        return socket.emit('error', isUserInGame(socket.username) ? MSG_SELF_BUSY : MSG_OPP_BUSY);
      }
      startGame(socket, challenge);
    }, 50);
  });

  socket.on('challenge_user', (data) => {
    if (!socket.username) return;
    const now = Date.now();
    if (socket._lastDirectChallengeAt && now - socket._lastDirectChallengeAt < 2000) {
      return socket.emit('error', 'Не так часто — подождите пару секунд');
    }
    socket._lastDirectChallengeAt = now;
    // Поддерживаем и старый формат вызова (просто ник строкой), и новый
    const targetUsername = typeof data === 'string' ? data : data?.username;
    const rated = typeof data === 'string' ? true : data?.rated !== false;
    if (typeof targetUsername !== 'string' || !targetUsername || targetUsername.length > 20) return;
    if (targetUsername.toLowerCase() === socket.username.toLowerCase()) return socket.emit('error', 'Нельзя вызвать самого себя');
    if (isUserInGame(socket.username)) return socket.emit('error', MSG_SELF_BUSY);
    const t = findSocketByUsername(targetUsername);
    if (!t) return socket.emit('error', 'Не в сети');
    if (isUserInGame(targetUsername)) return socket.emit('error', 'Игрок сейчас в партии');
    // Контроль времени личного вызова: берём выбранный в зале, иначе 10+0.
    const directTC = typeof data === 'object' && data && typeof data.timeControl === 'string' && TIME_CONTROL_RE.test(data.timeControl) ? data.timeControl : '10+0';
    socket._directTC = directTC;
    socket._directRated = rated;
    t.emit('incoming_challenge', { from: socket.username, socketId: socket.id, rated, timeControl: directTC });
  });

  socket.on('accept_direct_challenge', (data) => {
    if (!socket.username) return;
    const fromSocketId = typeof data === 'string' ? data : data?.fromSocketId;
    const rated = typeof data === 'string' ? true : data?.rated !== false;
    const fromSocket = io.sockets.sockets.get(fromSocketId);
    if (!fromSocket) return socket.emit('error', 'Игрок отключился');
    if (isUserInGame(socket.username)) return socket.emit('error', MSG_SELF_BUSY);
    if (isUserInGame(fromSocket.username)) return socket.emit('error', MSG_OPP_BUSY);
    // Берём контроль, который вызывающий сам указал (хранится на сервере, клиенту не доверяем).
    const directTC = typeof fromSocket._directTC === 'string' && TIME_CONTROL_RE.test(fromSocket._directTC) ? fromSocket._directTC : '10+0';
    const effectiveRated = typeof fromSocket._directRated === 'boolean' ? fromSocket._directRated : rated;
    startGame(socket, { from: fromSocket.username, timeControl: directTC, color: 'random', rated: effectiveRated, socketId: fromSocketId });
  });

  socket.on('decline_challenge', (fromSocketId) => {
    if (!socket.username) return;
    if (typeof fromSocketId !== 'string' || fromSocketId.length > 64) return;
    const fs = io.sockets.sockets.get(fromSocketId);
    if (fs) fs.emit('challenge_declined', socket.username);
  });
}