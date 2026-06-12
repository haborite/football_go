// 囲碁サッカー クライアント本体
// 画面遷移、NPC対戦（Web Worker）、オンライン対戦（WebSocket）、結果表示

import './style.css';
import { BoardScene } from './scene3d';
import {
  BLACK,
  Game,
  IllegalReason,
  MoveRecord,
  PlayerColor,
  WHITE,
} from '../shared/rules';
import {
  PASS_CODE,
  applyMoveCode,
  decodeKifu,
  encodeKifu,
  logToMoves,
  replayKifu,
} from '../shared/kifu';
import type { ChildStat } from '../shared/mcts';
import { sound } from './sound';
import { initTutorial } from './tutorial';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

// ---------- セッション ----------

interface NpcSession {
  kind: 'npc';
  game: Game;
  myColor: PlayerColor;
  workers: Worker[]; // ルート並列: 各ワーカーが独立に探索し訪問数を合算
  pending: { sims: number; children: ChildStat[] }[];
  thinking: boolean;
  timeMs: number;
}

interface OnlineSession {
  kind: 'online';
  game: Game;
  myColor: PlayerColor;
  ws: WebSocket;
  komi: number;
  room: string;
  undoCounts: Record<PlayerColor, number>;
  prevLogLen: number;
  ended: boolean; // 相手退出・切断で続行不能
  leaving: boolean; // 自分から退出した
}

interface ReplaySession {
  kind: 'replay';
  komi: number;
  moves: number[]; // 0-59=着点, 60=パス
  cursor: number; // 再生済み手数
  game: Game; // cursorまで再生済み
}

type Session = NpcSession | OnlineSession | ReplaySession;

let session: Session | null = null;
let scene: BoardScene | null = null;

// ---------- ユーティリティ ----------

function colorName(c: PlayerColor): string {
  return c === BLACK ? '黒' : '白';
}

function illegalText(reason: IllegalReason): string {
  switch (reason) {
    case 'occupied':
      return 'そこにはすでに石があります';
    case 'suicide':
      return 'ここには置けません：自滅手になるため（自滅禁止点）';
    case 'superko':
      return 'ここには置けません：過去と同じ盤面に戻るため（同形反復の禁止）';
    case 'gameover':
      return '対局はすでに終了しています';
  }
}

let toastTimer: number | undefined;
function toast(msg: string, ms = 3000) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  if (toastTimer !== undefined) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.add('hidden'), ms);
}

function showScreen(name: 'title' | 'game') {
  $('screen-title').classList.toggle('hidden', name !== 'title');
  $('screen-game').classList.toggle('hidden', name !== 'game');
  if (name === 'title') $('overlay-result').classList.add('hidden');
}

function myTurn(): boolean {
  if (!session || session.kind === 'replay') return false;
  return !session.game.over && session.game.turn === session.myColor;
}

// ---------- 3Dシーン ----------

function ensureScene() {
  if (scene) return;
  scene = new BoardScene($('board-container'), $('inset-frame'), {
    onPointClick: handlePointClick,
    ghostColor: () => {
      if (!session || session.kind === 'replay' || !myTurn()) return 0;
      if (session.kind === 'npc' && session.thinking) return 0;
      if (session.kind === 'online' && session.ended) return 0;
      return session.myColor;
    },
    canPlay: (p) => session !== null && session.game.tryPlace(p).ok,
  });
}

// ---------- 画面更新 ----------

function refresh() {
  if (!session || !scene) return;
  const g = session.game;
  const isReplay = session.kind === 'replay';
  scene.updateState(g.board, g.lastMovePoint());

  // 石数
  const s = g.score();
  $('count-black').textContent = String(s.black);
  $('count-white').textContent = String(s.white);
  $('komi-label').textContent = `（＋コミ ${g.komi}）`;

  // モードに応じたUIの出し分け
  $('replay-controls').classList.toggle('hidden', !isReplay);
  $('btn-pass').classList.toggle('hidden', isReplay);
  $('btn-undo').classList.toggle('hidden', isReplay);
  $('btn-resign').classList.toggle('hidden', isReplay);
  $('undo-line').classList.toggle('hidden', isReplay);

  // 待った回数
  if (!isReplay) {
    const undo = session.kind === 'online' ? session.undoCounts : g.undoCounts;
    $('undo-line').textContent = `待った：黒 ${undo[BLACK]}回 ／ 白 ${undo[WHITE]}回`;
  }

  // 状態表示
  const statusEl = $('status-line');
  if (session.kind === 'replay') {
    const n = session.moves.length;
    if (session.cursor === n) {
      if (g.over) {
        statusEl.textContent =
          s.byResign !== undefined
            ? `終局：${s.winner === 'black' ? '黒' : '白'}の中押し勝ち（${colorName(s.byResign)}の投了）`
            : s.winner === 'draw'
              ? '終局：持碁（引き分け）'
              : `終局：${s.winner === 'black' ? '黒' : '白'}の${Math.abs(s.margin)}目勝ち`;
      } else {
        statusEl.textContent = '棋譜の最後（未終局）';
      }
    } else {
      statusEl.textContent = `第${session.cursor}手まで再生（次は${colorName(g.turn)}）`;
    }
    $('rp-counter').textContent = `${session.cursor} / ${n} 手`;
    ($('btn-rp-first') as HTMLButtonElement).disabled = session.cursor === 0;
    ($('btn-rp-prev') as HTMLButtonElement).disabled = session.cursor === 0;
    ($('btn-rp-next') as HTMLButtonElement).disabled = session.cursor === n;
    ($('btn-rp-last') as HTMLButtonElement).disabled = session.cursor === n;
    return;
  }

  if (g.over) {
    statusEl.textContent = '終局';
  } else if (session.kind === 'online' && session.ended) {
    statusEl.textContent = '相手が退出しました';
  } else if (session.kind === 'npc' && session.thinking) {
    statusEl.textContent = `NPC（${colorName(g.turn)}）思考中…`;
  } else if (myTurn()) {
    statusEl.textContent = `あなたの番です（${colorName(session.myColor)}）`;
  } else {
    const opp = session.kind === 'npc' ? 'NPC' : '相手';
    statusEl.textContent = `${opp}の番です（${colorName(g.turn)}）`;
  }

  // ボタン
  const canAct =
    !g.over && !(session.kind === 'npc' && session.thinking) &&
    !(session.kind === 'online' && session.ended);
  ($('btn-pass') as HTMLButtonElement).disabled = !canAct || !myTurn();
  const hasMyMove = g.moveLog.some((m) => m.by === (session as NpcSession | OnlineSession).myColor);
  ($('btn-undo') as HTMLButtonElement).disabled = !canAct || !hasMyMove;
  // 投了は手番・NPC思考中に関係なく対局中ならいつでも可能
  ($('btn-resign') as HTMLButtonElement).disabled =
    g.over || (session.kind === 'online' && session.ended);

  if (g.over) showResult();
}

function showResult() {
  if (!session || session.kind === 'replay') return;
  const g = session.game;
  const s = g.score();
  const undo = session.kind === 'online' ? session.undoCounts : g.undoCounts;

  let winnerText: string;
  if (s.winner === 'draw') {
    winnerText = '引き分け（持碁）';
  } else {
    const wc: PlayerColor = s.winner === 'black' ? BLACK : WHITE;
    const youWin = wc === session.myColor;
    const how = s.byResign !== undefined ? '中押し勝ち' : '勝ち';
    winnerText = `${colorName(wc)}の${how} — あなたの${youWin ? '勝ちです！' : '負けです'}`;
  }
  $('result-winner').textContent = winnerText;

  const marginText =
    s.winner === 'draw' || s.byResign !== undefined
      ? s.byResign !== undefined
        ? `<div>（${colorName(s.byResign)}の投了による終局）</div>`
        : ''
      : `<div>（${Math.abs(s.margin)} 目差）</div>`;
  $('result-detail').innerHTML =
    `<div>黒：盤上 ${s.black} 子</div>` +
    `<div>白：盤上 ${s.white} 子 ＋ コミ ${s.komi} ＝ ${s.whiteTotal}</div>` +
    marginText;
  $('result-undo').textContent = `待った：黒 ${undo[BLACK]}回 ／ 白 ${undo[WHITE]}回`;

  $('btn-rematch').classList.toggle('hidden', session.kind !== 'npc');
  const overlay = $('overlay-result');
  const wasHidden = overlay.classList.contains('hidden');
  overlay.classList.remove('hidden');
  if (wasHidden) {
    // 試合終了の笛 → 少し置いて勝敗ジングル
    sound.finalWhistle();
    const myWin =
      s.winner !== 'draw' && (s.winner === 'black' ? BLACK : WHITE) === session.myColor;
    const kind = s.winner === 'draw' ? 'draw' : myWin ? 'win' : 'lose';
    window.setTimeout(() => sound.result(kind), 1500);
  }
}

// ---------- 着手処理 ----------

function handlePointClick(p: number) {
  if (!session) return;
  if (session.kind === 'replay') {
    toast('再生モードでは打てません');
    return;
  }
  const g = session.game;
  if (g.over) return;
  if (session.kind === 'online' && session.ended) return;
  if (session.kind === 'npc' && session.thinking) {
    toast('NPCが思考中です');
    return;
  }
  if (g.turn !== session.myColor) {
    toast('あなたの番ではありません');
    return;
  }
  const r = g.tryPlace(p);
  if (!r.ok) {
    sound.buzzer();
    toast(illegalText(r.reason));
    return;
  }
  if (session.kind === 'npc') {
    const res = g.play(p);
    if (res.ok) {
      sound.stone();
      if (res.captures.length > 0) sound.capture(res.captures.length);
    }
    refresh();
    afterNpcStateChange();
  } else {
    session.ws.send(JSON.stringify({ t: 'move', p }));
  }
}

function doPass() {
  if (!session || session.kind === 'replay' || !myTurn()) return;
  if (session.kind === 'npc') {
    if (session.thinking) return;
    session.game.pass();
    if (!session.game.over) sound.passWhistle();
    refresh();
    afterNpcStateChange();
  } else {
    if (session.ended) return;
    session.ws.send(JSON.stringify({ t: 'pass' }));
  }
}

function doUndo() {
  if (!session || session.kind === 'replay' || session.game.over) return;
  if (session.kind === 'npc') {
    if (session.thinking) {
      toast('NPCの思考中は待ったできません');
      return;
    }
    if (session.game.undoFor(session.myColor)) {
      sound.foul();
      toast('待ったしました');
      refresh();
      afterNpcStateChange(); // 戻した局面で再び先読み
    } else {
      toast('戻せる着手がありません');
    }
  } else {
    if (session.ended) return;
    session.ws.send(JSON.stringify({ t: 'undo' }));
  }
}

function doResign() {
  if (!session || session.kind === 'replay' || session.game.over) return;
  if (session.kind === 'online' && session.ended) return;
  if (!window.confirm('投了しますか？')) return;
  if (session.kind === 'npc') {
    session.game.resign(session.myColor);
    refresh();
    afterNpcStateChange(); // 終局 → ワーカー停止
  } else {
    session.ws.send(JSON.stringify({ t: 'resign' }));
  }
}

// ---------- NPC対戦 ----------

function maybeNpcTurn() {
  if (!session || session.kind !== 'npc') return;
  const g = session.game;
  if (g.over || g.turn === session.myColor) return;
  session.thinking = true;
  refresh();
  const moves = logToMoves(g.moveLog);
  session.pending = [];
  for (const w of session.workers) {
    w.postMessage({ t: 'genmove', komi: g.komi, moves, timeMs: session.timeMs });
  }
}

/** NPCの手番なら思考開始、人間の手番なら全ワーカーで先読み（ポンダリング） */
function afterNpcStateChange() {
  if (!session || session.kind !== 'npc') return;
  const g = session.game;
  if (!g.over && g.turn !== session.myColor) {
    maybeNpcTurn();
    return;
  }
  const msg = g.over
    ? { t: 'stop' }
    : { t: 'ponder', komi: g.komi, moves: logToMoves(g.moveLog) };
  for (const w of session.workers) w.postMessage(msg);
}

/** 全ワーカーの探索結果をマージして着手する（ルート並列） */
function applyMergedNpcMove(sess: NpcSession) {
  const agg = new Map<number, number>(); // move → 合計訪問数
  for (const r of sess.pending) {
    for (const c of r.children) {
      agg.set(c.move, (agg.get(c.move) ?? 0) + c.visits);
    }
  }
  sess.pending = [];
  sess.thinking = false;
  if (sess.game.over) return;
  let bestMove = -1;
  let bestVisits = -1;
  for (const [mv, v] of agg) {
    if (v > bestVisits) {
      bestVisits = v;
      bestMove = mv;
    }
  }
  const npcColor = sess.myColor === BLACK ? WHITE : BLACK;
  let played = false;
  if (bestMove >= 0) {
    const res = sess.game.play(bestMove);
    if (res.ok) {
      played = true;
      sound.stone();
      if (res.captures.length > 0) sound.capture(res.captures.length);
    }
  }
  if (!played) {
    sess.game.pass();
    toast(`NPC（${colorName(npcColor)}）がパスしました`);
    if (!sess.game.over) sound.passWhistle();
  }
  refresh();
  afterNpcStateChange(); // 人間の手番 → ポンダリング開始
}

function startNpcGame(komi: number, colorChoice: string, timeMs: number) {
  const myColor: PlayerColor =
    colorChoice === 'random'
      ? Math.random() < 0.5
        ? BLACK
        : WHITE
      : colorChoice === 'black'
        ? BLACK
        : WHITE;
  const workerCount = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
  const workers: Worker[] = [];
  const sess: NpcSession = {
    kind: 'npc',
    game: new Game(komi),
    myColor,
    workers,
    pending: [],
    thinking: false,
    timeMs,
  };
  for (let i = 0; i < workerCount; i++) {
    const w = new Worker(new URL('./npcWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent) => {
      if (session !== sess || !sess.thinking) return;
      const data = e.data as { t: string; sims: number; children: ChildStat[] };
      if (data.t !== 'move') return;
      sess.pending.push({ sims: data.sims, children: data.children });
      if (sess.pending.length >= sess.workers.length) applyMergedNpcMove(sess);
    };
    workers.push(w);
  }
  session = sess;
  enterGame();
  $('room-line').classList.add('hidden');
  toast(`あなたは${colorName(myColor)}番です`, 2500);
  sound.kickoff();
  afterNpcStateChange();
}

// ---------- オンライン対戦 ----------

let pendingWs: WebSocket | null = null;

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

function setOnlineStatus(html: string) {
  $('online-status').innerHTML = html;
}

function openOnline(initial: { t: string; [k: string]: unknown }) {
  if (pendingWs) {
    pendingWs.close();
    pendingWs = null;
  }
  setOnlineStatus('サーバーに接続中…');
  const ws = new WebSocket(wsUrl());
  pendingWs = ws;

  ws.onopen = () => ws.send(JSON.stringify(initial));

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data as string);
    switch (msg.t) {
      case 'created':
        setOnlineStatus(
          `部屋コード<span class="room-code">${msg.room}</span>このコードを相手に伝えてください。参加を待っています…`
        );
        break;
      case 'start': {
        pendingWs = null;
        const sess: OnlineSession = {
          kind: 'online',
          game: new Game(msg.komi),
          myColor: msg.color as PlayerColor,
          ws,
          komi: msg.komi,
          room: msg.room,
          undoCounts: { 1: 0, 2: 0 },
          prevLogLen: 0,
          ended: false,
          leaving: false,
        };
        session = sess;
        setOnlineStatus('');
        enterGame();
        const rl = $('room-line');
        rl.textContent = `部屋: ${msg.room}`;
        rl.classList.remove('hidden');
        toast(`対局開始！ あなたは${colorName(sess.myColor)}番です`, 3000);
        sound.kickoff();
        refresh();
        break;
      }
      case 'state':
        handleStateMsg(msg);
        break;
      case 'illegal':
        sound.buzzer();
        if (msg.reason === 'undo') toast('戻せる着手がありません');
        else if (msg.reason === 'notyourturn') toast('あなたの番ではありません');
        else toast(illegalText(msg.reason as IllegalReason));
        break;
      case 'undone':
        if (session?.kind === 'online' && msg.by !== session.myColor) {
          toast('相手が待ったをしました');
        } else {
          toast('待ったしました');
        }
        break;
      case 'opponentLeft':
        if (session?.kind === 'online' && session.ws === ws) {
          session.ended = true;
          toast('相手が退出しました');
          refresh();
        }
        break;
      case 'error':
        toast(String(msg.msg));
        setOnlineStatus(String(msg.msg));
        break;
    }
  };

  ws.onclose = () => {
    if (pendingWs === ws) {
      pendingWs = null;
      setOnlineStatus('サーバーとの接続が切れました');
    }
    if (session?.kind === 'online' && session.ws === ws && !session.leaving && !session.ended) {
      session.ended = true;
      toast('サーバーとの接続が切れました');
      refresh();
    }
  };

  ws.onerror = () => {
    setOnlineStatus('接続エラー：サーバーに接続できません');
  };
}

function handleStateMsg(msg: {
  log: MoveRecord[];
  undoCounts: Record<PlayerColor, number>;
}) {
  if (!session || session.kind !== 'online') return;
  // 棋譜を最初から再生して盤面を再構築（サーバーが正本）
  const g = new Game(session.komi);
  for (const m of msg.log) {
    if (m.type === 'pass') g.pass();
    else if (m.type === 'resign') g.resign(m.by);
    else g.play(m.point!);
  }
  // 着手・パス・待ったの効果音と通知
  if (msg.log.length > session.prevLogLen) {
    const last = msg.log[msg.log.length - 1];
    if (last.type === 'pass') {
      if (!g.over) {
        sound.passWhistle();
        toast(`${colorName(last.by)}がパスしました`);
      }
    } else if (last.type === 'move') {
      sound.stone();
      if (last.captures && last.captures.length > 0) sound.capture(last.captures.length);
    }
    // 投了は終局笛（showResult）に任せる
  } else if (msg.log.length < session.prevLogLen) {
    sound.foul(); // 待ったで巻き戻った
  }
  session.prevLogLen = msg.log.length;
  session.game = g;
  session.undoCounts = msg.undoCounts;
  refresh();
}

// ---------- 棋譜再生モード ----------

function buildReplayGame(komi: number, moves: number[], upTo: number): Game {
  const g = new Game(komi);
  for (let i = 0; i < upTo; i++) applyMoveCode(g, moves[i]);
  return g;
}

function startReplay(komi: number, moves: number[], cursor: number) {
  cleanupSession();
  session = {
    kind: 'replay',
    komi,
    moves,
    cursor,
    game: buildReplayGame(komi, moves, cursor),
  };
  $('overlay-result').classList.add('hidden');
  enterGame();
  $('room-line').classList.add('hidden');
}

function setReplayCursor(c: number) {
  if (!session || session.kind !== 'replay') return;
  const clamped = Math.max(0, Math.min(session.moves.length, c));
  if (clamped === session.cursor) return;
  const forward = clamped > session.cursor;
  session.cursor = clamped;
  session.game = buildReplayGame(session.komi, session.moves, clamped);
  if (forward && session.moves[clamped - 1] < PASS_CODE) sound.stone(true);
  else sound.tick();
  refresh();
}

function kifuUrlFor(komi: number, moves: number[]): string {
  return `${location.origin}${location.pathname}?kifu=${encodeKifu(komi, moves)}`;
}

// ---------- X（Twitter）共有 ----------

const NPC_LEVEL_NAMES: Record<number, string> = {
  600: '初級',
  1800: '中級',
  4000: '上級',
  8000: '最強',
};

/** 終局した対局の結果をX投稿用の一文にする（終局前は null） */
function buildShareText(): string | null {
  if (!session || session.kind === 'replay' || !session.game.over) return null;
  const g = session.game;
  const s = g.score();
  const opp =
    session.kind === 'npc'
      ? `NPC（${NPC_LEVEL_NAMES[session.timeMs] ?? '？'}）`
      : 'オンライン対戦';
  let result: string;
  if (s.winner === 'draw') {
    result = session.kind === 'npc' ? `${opp}と持碁（引き分け）` : `${opp}で持碁（引き分け）`;
  } else {
    const youWin = (s.winner === 'black' ? BLACK : WHITE) === session.myColor;
    const how = s.byResign !== undefined ? '中押し' : `${Math.abs(s.margin)}目`;
    const outcome = youWin ? `${how}勝ち！` : `${how}負け…`;
    result = session.kind === 'npc' ? `${opp}に${outcome}` : `${opp}で${outcome}`;
  }
  const detail =
    s.byResign !== undefined
      ? ''
      : `（黒${s.black}子・白${s.white}子${g.komi !== 0 ? `＋コミ${g.komi}` : ''}）`;
  return `球面で打つ囲碁「囲碁サッカー」⚽ ${result}${detail} #囲碁サッカー`;
}

function shareResultToX() {
  const text = buildShareText();
  if (!text || !session || session.kind === 'replay') return;
  const moves = logToMoves(session.game.moveLog);
  // 棋譜URLを添えて、見た人がそのまま対局を再生できるようにする
  const url =
    moves.length > 0
      ? kifuUrlFor(session.game.komi, moves)
      : `${location.origin}${location.pathname}`;
  const intent = `https://x.com/intent/post?text=${encodeURIComponent(`${text}\n`)}&url=${encodeURIComponent(url)}`;
  window.open(intent, '_blank', 'noopener,noreferrer');
}

async function copyKifuUrl(komi: number, moves: number[]) {
  if (moves.length === 0) {
    toast('まだ着手がありません');
    return;
  }
  const url = kifuUrlFor(komi, moves);
  try {
    await navigator.clipboard.writeText(url);
    toast('棋譜URLをコピーしました');
  } catch {
    window.prompt('コピーできませんでした。以下のURLを手動でコピーしてください:', url);
  }
}

// ---------- 画面遷移 ----------

function enterGame() {
  showScreen('game');
  ensureScene();
  scene!.resetView();
  sound.enterGame(); // BGM開始（設定がONの場合）
  refresh();
}

function cleanupSession() {
  if (!session) return;
  if (session.kind === 'npc') {
    for (const w of session.workers) w.terminate();
  } else if (session.kind === 'online') {
    session.leaving = true;
    session.ws.close();
  }
  session = null;
}

function leaveToTitle() {
  cleanupSession();
  sound.leaveGame();
  setOnlineStatus('');
  // 棋譜URLで開いていた場合はクエリを消す
  if (location.search) history.replaceState(null, '', location.pathname);
  showScreen('title');
}

// ---------- イベント結線 ----------

$('btn-npc-start').addEventListener('click', () => {
  const komi = parseKomi(($('npc-komi') as HTMLInputElement).value);
  const colorChoice = ($('npc-color') as HTMLSelectElement).value;
  const timeMs = Number(($('npc-level') as HTMLSelectElement).value);
  startNpcGame(komi, colorChoice, timeMs);
});

$('btn-create').addEventListener('click', () => {
  const komi = parseKomi(($('online-komi') as HTMLInputElement).value);
  const color = ($('online-color') as HTMLSelectElement).value;
  openOnline({ t: 'create', komi, color });
});

$('btn-join').addEventListener('click', () => {
  const code = ($('join-code') as HTMLInputElement).value.trim().toUpperCase();
  if (!code) {
    setOnlineStatus('部屋コードを入力してください');
    return;
  }
  openOnline({ t: 'join', room: code });
});

function parseKomi(v: string): number {
  const k = parseFloat(v);
  return Number.isFinite(k) ? k : 0;
}

$('btn-pass').addEventListener('click', doPass);
$('btn-undo').addEventListener('click', doUndo);
$('btn-resign').addEventListener('click', doResign);
$('btn-leave').addEventListener('click', () => {
  if (session && session.kind !== 'replay' && !session.game.over) {
    const ok = window.confirm('対局を中断してタイトルへ戻りますか？');
    if (!ok) return;
  }
  leaveToTitle();
});

$('btn-result-title').addEventListener('click', leaveToTitle);

$('btn-rematch').addEventListener('click', () => {
  if (!session || session.kind !== 'npc') return;
  $('overlay-result').classList.add('hidden');
  session.game = new Game(session.game.komi);
  session.thinking = false;
  session.pending = [];
  sound.kickoff();
  refresh();
  afterNpcStateChange();
});

for (const btn of document.querySelectorAll<HTMLButtonElement>('#view-buttons button[data-view]')) {
  btn.addEventListener('click', () => {
    scene?.viewPreset(btn.dataset.view as Parameters<BoardScene['viewPreset']>[0]);
  });
}

$('btn-view-reset').addEventListener('click', () => scene?.resetView());

// サウンド設定
function updateSoundButtons() {
  const bgm = $('btn-bgm');
  const se = $('btn-se');
  bgm.textContent = `♪ BGM: ${sound.bgmOn ? 'ON' : 'OFF'}`;
  se.textContent = `🔔 効果音: ${sound.seOn ? 'ON' : 'OFF'}`;
  bgm.classList.toggle('off', !sound.bgmOn);
  se.classList.toggle('off', !sound.seOn);
}

$('btn-bgm').addEventListener('click', () => {
  sound.setBgm(!sound.bgmOn);
  updateSoundButtons();
});

$('btn-se').addEventListener('click', () => {
  sound.setSe(!sound.seOn);
  updateSoundButtons();
  if (sound.seOn) sound.stone(true); // 確認音
});

updateSoundButtons();

// 振り返り・棋譜URL
$('btn-review').addEventListener('click', () => {
  if (!session || session.kind === 'replay') return;
  const komi = session.game.komi;
  const moves = logToMoves(session.game.moveLog);
  startReplay(komi, moves, moves.length);
});

$('btn-share-x').addEventListener('click', shareResultToX);

$('btn-kifu-copy').addEventListener('click', () => {
  if (!session) return;
  if (session.kind === 'replay') copyKifuUrl(session.komi, session.moves);
  else copyKifuUrl(session.game.komi, logToMoves(session.game.moveLog));
});

$('btn-rp-copy').addEventListener('click', () => {
  if (session?.kind === 'replay') copyKifuUrl(session.komi, session.moves);
});

$('btn-rp-first').addEventListener('click', () => setReplayCursor(0));
$('btn-rp-prev').addEventListener('click', () => {
  if (session?.kind === 'replay') setReplayCursor(session.cursor - 1);
});
$('btn-rp-next').addEventListener('click', () => {
  if (session?.kind === 'replay') setReplayCursor(session.cursor + 1);
});
$('btn-rp-last').addEventListener('click', () => {
  if (session?.kind === 'replay') setReplayCursor(session.moves.length);
});

document.addEventListener('keydown', (e) => {
  if (session?.kind !== 'replay') return;
  switch (e.key) {
    case 'ArrowLeft':
      setReplayCursor(session.cursor - 1);
      e.preventDefault();
      break;
    case 'ArrowRight':
      setReplayCursor(session.cursor + 1);
      e.preventDefault();
      break;
    case 'Home':
      setReplayCursor(0);
      e.preventDefault();
      break;
    case 'End':
      setReplayCursor(session.moves.length);
      e.preventDefault();
      break;
  }
});

// URLの ?kifu= から棋譜再生モードを開く
function tryOpenKifuFromUrl(): boolean {
  const param = new URLSearchParams(location.search).get('kifu');
  if (!param) return false;
  const d = decodeKifu(param);
  if (d && replayKifu(d) !== null) {
    startReplay(d.komi, d.moves, 0);
    return true;
  }
  setOnlineStatus('棋譜URLの読み込みに失敗しました（URLが不正です）');
  history.replaceState(null, '', location.pathname);
  return false;
}

const openedKifu = tryOpenKifuFromUrl();
if (!openedKifu) showScreen('title');
// 初めての訪問なら、かんたんルール説明を見るかどうかを聞く（棋譜URLで開いた場合は出さない）
initTutorial({ firstVisitPrompt: !openedKifu });
