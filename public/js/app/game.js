// app/game.js — онлайн-партия: баннеры турниров, реджойн, старт UI
// Вынесено из монолитного app.js в рамках рефакторинга.
// Код не изменён. Файл — классический скрипт в глобальной области,
// подключается после /js/app/core.js в исходном порядке следования.

let _currentGameData = null; // текущие данные активной онлайн-игры для реджойна

// PENDING TOURNAMENT GAME
let _pendingTournamentGame = null;

function showPendingTournamentBanner(data) {
  document.getElementById('pending-t-banner')?.remove();

  const b = document.createElement('div');
  b.id = 'pending-t-banner';
  Object.assign(b.style, {
    position:'fixed', bottom:'28px', left:'50%', transform:'translateX(-50%)',
    background:'var(--bg-card)', border:'2px solid var(--accent)',
    borderRadius:'16px', padding:'16px 22px',
    display:'flex', alignItems:'center', gap:'16px',
    boxShadow:'0 8px 48px rgba(0,0,0,0.7)', zIndex:'99999',
    minWidth:'320px', maxWidth:'92vw', fontFamily:'var(--font-body)',
    animation:'ptbUp 0.4s cubic-bezier(0.34,1.56,0.64,1)'
  });

  const colorRu = data.color === 'white' ? '♙ Белые' : '♟ Чёрные';
  b.innerHTML = `
    <div style="font-size:28px">⚔️</div>
    <div style="flex:1;min-width:0">
      <div style="font-weight:700;font-size:14px;color:var(--text-primary)">Вас ждёт турнирная партия!</div>
      <div style="font-size:12px;color:var(--text-secondary);margin-top:3px">
        ${colorRu} · vs <b>${escapeHtml(data.opponent||'?')}</b> · ${escapeHtml(data.timeControl||'')}
      </div>
    </div>
    <button onclick="goToTournamentGame()"
      style="background:linear-gradient(135deg,var(--accent),var(--accent-dark));
      color:#000;border:none;border-radius:10px;padding:10px 18px;
      font-weight:700;font-size:13px;cursor:pointer;white-space:nowrap;flex-shrink:0">
      ⚔️ Перейти
    </button>
    <button onclick="document.getElementById('pending-t-banner')?.remove()"
      style="background:transparent;border:none;color:var(--text-muted);
      font-size:20px;cursor:pointer;padding:0 4px;flex-shrink:0;line-height:1">✕</button>`;

  document.body.appendChild(b);

  if (!document.getElementById('ptb-style')) {
    const s = document.createElement('style');
    s.id = 'ptb-style';
    s.textContent = '@keyframes ptbUp{from{opacity:0;transform:translateX(-50%) translateY(24px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}';
    document.head.appendChild(s);
  }
}

function goToTournamentGame() {
  const data = _pendingTournamentGame;
  if (!data || !data.tournamentId) return;
  document.getElementById('pending-t-banner')?.remove();
  // Переходим на страницу турнира — там socket получит game_start и запустит отсчёт
  window.location.href = (data.isInterclub ? '/tournament/interclub/' : '/tournament/') + data.tournamentId;
}

// БАННЕР ВОЗВРАТА В ТУРНИР
function showTournamentReturnBanner(tournamentId, tournamentName, isInterclub) {
  document.getElementById('t-ret-banner')?.remove();
  const b = document.createElement('div');
  b.id = 't-ret-banner';
  Object.assign(b.style, {
    position:'fixed', top:'72px', right:'18px',
    background:'var(--bg-card)', border:'2px solid var(--accent)',
    borderRadius:'14px', padding:'14px 18px',
    display:'flex', alignItems:'center', gap:'14px',
    boxShadow:'0 8px 40px rgba(201,168,76,0.35)', zIndex:'9999',
    minWidth:'260px', maxWidth:'90vw', fontFamily:'var(--font-body)',
    animation:'ptbUp 0.4s cubic-bezier(0.34,1.56,0.64,1)'
  });
  const label = tournamentName ? escapeHtml(tournamentName) : 'турнир';
  const tUrl = (isInterclub ? '/tournament/interclub/' : '/tournament/') + tournamentId;
  b.innerHTML = `
    <div style="font-size:24px">🏆</div>
    <div style="flex:1">
      <div style="font-weight:700;font-size:14px;color:var(--accent)">Вы в турнире</div>
      <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">${label}</div>
    </div>
    <button onclick="window.location.href='${tUrl}'"
      style="background:linear-gradient(135deg,var(--accent),var(--accent-dark));
      color:#000;border:none;border-radius:8px;padding:8px 14px;
      font-weight:700;font-size:13px;cursor:pointer;white-space:nowrap">← В турнир</button>
    <button onclick="document.getElementById('t-ret-banner')?.remove()"
      style="background:transparent;border:none;color:var(--text-muted);
      font-size:18px;cursor:pointer;padding:2px 4px;flex-shrink:0">✕</button>`;
  document.body.appendChild(b);
  if (!document.getElementById('ptb-style')) {
    const s = document.createElement('style');
    s.id = 'ptb-style';
    s.textContent = '@keyframes ptbUp{from{opacity:0;transform:translateY(-16px)}to{opacity:1;transform:translateY(0)}}';
    document.head.appendChild(s);
  }
}

function startGameUI(data) {
  _currentGameData = data; // сохраняем для реджойн-баннера при уходе со страницы
  presenceReset();         // новая партия — оба кружка зелёные, баннер ухода скрыт
  rematchReset();          // новая партия (в т.ч. реванш) — прячем плашки реванша и окно результата
  document.getElementById('modal-game-result')?.classList.remove('open');
  // Небольшая задержка — даём challenges_update отработать первым
  // чтобы DOM лобби не перезаписал наш переход на game
  setTimeout(() => {
    // Переключаем страницу напрямую (без pages['game'] чтобы не сбросить онлайн-игру)
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-links a').forEach(a => a.classList.remove('active'));
    const gameEl = document.getElementById('page-game');
    if (gameEl) gameEl.classList.add('active');
    history.pushState({}, '', '/game/' + (data.gameId || ''));

    // Запускаем игру
    chessBoard.startGame(data);

    // Рейтинги
    const myRating  = currentUser ? currentUser.rating : '?';
    const oppRating = data.opponentRating || '?';
    const topEl    = document.getElementById('rating-top');
    const bottomEl = document.getElementById('rating-bottom');
    if (topEl)    topEl.textContent    = chT('game.rating_prefix', 'Рейтинг:') + ' ' + oppRating;
    if (bottomEl) bottomEl.textContent = chT('game.rating_prefix', 'Рейтинг:') + ' ' + myRating;

    // Второй рендер — гарантирует правильный контейнер
    setTimeout(() => chessBoard.render(), 50);
  }, 100);
}

// GAME CHAT

// РЕВАНШ
// Сервер присылает game_ended с флагом rematch:true (обычная партия, сделан хотя бы
// один полный ход). Дальше события rematch_* обрабатываются в /js/app/core.js,
// а вся разметка строится здесь и показывается в двух местах: в окне результата
// и на странице партии под кнопками «ничья / сдаться / анализ».
// Состояния: idle (кнопка «Реванш») → sent (ждём ответ) | incoming (нам предложили) | closed.
const REMATCH_UI_TTL = 2 * 60 * 1000; // как REMATCH_OFFER_TTL на сервере
let _rematch = null;      // { gameId, opponent, state, note }
let _rematchTimer = null;

function _rmT(key, fb, name) {
  const v = (typeof T === 'function') ? T(key, fb) : fb;
  return name === undefined ? v : String(v).replace('{name}', name);
}

function _rmStyle() {
  if (document.getElementById('rematch-style')) return;
  const s = document.createElement('style');
  s.id = 'rematch-style';
  s.textContent = `
    .rematch-box{margin-top:16px;display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center}
    .rematch-box .rematch-note{font-size:13px;color:var(--text-secondary)}
    .rematch-box .rematch-row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
    .rematch-incoming{padding:12px 16px;border:1px solid var(--accent);border-radius:14px;
      background:rgba(201,168,76,.10);animation:rematchGlow 1.6s ease-in-out infinite}
    .rematch-incoming .rematch-title{font-weight:700;font-size:14px;color:var(--accent);display:inline-block;
      animation:rematchBounce 1s ease-in-out infinite}
    .rematch-incoming .rematch-accept{animation:rematchBounce 1s ease-in-out infinite .15s}
    @keyframes rematchBounce{0%,100%{transform:translateY(0)}30%{transform:translateY(-7px)}55%{transform:translateY(0)}72%{transform:translateY(-3px)}}
    @keyframes rematchGlow{0%,100%{box-shadow:0 0 0 0 rgba(201,168,76,0)}50%{box-shadow:0 0 18px 2px rgba(201,168,76,.35)}}
    @media (prefers-reduced-motion:reduce){.rematch-incoming,.rematch-incoming *{animation:none!important}}
  `;
  document.head.appendChild(s);
}

// Контейнеры создаём из JS, чтобы не править index.html
function _rmBoxes() {
  const boxes = [];
  const modal = document.querySelector('#modal-game-result .modal');
  if (modal) {
    let box = document.getElementById('rematch-box-modal');
    if (!box) {
      box = document.createElement('div');
      box.id = 'rematch-box-modal';
      const row = modal.querySelector('div[style*="justify-content:center"]');
      if (row) row.parentNode.insertBefore(box, row); else modal.appendChild(box);
    }
    boxes.push(box);
  }
  const actions = document.querySelector('#page-game .game-actions');
  if (actions) {
    let box = document.getElementById('rematch-box-game');
    if (!box) {
      box = document.createElement('div');
      box.id = 'rematch-box-game';
      actions.insertAdjacentElement('afterend', box);
    }
    boxes.push(box);
  }
  return boxes;
}

function _rmRender() {
  _rmStyle();
  const r = _rematch;
  _rmBoxes().forEach(box => {
    if (!r) { box.style.display = 'none'; box.innerHTML = ''; box.className = 'rematch-box'; return; }
    const name = escapeHtml(r.opponent || '?');
    let html = '';
    if (r.state === 'idle') {
      html = `<button class="btn btn-primary" data-rm="offer">⚔️ ${_rmT('game.rematch', 'Реванш')}</button>`;
    } else if (r.state === 'sent') {
      html = `<div class="rematch-note">⏳ ${_rmT('game.rematch_wait', 'Ожидаем ответ соперника…')}</div>
              <button class="btn btn-ghost btn-sm" data-rm="cancel">${_rmT('game.rematch_cancel', 'Отменить')}</button>`;
    } else if (r.state === 'incoming') {
      html = `<div class="rematch-title">⚔️ ${_rmT('game.rematch_incoming', '{name} предлагает реванш', name)}</div>
              <div class="rematch-row">
                <button class="btn btn-primary rematch-accept" data-rm="accept">✓ ${_rmT('game.rematch_accept', 'Принять')}</button>
                <button class="btn btn-secondary" data-rm="decline">✕ ${_rmT('game.rematch_decline', 'Отклонить')}</button>
              </div>`;
    } else {
      html = `<div class="rematch-note">${r.note || ''}</div>`;
    }
    box.className = 'rematch-box' + (r.state === 'incoming' ? ' rematch-incoming' : '');
    box.style.display = '';
    box.innerHTML = html;
  });
}

function _rmSet(state, note) {
  if (!_rematch) return;
  _rematch.state = state;
  _rematch.note = note || '';
  _rmRender();
}

function _rmOpen(gameId, opponent) {
  clearTimeout(_rematchTimer);
  _rematch = { gameId, opponent, state: 'idle', note: '' };
  _rematchTimer = setTimeout(() => {
    if (_rematch && _rematch.gameId === gameId) _rmSet('closed', _rmT('game.rematch_closed', 'Реванш больше недоступен'));
  }, REMATCH_UI_TTL);
}

function rematchReset() {
  clearTimeout(_rematchTimer);
  _rematch = null;
  _rmRender();
}

function rematchOnGameEnded(data) {
  const me = currentUser && currentUser.username;
  if (!data || !data.rematch || data.tournamentId || !me || (data.white !== me && data.black !== me)) {
    rematchReset();
    return;
  }
  _rmOpen(data.gameId, data.white === me ? data.black : data.white);
  _rmRender();
}

function rematchOnSent(d)  { if (_rematch && _rematch.gameId === d.gameId) _rmSet('sent'); }

function rematchOnOffered(d) {
  // На случай, если предложение пришло раньше game_ended
  if (!_rematch || _rematch.gameId !== d.gameId) _rmOpen(d.gameId, d.from);
  _rmSet('incoming');
  const onGamePage = document.getElementById('page-game')?.classList.contains('active');
  if (!onGamePage && typeof toast === 'function') toast('⚔️ ' + _rmT('game.rematch_incoming', '{name} предлагает реванш', d.from), 'info');
}

function rematchOnDeclined(d) {
  if (_rematch && _rematch.gameId === d.gameId) _rmSet('closed', _rmT('game.rematch_declined', '{name} отказался от реванша', _rematch.opponent));
}

function rematchOnCancelled(d) {
  if (_rematch && _rematch.gameId === d.gameId) _rmSet('idle');
}

function rematchOnUnavailable(d) {
  if (!_rematch || _rematch.gameId !== d.gameId) return;
  const msgs = {
    offline: _rmT('game.rematch_offline', 'Соперник вышел с сайта'),
    busy:    _rmT('game.rematch_busy', 'Соперник уже играет другую партию'),
  };
  _rmSet('closed', msgs[d.reason] || _rmT('game.rematch_closed', 'Реванш больше недоступен'));
}

function rematchAction(action, btn) {
  if (!_rematch || !socket) return;
  const gameId = _rematch.gameId;
  if (action === 'offer')   { if (btn) btn.disabled = true; socket.emit('rematch_offer', { gameId }); }
  if (action === 'cancel')  { socket.emit('rematch_cancel', { gameId }); _rmSet('idle'); }
  if (action === 'accept')  { if (btn) btn.disabled = true; socket.emit('rematch_accept', { gameId }); }
  if (action === 'decline') { socket.emit('rematch_decline', { gameId }); _rmSet('closed', _rmT('game.rematch_you_declined', 'Вы отказались от реванша')); }
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('[data-rm]');
  if (btn) rematchAction(btn.dataset.rm, btn);
});

// ПРИСУТСТВИЕ В ПАРТИИ
// Зелёный кружок рядом с ником — игрок в партии, серый — вышел (закрыл вкладку, пропала
// связь). Кружки рисуются псевдоэлементом ::before на .player-name, поэтому не страдают
// от перезаписи текста ника. Верхний ник — соперник, нижний — мы.
// Когда соперник вышел, сервер присылает opponent_presence с claimIn (мс до момента,
// когда можно объявить победу); показываем баннер с отсчётом и кнопкой.
let _presActive = false, _presGameId = null, _presTimer = null, _presClaimAt = 0;

function _presStyle() {
  if (document.getElementById('presence-style')) return;
  const st = document.createElement('style');
  st.id = 'presence-style';
  st.textContent = `
    .player-name.pres-on::before,.player-name.pres-off::before{content:'';display:inline-block;width:9px;height:9px;
      border-radius:50%;margin-right:7px;vertical-align:middle;transition:background .3s,box-shadow .3s}
    .player-name.pres-on::before{background:#3fb950;box-shadow:0 0 6px rgba(63,185,80,.65)}
    .player-name.pres-off::before{background:#6b7280;box-shadow:none}
    @keyframes presUp{from{opacity:0;transform:translateX(-50%) translateY(24px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
  `;
  document.head.appendChild(st);
}

function _presSet(which, online) {
  const el = document.getElementById('player-' + which + '-name');
  if (!el) return;
  el.classList.toggle('pres-on', !!online);
  el.classList.toggle('pres-off', !online);
  el.title = online ? T('game.presence_online', 'В игре') : T('game.presence_offline', 'Вышел из игры');
}

function _presHideBanner() {
  clearInterval(_presTimer); _presTimer = null;
  document.getElementById('opp-away-banner')?.remove();
}

function _presShowBanner(claimAt) {
  _presClaimAt = claimAt;
  let b = document.getElementById('opp-away-banner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'opp-away-banner';
    Object.assign(b.style, {
      position:'fixed', bottom:'28px', left:'50%', transform:'translateX(-50%)',
      background:'var(--bg-card)', border:'2px solid var(--accent)', borderRadius:'16px',
      padding:'14px 20px', display:'flex', alignItems:'center', gap:'14px',
      boxShadow:'0 8px 48px rgba(0,0,0,0.7)', zIndex:'9998', maxWidth:'92vw',
      fontFamily:'var(--font-body)', animation:'presUp 0.4s cubic-bezier(0.34,1.56,0.64,1)'
    });
    b.innerHTML = `<div style="font-size:24px">🔌</div>
      <div id="opp-away-text" style="font-size:14px;color:var(--text-primary);font-weight:600"></div>
      <button id="opp-away-btn" class="btn btn-primary" onclick="presenceClaim()" disabled style="white-space:nowrap">🏆 ${T('game.claim_victory', 'Объявить победу')}</button>`;
    document.body.appendChild(b);
  }
  clearInterval(_presTimer);
  const tick = () => {
    const left = Math.ceil((_presClaimAt - Date.now()) / 1000);
    const txt = document.getElementById('opp-away-text');
    const btn = document.getElementById('opp-away-btn');
    if (!txt || !btn) return;
    if (left > 0) {
      txt.textContent = T('game.opp_left_wait', 'Соперник вышел из игры. Объявить победу можно через {n} с').replace('{n}', left);
      btn.disabled = true;
    } else {
      txt.textContent = T('game.opp_left_ready', 'Соперник вышел из игры. Вы можете объявить победу');
      btn.disabled = false;
    }
  };
  tick();
  _presTimer = setInterval(tick, 1000);
}

function presenceReset() {
  _presStyle();
  _presActive = true; _presGameId = null;
  _presSet('top', true); _presSet('bottom', true);
  _presHideBanner();
}

function presenceSetMine(online) {
  if (_presActive) _presSet('bottom', online);
}

function presenceOnOpponent(d) {
  if (!d) return;
  let cur = null;
  try { cur = (typeof chessBoard !== 'undefined' && chessBoard.gameId) || (_currentGameData && _currentGameData.gameId) || null; } catch (e) {}
  if (cur && d.gameId !== cur) return;
  _presStyle();
  _presActive = true; _presGameId = d.gameId;
  _presSet('bottom', !socket || socket.connected !== false);
  const wasAway = !!document.getElementById('opp-away-banner');
  _presSet('top', !!d.online);
  if (d.online) {
    _presHideBanner();
    if (wasAway && typeof toast === 'function') toast('🟢 ' + T('game.opp_back', 'Соперник вернулся в игру'), 'info');
  } else {
    _presShowBanner(Date.now() + (d.claimIn || 0));
  }
}

function presenceClaim() {
  if (socket && _presGameId) socket.emit('claim_victory', { gameId: _presGameId });
}

function presenceOnGameEnded() {
  _presHideBanner();
  _presActive = false;
}