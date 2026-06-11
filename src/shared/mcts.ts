// NPC思考エンジン: モンテカルロ木探索（UCT + RAVE）
// - 木のノードでは完全な同形反復（superko）チェック
// - プレイアウトは軽量ヒューリスティクス付き:
//     アタリの相手連を取る / アタリにされた自分の連を逃がす・反撃で取る /
//     自己アタリ回避 / 真の眼は埋めない / 簡易コウ（直前盤面の再現禁止）
// - RAVE(AMAF): 「この手は後でどの順で打たれても良かった」統計で少訪問ノードを補強
// - 純碁の採点（盤上の石数 + コミ）。評価値 = 勝敗(0/0.5/1) + 点差の小さなボーナス。
//   これにより勝ち確定後も二眼を残して陣地を埋め切り、石数を最大化する
// - MctsEngineは局面を同期(syncTo)しながら探索木を再利用でき、
//   小刻み実行(runSims)で相手の思考中の先読み（ポンダリング）にも使える

import { ADJ, N } from './geometry';
import { applyMoveCode, logToMoves, PASS_CODE } from './kifu';
import { Game } from './rules';

export interface MctsOptions {
  /** プレイアウトにアタリ応答・トリ・自己アタリ回避を入れる */
  playoutHeuristics: boolean;
  /** RAVE(AMAF)を使う */
  rave: boolean;
}

export const DEFAULT_MCTS_OPTIONS: MctsOptions = {
  playoutHeuristics: true,
  rave: true,
};

export interface ChildStat {
  move: number; // -1 = パス
  visits: number;
  wins: number;
}

export interface GenmoveResult {
  /** 選んだ手（-1 はパス） */
  point: number;
  visits: number;
  winrate: number;
  sims: number;
  /** ルート直下の統計（ルート並列のマージ用） */
  children: ChildStat[];
}

// ---- 高速盤面演算（型付き配列 + 使い回しバッファ、ワーカー内シングルスレッド前提） ----

const adjFlat = new Int32Array(N * 3);
for (let i = 0; i < N; i++) for (let k = 0; k < 3; k++) adjFlat[i * 3 + k] = ADJ[i][k];

// Zobristハッシュ（32bit）
const zob = new Int32Array(2 * N);
for (let i = 0; i < zob.length; i++) zob[i] = (Math.random() * 0x100000000) | 0;

function keyToHash(key: string): number {
  let h = 0;
  for (let i = 0; i < N; i++) {
    const c = key.charCodeAt(i);
    if (c !== 0) h = (h ^ zob[(c - 1) * N + i]) | 0;
  }
  return h;
}

const grpStack = new Int32Array(N);
const grpPts = new Int32Array(N);
const seen = new Int32Array(N);
const seenLib = new Int32Array(N);
let seenGen = 0;
let grpLen = 0;

/**
 * 世代カウンタを進める。Int32Arrayに格納できる範囲を超える前にリセットする
 * （超えると「未訪問」判定が常に真になりフラッドフィルが無限ループする）。
 */
function bumpGen() {
  if (seenGen >= 0x7ffffffe) {
    seen.fill(0);
    seenLib.fill(0);
    seenGen = 0;
  }
  seenGen++;
}

/** b[p]の連の呼吸点がゼロか。trueのとき grpPts[0..grpLen) に連の石が入る */
function groupNoLib(b: Uint8Array, p: number): boolean {
  const c = b[p];
  bumpGen();
  let sp = 0;
  grpStack[sp++] = p;
  seen[p] = seenGen;
  grpLen = 0;
  while (sp > 0) {
    const x = grpStack[--sp];
    grpPts[grpLen++] = x;
    for (let k = 0; k < 3; k++) {
      const q = adjFlat[x * 3 + k];
      const v = b[q];
      if (v === 0) return false; // 呼吸点あり
      if (v === c && seen[q] !== seenGen) {
        seen[q] = seenGen;
        grpStack[sp++] = q;
      }
    }
  }
  return true;
}

let libPoint = -1;

/**
 * b[p]の連の呼吸点を最大capまで数える（capで打ち切り）。
 * libPoint = 最初に見つけた呼吸点。打ち切らず完走した場合は
 * grpPts[0..grpLen) に連の石が入る。
 */
function countLibs(b: Uint8Array, p: number, cap: number): number {
  const c = b[p];
  bumpGen();
  let sp = 0;
  grpStack[sp++] = p;
  seen[p] = seenGen;
  grpLen = 0;
  let libs = 0;
  libPoint = -1;
  while (sp > 0) {
    const x = grpStack[--sp];
    grpPts[grpLen++] = x;
    for (let k = 0; k < 3; k++) {
      const q = adjFlat[x * 3 + k];
      const v = b[q];
      if (v === 0) {
        if (seenLib[q] !== seenGen) {
          seenLib[q] = seenGen;
          if (libPoint < 0) libPoint = q;
          libs++;
          if (libs >= cap) return libs;
        }
      } else if (v === c && seen[q] !== seenGen) {
        seen[q] = seenGen;
        grpStack[sp++] = q;
      }
    }
  }
  return libs;
}

const capBuf = new Int32Array(N);
let capLen = 0;

/**
 * pにcを置く。捕獲があれば実行し capBuf に記録。
 * 自滅手なら盤面を元に戻して false。
 */
function tryApply(b: Uint8Array, p: number, c: number): boolean {
  b[p] = c;
  capLen = 0;
  const o = 3 - c;
  let captured = false;
  for (let k = 0; k < 3; k++) {
    const q = adjFlat[p * 3 + k];
    if (b[q] === o && groupNoLib(b, q)) {
      for (let i = 0; i < grpLen; i++) {
        const s = grpPts[i];
        b[s] = 0;
        capBuf[capLen++] = s;
      }
      captured = true;
    }
  }
  if (!captured && groupNoLib(b, p)) {
    b[p] = 0;
    return false;
  }
  return true;
}

/** tryApply成功直後に呼ぶ: 適用後のハッシュ */
function hashAfter(h: number, p: number, c: number): number {
  h = (h ^ zob[(c - 1) * N + p]) | 0;
  const o = 3 - c;
  for (let i = 0; i < capLen; i++) h = (h ^ zob[(o - 1) * N + capBuf[i]]) | 0;
  return h;
}

/** tryApply成功直後の取り消し */
function revertApply(b: Uint8Array, p: number, c: number) {
  b[p] = 0;
  const o = 3 - c;
  for (let i = 0; i < capLen; i++) b[capBuf[i]] = o;
}

/** pの3近傍がすべてcで、かつ同一の連に属する（=真の一眼）か */
function isTrueEye(b: Uint8Array, p: number, c: number): boolean {
  const n0 = adjFlat[p * 3];
  const n1 = adjFlat[p * 3 + 1];
  const n2 = adjFlat[p * 3 + 2];
  bumpGen();
  let sp = 0;
  grpStack[sp++] = n0;
  seen[n0] = seenGen;
  let f1 = false;
  let f2 = false;
  while (sp > 0) {
    const x = grpStack[--sp];
    if (x === n1) f1 = true;
    if (x === n2) f2 = true;
    if (f1 && f2) return true;
    for (let k = 0; k < 3; k++) {
      const q = adjFlat[x * 3 + k];
      if (b[q] === c && seen[q] !== seenGen) {
        seen[q] = seenGen;
        grpStack[sp++] = q;
      }
    }
  }
  return f1 && f2;
}

let komiG = 6.5;

/** 純碁採点: 黒から見た点差（黒石数 − 白石数 − コミ） */
function scoreMargin(b: Uint8Array): number {
  let nb = 0;
  let nw = 0;
  for (let i = 0; i < N; i++) {
    if (b[i] === 1) nb++;
    else if (b[i] === 2) nw++;
  }
  return nb - nw - komiG;
}

// 点差ボーナス: 1目あたりの加点と上限（勝敗判定を覆さない小ささに保つ）
const MARGIN_BONUS = 0.005;
const MARGIN_BONUS_CAP = 0.08;

/** mover視点の評価値: 勝敗 + 点差ボーナス */
function valueFor(mover: number, blackMargin: number): number {
  const m = mover === 1 ? blackMargin : -blackMargin;
  const win = m > 0 ? 1 : m < 0 ? 0 : 0.5;
  return win + Math.max(-MARGIN_BONUS_CAP, Math.min(MARGIN_BONUS_CAP, m * MARGIN_BONUS));
}

// 60と互いに素なステップ（疑似ランダム巡回用）
const STEPS = [7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 49, 53, 59];

const PLAYOUT_CAP = 170;

// RAVE用: プレイアウト・木パスで打たれた手のマスク（[色-1]*N + 点）
const raveMask = new Uint8Array(2 * N);
// 純碁のプレイアウトは盤を埋め尽くすため、終盤まで記録すると全点が
// マスクに入りAMAF統計が飽和して識別力を失う。序盤の手だけを記録する。
const RAVE_PLAYOUT_CUTOFF = 12;

// プレイアウトヒューリスティクスの作業バッファ
const heurBuf = new Int32Array(64);
let heurLen = 0;
const allyBuf = new Int32Array(N);

function pushHeur(p: number) {
  if (heurLen < heurBuf.length) heurBuf[heurLen++] = p;
}

/**
 * 直前の手(lastMove)に反応する候補手を heurBuf に集める。
 * - 直前に打たれた相手連がアタリ → その呼吸点（=トリ）
 * - 直前の手に隣接する自分の連がアタリ → 逃げる呼吸点、または隣接する
 *   相手のアタリ連を取って呼吸点を増やす（反撃）
 */
function collectHeuristics(b: Uint8Array, turn: number, lastMove: number) {
  heurLen = 0;
  const opp = 3 - turn;
  if (b[lastMove] === opp && countLibs(b, lastMove, 2) === 1) {
    pushHeur(libPoint);
  }
  for (let k = 0; k < 3; k++) {
    const q = adjFlat[lastMove * 3 + k];
    if (b[q] !== turn) continue;
    if (countLibs(b, q, 2) !== 1) continue;
    const escape = libPoint;
    // 反撃: アタリにされた自分の連に隣接する相手連でアタリのものを取る
    const allyLen = grpLen;
    for (let i = 0; i < allyLen; i++) allyBuf[i] = grpPts[i];
    for (let i = 0; i < allyLen; i++) {
      const s = allyBuf[i];
      for (let j = 0; j < 3; j++) {
        const e = adjFlat[s * 3 + j];
        if (b[e] === opp && countLibs(b, e, 2) === 1) pushHeur(libPoint);
      }
    }
    pushHeur(escape);
  }
}

/**
 * プレイアウト。bは破壊される。黒から見た点差を返す。
 * raveOnのとき序盤に打たれた手を raveMask に記録する。
 */
function playout(
  b: Uint8Array,
  turn: number,
  hash: number,
  prevHash: number,
  passes: number,
  lastMove: number,
  heuristics: boolean,
  raveOn: boolean
): number {
  let steps = 0;
  while (passes < 2 && steps < PLAYOUT_CAP) {
    let played = -1;

    // 1) 直前の手への応手（アタリ関連）を高確率で優先
    if (heuristics && lastMove >= 0 && Math.random() < 0.9) {
      collectHeuristics(b, turn, lastMove);
      while (heurLen > 0) {
        const i = (Math.random() * heurLen) | 0;
        const p = heurBuf[i];
        heurBuf[i] = heurBuf[--heurLen];
        if (b[p] !== 0) continue;
        if (!tryApply(b, p, turn)) continue;
        const h2 = hashAfter(hash, p, turn);
        if (h2 === prevHash) {
          revertApply(b, p, turn);
          continue;
        }
        // 取りのない自己アタリは不採用
        if (capLen === 0 && countLibs(b, p, 2) === 1) {
          revertApply(b, p, turn);
          continue;
        }
        prevHash = hash;
        hash = h2;
        played = p;
        break;
      }
    }

    // 2) ランダム着手（眼埋め・自己アタリ・簡易コウは回避）
    if (played < 0) {
      const start = (Math.random() * N) | 0;
      const step = STEPS[(Math.random() * STEPS.length) | 0];
      for (let i = 0; i < N; i++) {
        const p = (start + i * step) % N;
        if (b[p] !== 0) continue;
        const a0 = b[adjFlat[p * 3]];
        const a1 = b[adjFlat[p * 3 + 1]];
        const a2 = b[adjFlat[p * 3 + 2]];
        // 自分の真の一眼は埋めない（連の死活を壊さない）
        if (a0 === turn && a1 === turn && a2 === turn && isTrueEye(b, p, turn)) continue;
        if (!tryApply(b, p, turn)) continue;
        const h2 = hashAfter(hash, p, turn);
        if (h2 === prevHash) {
          revertApply(b, p, turn);
          continue;
        }
        if (heuristics && capLen === 0 && countLibs(b, p, 2) === 1) {
          revertApply(b, p, turn);
          continue;
        }
        prevHash = hash;
        hash = h2;
        played = p;
        break;
      }
    }

    if (played >= 0) {
      passes = 0;
      if (raveOn && steps < RAVE_PLAYOUT_CUTOFF) raveMask[(turn - 1) * N + played] = 1;
      lastMove = played;
    } else {
      passes++;
      lastMove = -1;
    }
    turn = 3 - turn;
    steps++;
  }
  return scoreMargin(b);
}

// ---- UCT木 ----

interface TNode {
  move: number; // -1 = パス, -2 = ルート
  parent: TNode | null;
  children: TNode[];
  untried: number[] | null;
  visits: number;
  wins: number; // moveを打った側から見た評価値合計
  raveVisits: number;
  raveWins: number;
}

function newNode(move: number, parent: TNode | null): TNode {
  return {
    move,
    parent,
    children: [],
    untried: null,
    visits: 0,
    wins: 0,
    raveVisits: 0,
    raveWins: 0,
  };
}

const UCT_C = 0.85;
const UCT_C_RAVE = 0.55;
const RAVE_EQUIV = 1200;

function selectChild(parent: TNode, raveOn: boolean): TNode {
  const logN = Math.log(parent.visits);
  const c = raveOn ? UCT_C_RAVE : UCT_C;
  let best: TNode = parent.children[0];
  let bestV = -Infinity;
  for (const ch of parent.children) {
    const q = ch.wins / ch.visits;
    let v: number;
    if (raveOn && ch.raveVisits > 0 && ch.move >= 0) {
      const qr = ch.raveWins / ch.raveVisits;
      const beta =
        ch.raveVisits /
        (ch.raveVisits + ch.visits + (ch.visits * ch.raveVisits) / RAVE_EQUIV);
      v = (1 - beta) * q + beta * qr;
    } else {
      v = q;
    }
    v += c * Math.sqrt(logN / ch.visits) + Math.random() * 1e-6;
    if (v > bestV) {
      bestV = v;
      best = ch;
    }
  }
  return best;
}

// ---- エンジン本体 ----

export class MctsEngine {
  readonly opts: MctsOptions;
  private game: Game | null = null;
  private syncedMoves: number[] = [];
  private komi = 6.5;
  private root: TNode = newNode(-2, null);
  private rootBoard = new Uint8Array(N);
  private lineBuf = new Int32Array(2048); // 過去盤面ハッシュ + 探索パス
  private histLen = 0;
  private bCur = new Uint8Array(N);

  constructor(opts?: Partial<MctsOptions>) {
    this.opts = { ...DEFAULT_MCTS_OPTIONS, ...opts };
  }

  /** 現在の木に注がれた総シミュレーション数 */
  treeSims(): number {
    return this.root.visits;
  }

  /**
   * 局面を同期する。前回同期した手順の延長なら探索木のサブツリーを再利用し、
   * そうでなければ（待った・新規対局など）木を作り直す。
   */
  syncTo(komi: number, moves: number[]) {
    const isExtension =
      this.game !== null &&
      komi === this.komi &&
      moves.length >= this.syncedMoves.length &&
      this.syncedMoves.every((m, i) => moves[i] === m);

    if (!isExtension) {
      this.komi = komi;
      this.game = new Game(komi);
      this.root = newNode(-2, null);
      for (const code of moves) this.applyCode(code, false);
    } else {
      for (let i = this.syncedMoves.length; i < moves.length; i++) {
        this.applyCode(moves[i], true);
      }
    }
    this.syncedMoves = moves.slice();

    // 過去盤面のハッシュ列（superko用）を再構築
    const keys = this.game!.positionKeyList();
    this.histLen = keys.length;
    if (this.lineBuf.length < this.histLen + 2048) {
      this.lineBuf = new Int32Array(this.histLen + 4096);
    }
    for (let k = 0; k < this.histLen; k++) this.lineBuf[k] = keyToHash(keys[k]);
    this.rootBoard.set(this.game!.board);
  }

  private applyCode(code: number, reuseTree: boolean) {
    const g = this.game!;
    applyMoveCode(g, code);
    if (reuseTree) {
      // 投了コードは木に対応ノードがないので作り直し（対局終了なので実害なし）
      const nodeMove = code === PASS_CODE ? -1 : code < PASS_CODE ? code : -3;
      const child = this.root.children.find((c) => c.move === nodeMove);
      if (child) {
        child.parent = null;
        this.root = child;
      } else {
        this.root = newNode(-2, null);
      }
    }
  }

  /** nシミュレーション実行（ポンダリング用の小刻み実行） */
  runSims(n: number) {
    if (!this.game || this.game.over) return;
    komiG = this.komi;
    for (let i = 0; i < n; i++) this.runIteration();
  }

  /** 時間いっぱい探索して最善手を返す */
  think(timeMs: number): GenmoveResult {
    if (!this.game || this.game.over) {
      return { point: -1, visits: 0, winrate: 0, sims: 0, children: [] };
    }
    komiG = this.komi;
    const deadline = Date.now() + timeMs;
    let sims = 0;
    while (true) {
      if ((sims & 31) === 0 && Date.now() >= deadline && sims >= 400) break;
      if (sims > 300000) break;
      this.runIteration();
      sims++;
    }
    return this.bestResult(sims);
  }

  private bestResult(sims: number): GenmoveResult {
    let best: TNode | null = null;
    for (const ch of this.root.children) {
      if (best === null || ch.visits > best.visits) best = ch;
    }
    const children: ChildStat[] = this.root.children.map((c) => ({
      move: c.move,
      visits: c.visits,
      wins: c.wins,
    }));
    if (best === null) return { point: -1, visits: 0, winrate: 0, sims, children };
    return {
      point: best.move,
      visits: best.visits,
      winrate: best.visits > 0 ? Math.min(1, Math.max(0, best.wins / best.visits)) : 0,
      sims,
      children,
    };
  }

  /** この局面の合法手（パス-1を含む、完全superkoチェック） */
  private legalMovesAt(b: Uint8Array, turn: number, hash: number, lineLen: number): number[] {
    const out: number[] = [-1];
    for (let p = 0; p < N; p++) {
      if (b[p] !== 0) continue;
      if (!tryApply(b, p, turn)) continue;
      const h2 = hashAfter(hash, p, turn);
      revertApply(b, p, turn);
      let dup = false;
      for (let i = 0; i < lineLen; i++) {
        if (this.lineBuf[i] === h2) {
          dup = true;
          break;
        }
      }
      if (!dup) out.push(p);
    }
    return out;
  }

  private runIteration() {
    const game = this.game!;
    const raveOn = this.opts.rave;
    const heur = this.opts.playoutHeuristics;
    const bCur = this.bCur;

    bCur.set(this.rootBoard);
    let hash = this.lineBuf[this.histLen - 1];
    let prevHash =
      this.histLen >= 2 ? this.lineBuf[this.histLen - 2] : (Math.random() * 0x100000000) | 0;
    let turn: number = game.turn;
    let passes = game.passCount;
    let lineLen = this.histLen;
    let node = this.root;

    if (raveOn) raveMask.fill(0);

    // 1. 選択
    while (
      passes < 2 &&
      node.untried !== null &&
      node.untried.length === 0 &&
      node.children.length > 0
    ) {
      node = selectChild(node, raveOn);
      if (node.move === -1) {
        passes++;
      } else {
        tryApply(bCur, node.move, turn);
        prevHash = hash;
        hash = hashAfter(hash, node.move, turn);
        this.lineBuf[lineLen++] = hash;
        passes = 0;
      }
      turn = 3 - turn;
    }

    let margin: number;
    if (passes >= 2) {
      margin = scoreMargin(bCur);
    } else {
      // 2. 展開
      if (node.untried === null) node.untried = this.legalMovesAt(bCur, turn, hash, lineLen);
      if (node.untried.length > 0) {
        const idx = (Math.random() * node.untried.length) | 0;
        const mv = node.untried[idx];
        node.untried[idx] = node.untried[node.untried.length - 1];
        node.untried.pop();
        const child = newNode(mv, node);
        node.children.push(child);
        let lastMove = -1;
        if (mv === -1) {
          passes++;
        } else {
          tryApply(bCur, mv, turn);
          prevHash = hash;
          hash = hashAfter(hash, mv, turn);
          this.lineBuf[lineLen++] = hash;
          passes = 0;
          lastMove = mv;
        }
        turn = 3 - turn;
        node = child;
        // 3. プレイアウト
        margin =
          passes >= 2
            ? scoreMargin(bCur)
            : playout(bCur, turn, hash, prevHash, passes, lastMove, heur, raveOn);
      } else {
        margin = scoreMargin(bCur);
      }
    }

    // 4. 逆伝播（各ノードの手を打った側の視点で 勝敗+点差ボーナス を加算）
    // RAVE: 「ノードの手番側がシミュレーション中（そのノード以降）に打った手」と
    // 一致する子の rave 統計を更新する。葉から根へ遡りつつマスクに手を足していく。
    let t = turn;
    let n: TNode | null = node;
    while (n !== null && n.parent !== null) {
      const mover = 3 - t;
      const val = valueFor(mover, margin);
      n.visits++;
      n.wins += val;
      if (raveOn) {
        if (n.move >= 0) raveMask[(mover - 1) * N + n.move] = 1;
        const par = n.parent;
        const base = (mover - 1) * N;
        for (const c of par.children) {
          if (c.move >= 0 && raveMask[base + c.move] !== 0) {
            c.raveVisits++;
            c.raveWins += val;
          }
        }
      }
      t = mover;
      n = n.parent;
    }
    this.root.visits++;
  }
}

/** 単発思考（木を使い捨て）。テスト・アリーナ用 */
export function genmove(game: Game, timeMs: number, opts?: Partial<MctsOptions>): GenmoveResult {
  const engine = new MctsEngine(opts);
  engine.syncTo(game.komi, logToMoves(game.moveLog));
  return engine.think(timeMs);
}
