// NPC思考用 Web Worker
// - MctsEngineを保持し、局面同期で探索木を再利用
// - 'ponder' メッセージで相手（人間）の思考中も裏で探索を続ける
// - 'genmove' で時間いっぱい探索して着手を返す（ルート並列マージ用に子統計も返す）

import { MctsEngine } from '../shared/mcts';

interface GenmoveMsg {
  t: 'genmove';
  komi: number;
  moves: number[]; // 0-59=着点, 60=パス
  timeMs: number;
}

interface PonderMsg {
  t: 'ponder';
  komi: number;
  moves: number[];
}

interface StopMsg {
  t: 'stop';
}

type Req = GenmoveMsg | PonderMsg | StopMsg;

const post = (m: unknown) => (self as unknown as { postMessage(x: unknown): void }).postMessage(m);

const engine = new MctsEngine();

// ポンダリング: メッセージの合間に小刻みにシミュレーションを回す
const PONDER_CHUNK = 256;
const PONDER_TREE_CAP = 400000; // 木が肥大しすぎないよう上限
let pondering = false;
let ponderTimer: ReturnType<typeof setTimeout> | null = null;

function stopPonder() {
  pondering = false;
  if (ponderTimer !== null) {
    clearTimeout(ponderTimer);
    ponderTimer = null;
  }
}

function ponderLoop() {
  if (!pondering) return;
  if (engine.treeSims() < PONDER_TREE_CAP) {
    engine.runSims(PONDER_CHUNK);
  }
  ponderTimer = setTimeout(ponderLoop, 0);
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as Req;
  stopPonder();
  switch (msg.t) {
    case 'genmove': {
      engine.syncTo(msg.komi, msg.moves);
      const r = engine.think(msg.timeMs);
      post({ t: 'move', ...r });
      break;
    }
    case 'ponder':
      engine.syncTo(msg.komi, msg.moves);
      pondering = true;
      ponderLoop();
      break;
    case 'stop':
      break;
  }
};
