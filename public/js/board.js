// Chess Home — Компонент шахматной доски

const chessBoard = (() => {
  // СОСТОЯНИЕ
  let state = ChessEngine.parseFEN(ChessEngine.START_FEN);
  let playerColor = 'w';
  let selectedSq = null;
  let legalMovesCache = [];
  let lastMove = null;
  let gameId = null;
  let historyStates = [ChessEngine.deepClone(state)];
  let viewingMove = -1; // -1 = latest

  // Clocks
  let whiteTime = 600, blackTime = 600;
  let clockInterval = null;
  let clockRunning = false;
  let activeColor = 'w';

  function T(key, fallback) {
    try {
      const v = window.CH_I18N ? window.CH_I18N.t(key) : undefined;
      if (v && v !== key) return v;
    } catch (e) {}
    return fallback !== undefined ? fallback : key;
  }

  // Game info
  let gameOpponent = '';
  let _tournamentId = null;
  let _tournamentName = null;
  let gameMode = 'local'; // 'local' | 'online' | 'analysis'
  let isFlipped = false;

  // Premove
  let premove = null; // { from, to, promotion? }
  let premoveSquares = [];

  // ПКМ-АННОТАЦИИ
  let annotations = [];
  let rmbStartSq = null;
  let rmbGestureActive = false;

  // Pointer Drag & Click
  let dragState = null;
  let hoverSq = null;

  // РАЗМЕР ДОСКИ
  let _boardPx = (() => {
    const v = parseInt(localStorage.getItem('ch_board_size') || '0', 10);
    return v >= 280 && v <= 860 ? v : 0;
  })();

  function computeAutoSize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w <= 768) {
      if (window.matchMedia('(orientation: landscape)').matches) {
        return Math.max(260, Math.min(h - 130, 420));
      }
      return Math.max(280, Math.min(w - 20, h - 220, 500));
    }
    const analysisActive = document.getElementById('page-analysis')?.classList.contains('active')
      && !document.getElementById('page-game')?.classList.contains('active');
    const reservedW = analysisActive ? 450 : 380;
    const reservedH = analysisActive ? 175 : 210;
    return Math.max(380, Math.min(780, w - reservedW, h - reservedH));
  }

  function applyBoardSize(px) {
    const board = document.getElementById('chess-board');
    if (!board) return;
    const size = px >= 280 ? px : computeAutoSize();
    board.style.width = size + 'px';
    board.style.height = size + 'px';
    // Размер координат масштабируется вместе с доской
    board.style.setProperty('--sq-coord-fs', Math.max(9, Math.round(size / 46)) + 'px');

    const area = board.closest('.board-area');
    if (area && window.innerWidth > 768) {
      area.querySelectorAll('.player-info').forEach(el => {
        el.style.width = size + 'px';
        el.style.minWidth = '0';
      });
    }
  }

  function initSizeSlider() {
    const slider = document.getElementById('board-size-slider');
    const label  = document.getElementById('board-size-label');
    if (slider && !slider._chInited) {
      slider._chInited = true;
      slider.min = 280; slider.max = 860; slider.step = 10;
      slider.value = _boardPx >= 280 ? _boardPx : computeAutoSize();
      if (label) label.textContent = _boardPx >= 280 ? _boardPx + 'px' : T('game.auto', 'Авто');

      const updateSliderFill = () => {
        const min = parseInt(slider.min, 10), max = parseInt(slider.max, 10);
        const pct = ((parseInt(slider.value, 10) - min) / (max - min) * 100).toFixed(1);
        slider.style.setProperty('--pct', pct + '%');
      };
      updateSliderFill();

      slider.addEventListener('input', () => {
        if (label) label.textContent = slider.value + 'px';
        applyBoardSize(parseInt(slider.value, 10));
        updateSliderFill();
      });
      slider.addEventListener('change', () => {
        _boardPx = parseInt(slider.value, 10);
        localStorage.setItem('ch_board_size', _boardPx);
        applyBoardSize(_boardPx);
        updateSliderFill();
      });
    }
    initResizeHandle();
  }

  function initResizeHandle() {
    const board = document.getElementById('chess-board');
    const wrapper = board?.closest('.board-wrapper');
    if (!wrapper) return;

    let handle = wrapper.querySelector('#board-resize-handle');
    if (!handle) {
      handle = document.createElement('div');
      handle.className = 'board-resize-handle';
      handle.id = 'board-resize-handle';
      handle.title = 'Тяните угол для размера · двойной клик — Авто';
      wrapper.appendChild(handle);
    }
    if (handle._chInited) return;
    handle._chInited = true;

    handle.addEventListener('dblclick', (e) => {
      e.preventDefault();
      _boardPx = 0;
      localStorage.removeItem('ch_board_size');
      const auto = computeAutoSize();
      const slider = document.getElementById('board-size-slider');
      const label  = document.getElementById('board-size-label');
      if (slider) {
        slider.value = auto;
        const min = parseInt(slider.min, 10), max = parseInt(slider.max, 10);
        slider.style.setProperty('--pct', ((auto - min) / (max - min) * 100).toFixed(1) + '%');
      }
      if (label) label.textContent = T('game.auto', 'Авто');
      applyBoardSize(0);
    });

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const b = getBoardEl();
      const startX = e.clientX;
      const startY = e.clientY;
      const startSize = b.offsetWidth;

      function onMove(ev) {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        const delta = Math.round((dx + dy) / 2 / 5) * 5;
        const newSize = Math.max(280, Math.min(860, startSize + delta));
        _boardPx = newSize;

        const slider = document.getElementById('board-size-slider');
        const label  = document.getElementById('board-size-label');
        if (slider) {
          slider.value = newSize;
          const min = parseInt(slider.min, 10), max = parseInt(slider.max, 10);
          slider.style.setProperty('--pct', ((newSize - min) / (max - min) * 100).toFixed(1) + '%');
        }
        if (label) label.textContent = newSize + 'px';
        applyBoardSize(newSize);
      }

      function onUp() {
        localStorage.setItem('ch_board_size', _boardPx);
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
      }

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  }

  function getBoardEl() {
    let board = document.getElementById('chess-board');
    if (!board) {
      board = document.createElement('div');
      board.id = 'chess-board';
    }

    const analysisActive = document.getElementById('page-analysis')?.classList.contains('active');
    const gameActive = document.getElementById('page-game')?.classList.contains('active');
    const containerId = (analysisActive && !gameActive) ? 'analysis-board-container' : 'game-board-container';
    const container = document.getElementById(containerId);

    if (container && board.parentElement !== container) {
      const handle = container.querySelector('#board-resize-handle');
      if (handle) container.insertBefore(board, handle);
      else container.appendChild(board);
    }

    board.classList.add('ch-board');
    applyBoardSize(_boardPx);
    bindBoardEvents(board);
    initResizeHandle();

    return board;
  }

  function getActiveState() {
    return viewingMove >= 0 && viewingMove < historyStates.length
      ? historyStates[viewingMove] : state;
  }

  function getSquareFromPoint(clientX, clientY) {
    const board = document.getElementById('chess-board');
    if (!board) return null;
    const rect = board.getBoundingClientRect();
    const left = rect.left + board.clientLeft;
    const top  = rect.top  + board.clientTop;
    const w = board.clientWidth;
    const h = board.clientHeight;
    if (clientX < left || clientX >= left + w || clientY < top || clientY >= top + h) {
      return null;
    }
    const col = Math.min(7, Math.max(0, Math.floor((clientX - left) / (w / 8))));
    const row = Math.min(7, Math.max(0, Math.floor((clientY - top)  / (h / 8))));
    const r = isFlipped ? row : 7 - row;
    const f = isFlipped ? 7 - col : col;
    return r * 8 + f;
  }

  function ensureSquares(board) {
    if (board._sqSlots && board._sqSlots.length === 64 && board._sqSlots[0].parentElement === board) {
      return board._sqSlots;
    }
    board.querySelectorAll('.square').forEach(n => n.remove());
    const slots = [];
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 64; i++) {
      const el = document.createElement('div');
      el.className = 'square';
      frag.appendChild(el);
      slots.push(el);
    }
    board.prepend(frag);
    board._sqSlots = slots;
    return slots;
  }

  function isMovablePiece(piece, activeState) {
    if (!piece) return false;
    if (gameMode === 'online') return piece.color === playerColor;
    return piece.color === activeState.turn;
  }

  // Завершение ПКМ-жеста: кружок/стрелка или очистка.
  // Защита от двойной обработки: pointerup + запасной mouseup.
  function finishRmbGesture(e) {
    if (!rmbGestureActive) return;
    rmbGestureActive = false;
    window.removeEventListener('pointerup', onRmbPointerUp);
    window.removeEventListener('mouseup', onRmbMouseUp);
    window.removeEventListener('pointercancel', onRmbPointerCancel);

    const board = document.getElementById('chess-board');
    const endSq = getSquareFromPoint(e.clientX, e.clientY);
    const color = e.shiftKey ? 'rgba(224,72,72,0.88)'
      : e.altKey ? 'rgba(70,140,235,0.88)'
      : 'rgba(21,184,58,0.88)';

    if (rmbStartSq === null) {
      if (premove) { clearPremove(); render(); }
      else { annotations = []; renderAnnotationsSVG(board); }
    } else if (endSq === null || endSq === rmbStartSq) {
      if (premove) {
        clearPremove();
        selectedSq = null;
        legalMovesCache = [];
        render();
      } else {
        toggleCircle(rmbStartSq, color);
        renderAnnotationsSVG(board);
      }
    } else {
      if (premove) {
        clearPremove();
        selectedSq = null;
        legalMovesCache = [];
        render();
      }
      toggleArrow(rmbStartSq, endSq, color);
      renderAnnotationsSVG(board);
    }
    rmbStartSq = null;
  }

  function onRmbPointerUp(e) {
    if (e.button !== 2) return;
    finishRmbGesture(e);
  }

  // Запасной путь: на некоторых платформах pointerup для ПКМ
  // не долетает — жест завершаем по mouseup
  function onRmbMouseUp(e) {
    if (e.button !== 2) return;
    finishRmbGesture(e);
  }

  function onRmbPointerCancel() {
    rmbGestureActive = false;
    window.removeEventListener('pointerup', onRmbPointerUp);
    window.removeEventListener('mouseup', onRmbMouseUp);
    window.removeEventListener('pointercancel', onRmbPointerCancel);
    rmbStartSq = null;
  }

  function bindBoardEvents(board) {
    if (board._chEventsBound) return;
    board._chEventsBound = true;

    board.addEventListener('contextmenu', (e) => e.preventDefault());

    // Колёсико мыши листает ходы в режиме анализа
    let lastWheel = 0;
    board.addEventListener('wheel', (e) => {
      if (gameMode !== 'analysis') return;
      if (Math.abs(e.deltaY) < 8) return;
      e.preventDefault();
      const now = Date.now();
      if (now - lastWheel < 65) return;
      lastWheel = now;
      if (e.deltaY > 0) gotoNext();
      else gotoPrev();
    }, { passive: false });

    board.addEventListener('pointerdown', (e) => {
      // ПКМ — кружки и стрелки (Ctrl+ЛКМ на Mac не трогаем — тоже для стрелок)
      if (e.button === 2) {
        e.preventDefault();
        rmbStartSq = getSquareFromPoint(e.clientX, e.clientY);
        rmbGestureActive = true;
        window.addEventListener('pointerup', onRmbPointerUp);
        window.addEventListener('mouseup', onRmbMouseUp);
        window.addEventListener('pointercancel', onRmbPointerCancel);
        return;
      }
      if (e.button !== 0) return;

      if (annotations.length) {
        clearAnnotations();
        renderAnnotationsSVG(board);
      }

      const sq = getSquareFromPoint(e.clientX, e.clientY);
      if (sq === null) return;

      if (gameMode !== 'analysis' && viewingMove !== -1) return;

      const activeState = getActiveState();
      const piece = activeState.board[sq];
      const isMyTurn = gameMode !== 'online' || activeState.turn === playerColor;

      // Онлайн: не наш ход → планируем или снимаем преймув
      if (gameMode === 'online' && !isMyTurn) {
        if (selectedSq !== null && (!piece || piece.color !== playerColor)) {
          if (sq !== selectedSq) setPremove(selectedSq, sq);
          selectedSq = null;
          legalMovesCache = [];
          render();
          return;
        }
        if (piece && piece.color === playerColor) {
          startPointerDrag(e, sq, piece, activeState, false);
        } else {
          selectedSq = null;
          legalMovesCache = [];
          clearPremove();
          render();
        }
        return;
      }

      // Уже выбрана фигура и нажали на допустимую цель (не на свою фигуру)
      if (selectedSq !== null && sq !== selectedSq && !isMovablePiece(piece, activeState)) {
        const move = legalMovesCache.find(m => m.to === sq);
        if (move) {
          attemptMove(selectedSq, sq, activeState);
          return;
        }
        selectedSq = null;
        legalMovesCache = [];
        render();
        return;
      }

      // Нажали на свою фигуру (начало клика или перетаскивания)
      if (isMovablePiece(piece, activeState)) {
        startPointerDrag(e, sq, piece, activeState, true);
        return;
      }

      if (selectedSq !== null) {
        selectedSq = null;
        legalMovesCache = [];
        render();
      }
    });
  }

  function startPointerDrag(e, sq, piece, activeState, calcLegal) {
    e.preventDefault();
    cleanupDrag();

    const wasSelected = (selectedSq === sq);
    clearPremove();
    selectedSq = sq;
    legalMovesCache = calcLegal ? ChessEngine.legalMoves(activeState, sq) : [];
    render();

    const board = document.getElementById('chess-board');
    const sqSize = board ? board.clientWidth / 8 : 64;

    dragState = {
      fromSq: sq,
      pieceKey: piece.color + piece.type,
      startX: e.clientX,
      startY: e.clientY,
      sqSize,
      active: false,
      ghost: null,
      wasSelected
    };

    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  }

  function onPointerMove(e) {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;

    if (!dragState.active && Math.hypot(dx, dy) >= 5) {
      dragState.active = true;
      const ghost = document.createElement('div');
      ghost.className = 'piece-dragging';
      ghost.style.cssText = `position:fixed;pointer-events:none;z-index:9999;transform:translate(-50%,-50%) scale(1.14);display:flex;align-items:center;justify-content:center;width:${dragState.sqSize}px;height:${dragState.sqSize}px;left:${e.clientX}px;top:${e.clientY}px;`;
      const img = document.createElement('img');
      img.src = PIECE_IMGS[dragState.pieceKey];
      img.alt = dragState.pieceKey;
      img.draggable = false;
      img.style.cssText = 'width:90%;height:90%;object-fit:contain;filter:drop-shadow(0 10px 18px rgba(0,0,0,0.65));';
      ghost.appendChild(img);
      document.body.appendChild(ghost);
      dragState.ghost = ghost;

      const board = document.getElementById('chess-board');
      const originSlot = board?.querySelector(`.square[data-sq="${dragState.fromSq}"]`);
      if (originSlot) originSlot.classList.add('dragging-origin');
    }

    if (dragState.active && dragState.ghost) {
      e.preventDefault();
      dragState.ghost.style.left = e.clientX + 'px';
      dragState.ghost.style.top  = e.clientY + 'px';

      const newHover = getSquareFromPoint(e.clientX, e.clientY);
      if (newHover !== hoverSq) {
        const board = document.getElementById('chess-board');
        if (board && hoverSq !== null) {
          board.querySelector(`.square[data-sq="${hoverSq}"]`)?.classList.remove('drag-over');
        }
        hoverSq = newHover;
        if (board && hoverSq !== null) {
          board.querySelector(`.square[data-sq="${hoverSq}"]`)?.classList.add('drag-over');
        }
      }
    }
  }

  function onPointerUp(e) {
    if (!dragState || e.button !== 0) return;
    const ds = dragState;
    const targetSq = getSquareFromPoint(e.clientX, e.clientY);
    cleanupDrag();

    const activeState = getActiveState();
    const isMyTurn = gameMode !== 'online' || activeState.turn === playerColor;

    if (ds.active) {
      if (targetSq !== null && targetSq !== ds.fromSq) {
        if (gameMode === 'online' && !isMyTurn) {
          setPremove(ds.fromSq, targetSq);
          selectedSq = null;
          legalMovesCache = [];
          render();
          return;
        }
        attemptMove(ds.fromSq, targetSq, activeState);
      } else if (targetSq === ds.fromSq) {
        selectedSq = ds.fromSq;
        render();
      } else {
        selectedSq = null;
        legalMovesCache = [];
        render();
      }
    } else {
      if (ds.wasSelected) {
        selectedSq = null;
        legalMovesCache = [];
        render();
      }
    }
  }

  function onPointerCancel() {
    if (!dragState) return;
    cleanupDrag();
    render();
  }

  function cleanupDrag() {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    if (dragState?.ghost) dragState.ghost.remove();
    const board = document.getElementById('chess-board');
    if (board) {
      board.querySelectorAll('.dragging-origin').forEach(el => el.classList.remove('dragging-origin'));
      board.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    }
    dragState = null;
    hoverSq = null;
  }

  function attemptMove(fromSq, toSq, activeState) {
    const freshMoves = ChessEngine.legalMoves(activeState, fromSq);
    const move = freshMoves.find(m => m.to === toSq);
    if (!move) {
      selectedSq = null;
      legalMovesCache = [];
      render();
      return false;
    }

    if (move.promotion) {
      const promotions = freshMoves.filter(m => m.to === toSq && m.promotion);
      if (promotions.length > 1) {
        showPromotionDialog(activeState.turn, (promo) => {
          const pm = promotions.find(m => m.promotion === promo) || promotions[0];
          executeMove(pm);
        });
        return true;
      }
    }
    executeMove(move);
    return true;
  }

  function render() {
    const board = getBoardEl();
    if (!board) return;

    const displayState = getActiveState();
    const inCheckSq = findCheckSquare(displayState);
    const slots = ensureSquares(board);

    const showCoords = typeof getSettings === 'function' ? getSettings().coords !== false : true;
    const showHints  = typeof getSettings === 'function' ? getSettings().hints  !== false : true;
    const showAnim   = typeof getSettings === 'function' ? getSettings().animation !== false : true;

    const legalSet   = new Set();
    const captureSet = new Set();
    if (showHints && legalMovesCache.length) {
      for (const m of legalMovesCache) {
        if (displayState.board[m.to] || m.enPassant) captureSet.add(m.to);
        else legalSet.add(m.to);
      }
    }

    for (let i = 0; i < 64; i++) {
      const rowIdx = Math.floor(i / 8);
      const colIdx = i % 8;
      const r = isFlipped ? rowIdx : 7 - rowIdx;
      const f = isFlipped ? 7 - colIdx : colIdx;
      const sq = r * 8 + f;
      const light = (r + f) % 2 !== 0;
      const piece = displayState.board[sq];
      const slot = slots[i];

      let cls = `square ${light ? 'light' : 'dark'}`;
      if (sq === selectedSq) cls += ' selected';
      if (lastMove && (sq === lastMove.from || sq === lastMove.to)) cls += ' last-move';
      if (inCheckSq === sq) cls += ' in-check';
      if (premoveSquares.includes(sq)) cls += ' premove';
      if (captureSet.has(sq)) cls += ' legal-capture';
      else if (legalSet.has(sq)) cls += ' legal-move';
      if (dragState?.active && dragState.fromSq === sq) cls += ' dragging-origin';
      if (hoverSq === sq) cls += ' drag-over';

      if (slot.className !== cls) slot.className = cls;
      if (slot.dataset.sq !== String(sq)) slot.dataset.sq = sq;

      const coordColor = light ? 'var(--board-dark)' : 'var(--board-light)';
      const wantRank = showCoords && colIdx === 0 ? String(r + 1) : '';
      const wantFile = showCoords && rowIdx === 7 ? String.fromCharCode(97 + f) : '';
      let rankEl = slot._rankEl;
      if (wantRank) {
        if (!rankEl) {
          rankEl = document.createElement('span');
          rankEl.className = 'sq-coord sq-coord-rank';
          rankEl.style.cssText = 'position:absolute;left:4px;top:3px;font-family:var(--font-body);font-size:var(--sq-coord-fs,12px);font-weight:700;line-height:1;pointer-events:none;user-select:none;z-index:2;opacity:0.92;';
          slot.appendChild(rankEl);
          slot._rankEl = rankEl;
        }
        if (rankEl.textContent !== wantRank) rankEl.textContent = wantRank;
        rankEl.style.color = coordColor;
      } else if (rankEl) {
        rankEl.remove();
        slot._rankEl = null;
      }

      let fileEl = slot._fileEl;
      if (wantFile) {
        if (!fileEl) {
          fileEl = document.createElement('span');
          fileEl.className = 'sq-coord sq-coord-file';
          // В правом нижнем углу доски буква прячется под ручкой ресайза —
          // там ставим её в нижний левый угол клетки
          const filePos = (rowIdx === 7 && colIdx === 7)
            ? 'left:4px;bottom:2px;' : 'right:4px;bottom:2px;';
          fileEl.style.cssText = 'position:absolute;' + filePos + 'font-family:var(--font-body);font-size:var(--sq-coord-fs,12px);font-weight:700;line-height:1;pointer-events:none;user-select:none;z-index:2;opacity:0.92;';
          slot.appendChild(fileEl);
          slot._fileEl = fileEl;
        }
        if (fileEl.textContent !== wantFile) fileEl.textContent = wantFile;
        fileEl.style.color = coordColor;
      } else if (fileEl) {
        fileEl.remove();
        slot._fileEl = null;
      }

      const pieceKey = piece ? (piece.color + piece.type) : '';
      if (slot._pieceKey !== pieceKey) {
        slot._pieceKey = pieceKey;
        if (slot._pieceEl) {
          slot._pieceEl.remove();
          slot._pieceEl = null;
        }
        if (pieceKey) {
          const pDiv = document.createElement('div');
          pDiv.className = 'piece';
          const img = document.createElement('img');
          img.src = PIECE_IMGS[pieceKey];
          img.alt = pieceKey;
          img.draggable = false;
          img.style.transition = showAnim ? 'transform 0.1s' : 'none';
          pDiv.appendChild(img);
          slot.appendChild(pDiv);
          slot._pieceEl = pDiv;
        }
      } else if (slot._pieceEl?.firstChild) {
        slot._pieceEl.firstChild.style.transition = showAnim ? 'transform 0.1s' : 'none';
      }
    }

    renderAnnotationsSVG(board);
    renderMoveList();
    updateCapturedPieces(displayState);

    const pmIndicator = document.getElementById('premove-indicator');
    if (pmIndicator) {
      pmIndicator.classList.toggle('visible', premove !== null);
    }
    document.dispatchEvent(new CustomEvent('board:render'));
  }

  // АННОТАЦИИ: кружки и стрелки (viewBox 0..100 — надёжно во всех браузерах)
  function toggleCircle(sq, color) {
    const col = color || 'rgba(21,184,58,0.88)';
    const idx = annotations.findIndex(a => a.type === 'circle' && a.sq === sq);
    if (idx >= 0) {
      if (annotations[idx].color === col) annotations.splice(idx, 1);
      else annotations[idx].color = col;
    } else {
      annotations.push({ type: 'circle', sq, color: col });
    }
  }

  function toggleArrow(from, to, color) {
    const col = color || 'rgba(21,184,58,0.88)';
    const idx = annotations.findIndex(a => a.type === 'arrow' && a.from === from && a.to === to);
    if (idx >= 0) {
      if (annotations[idx].color === col) annotations.splice(idx, 1);
      else annotations[idx].color = col;
    } else {
      annotations.push({ type: 'arrow', from, to, color: col });
    }
  }

  function clearAnnotations() {
    annotations = [];
  }

  function sqToColRow(sq) {
    const file = sq % 8;
    const rank = Math.floor(sq / 8);
    const col  = isFlipped ? 7 - file : file;
    const row  = isFlipped ? rank     : 7 - rank;
    return { col, row };
  }

  function renderAnnotationsSVG(board) {
    if (!board) return;
    let svg = board.querySelector('.board-annotations-svg');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'board-annotations-svg');
      svg.setAttribute('viewBox', '0 0 100 100');
      svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:10;overflow:visible';
      board.style.position = 'relative';
      board.appendChild(svg);
    }

    if (!annotations.length) { svg.innerHTML = ''; return; }

    const cell = 12.5; // 100 / 8
    let shapes = '';
    for (const ann of annotations) {
      const col = ann.color || 'rgba(21,184,58,0.88)';
      if (ann.type === 'circle') {
        const p = sqToColRow(ann.sq);
        const cx = (p.col + 0.5) * cell;
        const cy = (p.row + 0.5) * cell;
        shapes += `<circle cx="${cx}" cy="${cy}" r="5.45" fill="none" stroke="${col}" stroke-width="1.05" />`;
      } else if (ann.type === 'arrow') {
        const f = sqToColRow(ann.from);
        const t = sqToColRow(ann.to);
        const x1 = (f.col + 0.5) * cell;
        const y1 = (f.row + 0.5) * cell;
        const x2 = (t.col + 0.5) * cell;
        const y2 = (t.row + 0.5) * cell;

        const a = Math.atan2(y2 - y1, x2 - x1);
        const sx = x1 + Math.cos(a) * 2.2;
        const sy = y1 + Math.sin(a) * 2.2;
        const ex = x2 - Math.cos(a) * 4.2;
        const ey = y2 - Math.sin(a) * 4.2;
        const w = 2.6;

        shapes += `<line x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}" stroke="${col}" stroke-width="2.1" stroke-linecap="round"/>`
          + `<polygon fill="${col}" points="${x2},${y2} ${ex - Math.sin(a) * w},${ey + Math.cos(a) * w} ${ex + Math.sin(a) * w},${ey - Math.cos(a) * w}"/>`;
      }
    }
    svg.innerHTML = shapes;
  }

  function findCheckSquare(st) {
    const kingSq = ChessEngine.findKing(st, st.turn);
    if (kingSq === -1) return null;
    return ChessEngine.isAttacked(st, kingSq, ChessEngine.opposite(st.turn)) ? kingSq : null;
  }

  // Обратная совместимость
  function handleClick(sq) {
    if (gameMode !== 'analysis' && viewingMove !== -1) return;
    const activeState = getActiveState();
    const piece = activeState.board[sq];
    if (selectedSq === null) {
      if (!isMovablePiece(piece, activeState)) return;
      selectedSq = sq;
      legalMovesCache = ChessEngine.legalMoves(activeState, sq);
      render();
      return;
    }
    if (sq === selectedSq) { selectedSq = null; legalMovesCache = []; render(); return; }
    if (isMovablePiece(piece, activeState)) {
      selectedSq = sq;
      legalMovesCache = ChessEngine.legalMoves(activeState, sq);
      render();
      return;
    }
    attemptMove(selectedSq, sq, activeState);
  }
  function handleDragStart() {}
  function handleDragEnd() {}
  function handleDrop() {}

  function setPremove(from, to, promotion) {
    premove = { from, to, promotion: promotion || null };
    premoveSquares = [from, to];
  }

  function clearPremove() {
    premove = null;
    premoveSquares = [];
  }

  function executeMove(move) {
    if (gameMode === 'analysis' && viewingMove >= 0 && viewingMove < historyStates.length - 1) {
      const fullHist = state.history || [];
      state = ChessEngine.deepClone(historyStates[viewingMove]);
      if (!Array.isArray(state.history)) {
        state.history = fullHist.slice(0, viewingMove);
      }
      historyStates = historyStates.slice(0, viewingMove + 1);
      viewingMove = -1;
    }

    const san = ChessEngine.toSAN(state, move);
    const prevState = ChessEngine.deepClone(state);
    state = ChessEngine.applyMove(state, move);
    state.history = [...(prevState.history || []), { ...move, san, fen: ChessEngine.toFEN(state) }];
    state.capturedWhite = [...(prevState.capturedWhite || []), ...(state.capturedWhite.slice((prevState.capturedWhite || []).length))];
    state.capturedBlack = [...(prevState.capturedBlack || []), ...(state.capturedBlack.slice((prevState.capturedBlack || []).length))];

    historyStates.push(ChessEngine.deepClone(state));
    viewingMove = -1;
    lastMove = move;
    selectedSq = null;
    legalMovesCache = [];

    playSound(move, prevState);

    if (gameMode === 'online' && socket) {
      if (typeof emitGameplayEvent === 'function') {
        emitGameplayEvent('make_move', { gameId, move });
      } else {
        socket.emit('make_move', { gameId, move });
      }
    }

    checkGameStatus();
    tickClock();
    render();

    if (gameMode === 'analysis') {
      if (typeof requestAnalysis === 'function') requestAnalysis();
    }
  }

  function applyOpponentMove(move, serverWhiteTime, serverBlackTime) {
    if (serverWhiteTime !== undefined && serverBlackTime !== undefined) {
      whiteTime = serverWhiteTime;
      blackTime = serverBlackTime;
      clockTickAt = Date.now();
    }
    const san = ChessEngine.toSAN(state, move);
    const prevState = ChessEngine.deepClone(state);
    state = ChessEngine.applyMove(state, move);
    state.history = [...(prevState.history || []), { ...move, san, fen: ChessEngine.toFEN(state) }];
    historyStates.push(ChessEngine.deepClone(state));
    viewingMove = -1;
    lastMove = move;
    playSound(move, prevState);
    checkGameStatus();
    tickClock();

    if (premove && gameMode === 'online') {
      const pm = premove;
      clearPremove();
      const legalPremoves = ChessEngine.legalMoves(state, pm.from);
      const promoPref = pm.promotion || 'Q';
      const legalPm = legalPremoves.find(m => m.to === pm.to && (!m.promotion || m.promotion === promoPref))
        || legalPremoves.find(m => m.to === pm.to);
      if (legalPm && state.board[pm.from]?.color === playerColor) {
        setTimeout(() => executeMove(legalPm), 50);
      }
    }

    render();
  }

  const DRAW_REASON_KEYS = {
    'stalemate':             'game.draw_stalemate',
    'fifty-move':            'game.draw_fifty',
    'insufficient-material': 'game.draw_material',
    'threefold-repetition':  'game.draw_repetition',
  };
  const DRAW_REASON_FALLBACK = {
    'stalemate':             'Пат',
    'fifty-move':            'Правило 50 ходов',
    'insufficient-material': 'Недостаточно материала для мата',
    'threefold-repetition':  'Троекратное повторение позиции',
  };
  function drawReasonText(reason) {
    const key = DRAW_REASON_KEYS[reason];
    return key ? T(key, DRAW_REASON_FALLBACK[reason]) : (reason || '');
  }

  function checkGameStatus() {
    const status = ChessEngine.getStatus(state);
    if (status.status === 'checkmate') {
      setTimeout(() => {
        showGameResult(status.winner === 'w' ? T('game.win_white', 'Белые победили!') : T('game.win_black', 'Чёрные победили!'), T('game.checkmate', 'Мат'));
        if (gameMode === 'online' && socket) {
          socket.emit('game_over', { gameId, result: status.winner, reason: 'checkmate' });
        }
        stopClock();
      }, 100);
    } else if (status.status === 'stalemate') {
      setTimeout(() => {
        showGameResult(T('game.draw', 'Ничья'), drawReasonText('stalemate'));
        if (gameMode === 'online' && socket) {
          socket.emit('game_over', { gameId, result: 'draw', reason: 'stalemate' });
        }
        stopClock();
      }, 100);
    } else if (status.status === 'draw') {
      setTimeout(() => {
        showGameResult(T('game.draw', 'Ничья'), drawReasonText(status.reason));
        if (gameMode === 'online' && socket) {
          socket.emit('game_over', { gameId, result: 'draw', reason: status.reason });
        }
        stopClock();
      }, 100);
    }
  }

  // ПРЕВРАЩЕНИЕ
  function showPromotionDialog(color, callback) {
    const overlay = document.getElementById('modal-promotion');
    const pieces = overlay.querySelectorAll('.promo-piece-btn');
    pieces.forEach(btn => {
      const type = btn.dataset.piece;
      btn.querySelector('img').src = PIECE_IMGS[color + type];
      btn.onclick = () => {
        overlay.classList.remove('open');
        callback(type);
      };
    });
    overlay.classList.add('open');
  }

  // СПИСОК ХОДОВ
  function renderMoveList() {
    const table = document.getElementById('moves-table-body');
    if (!table) return;
    const moves = state.history || [];
    let html = '';
    for (let i = 0; i < moves.length; i += 2) {
      const wMove = moves[i];
      const bMove = moves[i + 1];
      const wIdx = i;
      const bIdx = i + 1;
      const curStateIdx = viewingMove === -1 ? historyStates.length - 1 : viewingMove;
      const wCurrent = curStateIdx === wIdx + 1;
      const bCurrent = bMove && curStateIdx === bIdx + 1;
      html += `<tr>
        <td>${Math.floor(i / 2) + 1}.</td>
        <td class="move-cell ${wCurrent ? 'current' : ''}" data-ply="${wIdx + 1}" onclick="chessBoard.gotoMove(${wIdx + 1})">${wMove.san}</td>
        <td class="move-cell ${bCurrent ? 'current' : ''}" data-ply="${bMove ? bIdx + 1 : ''}" ${bMove ? `onclick="chessBoard.gotoMove(${bIdx + 1})"` : ''}>${bMove ? bMove.san : ''}</td>
      </tr>`;
    }
    table.innerHTML = html;
    // Автоскролл — ТОЛЬКО внутри контейнера списка ходов.
    // scrollIntoView() прокручивает всех прокручиваемых предков, включая сам
    // документ: на телефоне браузер при каждом тапе по доске панорамирует экран вбок
    // (или вниз), чтобы показать клетку с текущим ходом. Прокручиваем
    // getBoundingClientRect-ами только .moves-list — страница не трогается.
    const movesDiv = table.closest('.moves-list');
    const curCell = table.querySelector('.move-cell.current');
    if (curCell && movesDiv) {
      const cd = curCell.getBoundingClientRect();
      const md = movesDiv.getBoundingClientRect();
      if (cd.top < md.top) movesDiv.scrollTop += cd.top - md.top;
      else if (cd.bottom > md.bottom) movesDiv.scrollTop += cd.bottom - md.bottom;
      if (cd.left < md.left) movesDiv.scrollLeft += cd.left - md.left;
      else if (cd.right > md.right) movesDiv.scrollLeft += cd.right - md.right;
    } else if (movesDiv) {
      movesDiv.scrollTop = movesDiv.scrollHeight;
    }
  }

  function gotoMove(idx) {
    selectedSq = null;
    legalMovesCache = [];
    if (idx >= historyStates.length - 1) { viewingMove = -1; }
    else { viewingMove = Math.max(0, idx); }
    const active = getActiveState();
    const hist = active.history || [];
    lastMove = hist.length ? hist[hist.length - 1] : null;
    render();
  }

  function gotoFirst() { gotoMove(0); }
  function gotoPrev() {
    const cur = viewingMove === -1 ? historyStates.length - 1 : viewingMove;
    gotoMove(Math.max(0, cur - 1));
  }
  function gotoNext() {
    const cur = viewingMove === -1 ? historyStates.length - 1 : viewingMove;
    gotoMove(cur + 1);
  }
  function gotoLast() { gotoMove(historyStates.length - 1); }

  // CLOCK
  let tcIncrement = 0;
  let clockTickAt = null;

  function startClock(wTime, bTime, tc, opts) {
    const parsed = parseTC(tc || '10+0');
    whiteTime = wTime !== undefined ? wTime : parsed[0] * 60;
    blackTime = bTime !== undefined ? bTime : parsed[0] * 60;
    tcIncrement = parsed[1] || 0;
    activeColor = 'w';
    clockRunning = false;
    clockTickAt = null;
    clearInterval(clockInterval);

    if (opts && opts.autoStart) {
      clockRunning = true;
      clockTickAt = Date.now();
      clockInterval = setInterval(clockTick_interval, 100);
    }
    updateClockDisplay();
  }

  function tickClock() {
    const now = Date.now();
    const justMoved = state.turn === 'w' ? 'b' : 'w';

    if (clockRunning && clockTickAt !== null) {
      const elapsed = (now - clockTickAt) / 1000;
      if (justMoved === 'w') whiteTime = Math.max(0, whiteTime - elapsed);
      else                    blackTime = Math.max(0, blackTime - elapsed);
    }

    if (clockRunning && tcIncrement > 0) {
      if (justMoved === 'w') whiteTime = whiteTime + tcIncrement;
      else blackTime += tcIncrement;
    }

    activeColor = state.turn;
    clockTickAt = now;

    if (!clockRunning) {
      const totalMoves = state.history ? state.history.length : 0;
      if (totalMoves >= 2) {
        clockRunning = true;
        clockInterval = setInterval(clockTick_interval, 100);
      }
    }

    updateClockDisplay();
  }

  function clockTick_interval() {
    if (!clockRunning || clockTickAt === null) return;
    const now = Date.now();
    const elapsed = (now - clockTickAt) / 1000;
    const displayWhite = activeColor === 'w' ? Math.max(0, whiteTime - elapsed) : whiteTime;
    const displayBlack = activeColor === 'b' ? Math.max(0, blackTime - elapsed) : blackTime;

    updateClockDisplayValues(displayWhite, displayBlack);

    if ((activeColor === 'w' && displayWhite <= 0) || (activeColor === 'b' && displayBlack <= 0)) {
      const loser = activeColor;
      if (loser === 'w') whiteTime = 0; else blackTime = 0;
      stopClock();
    }
  }

  function stopClock() {
    if (clockRunning && clockTickAt !== null) {
      const elapsed = (Date.now() - clockTickAt) / 1000;
      if (activeColor === 'w') whiteTime = Math.max(0, whiteTime - elapsed);
      else                      blackTime = Math.max(0, blackTime - elapsed);
    }
    clockRunning = false;
    clockTickAt = null;
    clearInterval(clockInterval);
    updateClockDisplay();
  }

  function syncClockFromServer(serverWhite, serverBlack) {
    if (serverWhite === undefined || serverBlack === undefined) return;
    whiteTime = serverWhite;
    blackTime = serverBlack;
    clockTickAt = Date.now();
    updateClockDisplay();
  }

  function parseTC(tc) {
    const [baseRaw, incRaw] = String(tc || '10+0').split('+');
    let min;
    if (/s$/i.test(baseRaw)) min = (parseFloat(baseRaw) || 15) / 60;
    else min = parseFloat(baseRaw);
    if (!isFinite(min) || min <= 0) min = 10;
    return [min, parseInt(incRaw, 10) || 0];
  }

  function updateClockDisplay() {
    const elapsed = (clockRunning && clockTickAt !== null) ? (Date.now() - clockTickAt) / 1000 : 0;
    const displayWhite = activeColor === 'w' ? Math.max(0, whiteTime - elapsed) : whiteTime;
    const displayBlack = activeColor === 'b' ? Math.max(0, blackTime - elapsed) : blackTime;
    updateClockDisplayValues(displayWhite, displayBlack);
  }

  function updateClockDisplayValues(wTime, bTime) {
    const bottomEl = document.getElementById('clock-white');
    const topEl    = document.getElementById('clock-black');
    const myTime    = playerColor === 'w' ? wTime : bTime;
    const theirTime = playerColor === 'w' ? bTime : wTime;
    const myTurn = activeColor === playerColor;

    if (bottomEl) {
      bottomEl.textContent = formatClock(myTime);
      bottomEl.className = 'player-clock' + (myTurn && clockRunning ? ' active' : '') + (myTime < 30 ? ' low' : '');
    }
    if (topEl) {
      topEl.textContent = formatClock(theirTime);
      topEl.className = 'player-clock' + (!myTurn && clockRunning ? ' active' : '') + (theirTime < 30 ? ' low' : '');
    }
  }

  function formatClock(sec) {
    const totalSec = Math.max(0, Math.floor(sec));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  // ЗВУКИ
  let _soundCtx = null;
  function playSound(move, prevState) {
    const settings = typeof getSettings === 'function' ? getSettings() : { sounds: true };
    if (!settings.sounds) return;
    try {
      if (!_soundCtx) _soundCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (_soundCtx.state === 'suspended') _soundCtx.resume().catch(() => {});
    } catch (e) { return; }
    const ctx = _soundCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
    const wasCapture = move.enPassant || (prevState ? prevState.board[move.to] !== null : false);
    osc.frequency.value = wasCapture ? 300 : move.castle ? 500 : 440;
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.15);
  }

  // GAME RESULT
  function showGameResult(title, subtitle, tId) {
    const overlay = document.getElementById('modal-game-result');
    if (!overlay) return;
    overlay.querySelector('#result-title').textContent = title;
    overlay.querySelector('#result-subtitle').textContent = subtitle;
    const tBtn = document.getElementById('result-tournament-btn');
    if (tBtn) { tBtn.style.display = tId ? '' : 'none'; if (tId) tBtn.dataset.tid = tId; }
    overlay.classList.add('open');
  }

  function onGameEnded(data) {
    stopClock();
    clearPremove();
    const myColorFull = playerColor === 'w' ? 'white' : 'black';
    const win  = data.result === myColorFull;
    const draw = data.result === 'draw';
    let reasonText = '';
    if (data.reason === 'resign') {
      reasonText = win ? T('game.opponent_resigned', 'Соперник сдался') : T('game.you_resigned', 'Вы сдались');
    } else if (data.reason === 'opponent_resign') {
      reasonText = T('game.opponent_resigned', 'Соперник сдался');
    } else {
      const reasons = {
        checkmate: T('game.checkmate', 'Мат'),
        timeout:   T('game.time_out', 'Время вышло'),
        timeout_firstmove: T('game.time_out_first_move', 'Время на первый ход вышло'),
        agreement: T('game.by_agreement', 'По соглашению'),
        anticheat_admin: T('game.anticheat_admin', 'Ваш соперник заблокирован за использование читов'),
        anticheat: T('game.anticheat', 'Заблокирован за использование читов'),
      };
      reasonText = reasons[data.reason] || drawReasonText(data.reason) || '';
    }
    const emoji = draw ? '🤝' : win ? '🏆' : '😔';
    const _tId   = _tournamentId;
    const _tName = _tournamentName;
    _tournamentId = null; _tournamentName = null;
    showGameResult(
      emoji + ' ' + (draw ? T('game.draw', 'Ничья') : win ? T('game.victory', 'Победа!') : T('game.defeat', 'Поражение')),
      reasonText,
      _tId
    );
    if (_tId && typeof showTournamentReturnBanner === 'function') {
      showTournamentReturnBanner(_tId, _tName);
    }
    refreshCurrentUser();
  }

  // INIT GAME
  function resyncFromServer(data) {
    if (gameMode !== 'online') return;
    const wasViewingLive = viewingMove === -1;
    state = ChessEngine.parseFEN(ChessEngine.START_FEN);
    historyStates = [ChessEngine.deepClone(state)];
    lastMove = null;
    selectedSq = null;
    legalMovesCache = [];
    clearPremove();

    for (const move of (data.moves || [])) {
      try {
        const san = ChessEngine.toSAN(state, move);
        const newState = ChessEngine.applyMove(state, move);
        if (newState) {
          newState.history = [...(state.history || []), { ...move, san, fen: ChessEngine.toFEN(newState) }];
          state = newState;
          historyStates.push(ChessEngine.deepClone(state));
          lastMove = move;
        }
      } catch (e) { console.warn('resync applyMove error', e); break; }
    }
    if (wasViewingLive) viewingMove = -1;

    if (data.whiteTime !== undefined && data.blackTime !== undefined) {
      whiteTime = data.whiteTime;
      blackTime = data.blackTime;
    }
    activeColor = state.turn;
    clockTickAt = Date.now();
    updateClockDisplay();

    render();
    checkGameStatus();
  }

  function startGame(data) {
    state = ChessEngine.parseFEN(ChessEngine.START_FEN);
    historyStates = [ChessEngine.deepClone(state)];
    viewingMove = -1;
    lastMove = null;
    selectedSq = null;
    legalMovesCache = [];
    clearPremove();
    gameMode = 'online';
    gameId = data.gameId;
    playerColor = data.color === 'white' ? 'w' : 'b';
    gameOpponent = data.opponent;
    isFlipped = playerColor === 'b';
    _tournamentId   = data.tournamentId   || null;
    _tournamentName = data.tournamentName || null;

    document.getElementById('player-bottom-name').textContent =
      currentUser.username + (playerColor === 'w' ? ' ♙' : ' ♟');
    document.getElementById('player-top-name').textContent =
      gameOpponent + (playerColor === 'w' ? ' ♟' : ' ♙');

    clearChatMessages();

    if (data.moves && data.moves.length > 0) {
      for (const move of data.moves) {
        try {
          const san = ChessEngine.toSAN(state, move);
          const newState = ChessEngine.applyMove(state, move);
          if (newState) {
            newState.history = [...(state.history || []), { ...move, san, fen: ChessEngine.toFEN(newState) }];
            state = newState;
            historyStates.push(ChessEngine.deepClone(state));
            lastMove = move;
          }
        } catch(e) { console.warn('rejoin applyMove error', e); break; }
      }
      viewingMove = -1;

      const [min, inc] = parseTC(data.timeControl || '10+0');
      const totalSec = min * 60;
      if (data.whiteTime !== undefined && data.blackTime !== undefined) {
        whiteTime = data.whiteTime;
        blackTime = data.blackTime;
        tcIncrement = inc || 0;
      } else {
        const movesW = Math.ceil(data.moves.length / 2);
        const movesB = Math.floor(data.moves.length / 2);
        whiteTime = Math.max(10, totalSec - movesW * 5);
        blackTime = Math.max(10, totalSec - movesB * 5);
        tcIncrement = inc || 0;
      }
      activeColor = state.turn;
      clockTickAt = Date.now();
      clockRunning = false;
      clearInterval(clockInterval);
      updateClockDisplay();
      clockRunning = true;
      clockInterval = setInterval(clockTick_interval, 100);
    } else {
      const [min] = parseTC(data.timeControl || '10+0');
      const startW = data.whiteTime !== undefined ? data.whiteTime : min * 60;
      const startB = data.blackTime !== undefined ? data.blackTime : min * 60;
      startClock(startW, startB, data.timeControl);
    }

    render();
    if (data.moves && data.moves.length > 0) {
      setTimeout(restoreChatFromSession, 150);
    }
    setTimeout(() => initSizeSlider(), 50);
  }

  function newLocalGame() {
    state = ChessEngine.parseFEN(ChessEngine.START_FEN);
    historyStates = [ChessEngine.deepClone(state)];
    viewingMove = -1; lastMove = null;
    selectedSq = null; legalMovesCache = [];
    gameMode = 'local'; gameId = null; playerColor = 'w';
    isFlipped = false;
    document.getElementById('player-bottom-name').textContent = T('game.player_white', 'Белые ♙');
    document.getElementById('player-top-name').textContent = T('game.player_black', 'Чёрные ♟');
    startClock(600, 600, '10+0');
    render();
  }

  function flipBoard() { isFlipped = !isFlipped; render(); }

  function resign() {
    if (!gameId || gameMode !== 'online') return;
    if (!confirm(T('game.resign_confirm', 'Сдаться?'))) return;
    socket.emit('resign', { gameId });
    stopClock();
  }

  function offerDraw() {
    if (!gameId || gameMode !== 'online') return;
    socket.emit('offer_draw', { gameId });
    toast(T('game.draw_offered_toast', 'Предложение ничьей отправлено'), 'info');
  }

  function clearChatMessages() {
    const el = document.getElementById('chat-messages');
    if (el) el.innerHTML = '';
    try { if (gameId) sessionStorage.removeItem('ch_game_chat_' + gameId); } catch {}
  }

  function saveChatToSession(from, message, isMine) {
    if (!gameId) return;
    try {
      const key = 'ch_game_chat_' + gameId;
      const msgs = JSON.parse(sessionStorage.getItem(key) || '[]');
      msgs.push({ from, message, isMine });
      if (msgs.length > 100) msgs.shift();
      sessionStorage.setItem(key, JSON.stringify(msgs));
    } catch {}
  }

  function restoreChatFromSession() {
    if (!gameId) return;
    try {
      const key = 'ch_game_chat_' + gameId;
      const msgs = JSON.parse(sessionStorage.getItem(key) || '[]');
      if (!msgs.length) return;
      const el = document.getElementById('chat-messages');
      if (!el) return;
      if (typeof appendChatMsg === 'function') {
        el._restoringChat = true;
        msgs.forEach(m => appendChatMsg(m.from, m.message, m.isMine));
        el._restoringChat = false;
      }
    } catch {}
  }

  function updateCapturedPieces(st) {
    const ORDER = ['Q','R','B','N','P'];
    const renderCap = (pieces) => (pieces || [])
      .slice()
      .sort((a,b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type))
      .map(p => `<img src="${PIECE_IMGS[p.color+p.type]}" style="width:20px;height:20px">`)
      .join('');
    const topEl = document.getElementById('captured-top');
    const botEl = document.getElementById('captured-bottom');
    if (topEl) topEl.innerHTML = renderCap(playerColor === 'w' ? st.capturedBlack : st.capturedWhite);
    if (botEl) botEl.innerHTML = renderCap(playerColor === 'w' ? st.capturedWhite : st.capturedBlack);
  }

  // ANALYSIS MODE
  function loadAnalysis() {
    state = ChessEngine.parseFEN(ChessEngine.START_FEN);
    historyStates = [ChessEngine.deepClone(state)];
    viewingMove = -1; lastMove = null;
    selectedSq = null; legalMovesCache = [];
    gameMode = 'analysis'; gameId = null; playerColor = 'w';
    isFlipped = false;
    stopClock();
    if (typeof AICommentator !== 'undefined') AICommentator.reset();
    render();
    if (typeof requestAnalysis === 'function') requestAnalysis();
  }

  function loadFEN(fen) {
    try {
      state = ChessEngine.parseFEN(fen);
      historyStates = [ChessEngine.deepClone(state)];
      viewingMove = -1; lastMove = null;
      selectedSq = null; legalMovesCache = [];
      if (typeof AICommentator !== 'undefined') AICommentator.reset();
      render();
      if (gameMode === 'analysis' && typeof requestAnalysis === 'function') requestAnalysis();
    } catch (e) { toast('Неверный FEN', 'error'); }
  }

  function loadGameMoves(moves) {
    state = ChessEngine.parseFEN(ChessEngine.START_FEN);
    historyStates = [ChessEngine.deepClone(state)];
    viewingMove = -1; lastMove = null;
    selectedSq = null; legalMovesCache = [];
    gameMode = 'analysis';
    gameId = null;
    isFlipped = false;
    stopClock();
    if (typeof AICommentator !== 'undefined') AICommentator.reset();

    for (const move of moves) {
      try {
        const san = ChessEngine.toSAN(state, move);
        const newState = ChessEngine.applyMove(state, move);
        if (!newState) break;
        newState.history = [...(state.history || []), { ...move, san, fen: ChessEngine.toFEN(newState) }];
        state = newState;
        historyStates.push(ChessEngine.deepClone(state));
        lastMove = move;
      } catch(e) { console.warn('loadGameMoves error', e); break; }
    }

    viewingMove = 0;
    lastMove = null;
    render();
    if (typeof requestAnalysis === 'function') requestAnalysis();
  }

  function getFEN() { return ChessEngine.toFEN(state); }

  let _resizeRaf = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(_resizeRaf);
    _resizeRaf = requestAnimationFrame(() => applyBoardSize(_boardPx));
  }, { passive: true });

  document.addEventListener('keydown', (e) => {
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    const isGamePage = document.getElementById('page-game')?.classList.contains('active')
      || document.getElementById('page-analysis')?.classList.contains('active');
    if (!isGamePage) return;
    if (e.key === 'ArrowLeft') { gotoPrev(); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { gotoNext(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { gotoFirst(); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { gotoLast(); e.preventDefault(); }
  });

  // PUBLIC API
  return {
    render,
    handleClick,
    handleDragStart,
    handleDragEnd,
    handleDrop,
    gotoMove,
    gotoFirst, gotoPrev, gotoNext, gotoLast,
    startGame,
    newLocalGame,
    loadAnalysis,
    loadFEN,
    loadGameMoves,
    getFEN,
    getViewFEN: () => ChessEngine.toFEN(getActiveState()),
    getFENs: () => historyStates.map(s => ChessEngine.toFEN(s)),
    get viewIndex() { return viewingMove >= 0 && viewingMove < historyStates.length ? viewingMove : historyStates.length - 1; },
    get flipped() { return isFlipped; },
    get history() { return state.history || []; },
    flipBoard,
    resign,
    offerDraw,
    applyOpponentMove,
    resyncFromServer,
    syncClockFromServer,
    clearPremove,
    clearAnnotations,
    onGameEnded,
    initSizeSlider,
    initResizeHandle,
    playUCI: (uci) => {
      if (!uci || uci.length < 4) return false;
      const from = uci.charCodeAt(0) - 97 + (parseInt(uci[1], 10) - 1) * 8;
      const to   = uci.charCodeAt(2) - 97 + (parseInt(uci[3], 10) - 1) * 8;
      const promo = uci[4] ? uci[4].toUpperCase() : null;
      const active = getActiveState();
      const moves = ChessEngine.legalMoves(active, from).filter(m => m.to === to);
      const m = (promo && moves.find(x => x.promotion === promo)) || moves[0];
      if (!m) return false;
      executeMove(m);
      return true;
    },
    get gameId()       { return gameId; },
    get tournamentId() { return _tournamentId; },
    get state()        { return state; },
    get playerColor()  { return playerColor; }
  };
})();