// 囲碁サッカーのルールエンジン（純碁準拠）
// - 呼吸点がすべて塞がれた石は取られる
// - 自滅手（自殺手）の禁止
// - 同形反復の禁止（positional superko: 過去に現れた盤面の再現禁止）
// - 両者連続パスで終局、盤上の石数 + コミで勝敗判定

import { ADJ, N } from './geometry';

export type PlayerColor = 1 | 2; // 1=黒(先攻), 2=白(後攻)
export const BLACK: PlayerColor = 1;
export const WHITE: PlayerColor = 2;

export function opponentOf(c: PlayerColor): PlayerColor {
  return c === BLACK ? WHITE : BLACK;
}

export type IllegalReason = 'gameover' | 'occupied' | 'suicide' | 'superko';

export interface MoveRecord {
  by: PlayerColor;
  type: 'move' | 'pass' | 'resign';
  point?: number;
  captures?: number[];
}

export interface Score {
  black: number;
  white: number;
  komi: number;
  whiteTotal: number;
  winner: 'black' | 'white' | 'draw';
  margin: number; // 黒から見た差（黒石数 − (白石数+コミ)）
  /** 投了による終局の場合、投了した側 */
  byResign?: PlayerColor;
}

export type PlaceResult =
  | { ok: true; board: Uint8Array; captures: number[] }
  | { ok: false; reason: IllegalReason };

interface Snapshot {
  board: Uint8Array;
  turn: PlayerColor;
  passCount: number;
  over: boolean;
}

/** 盤面上の color の石が属する連と、その呼吸点の数を返す */
export function groupOf(
  board: Uint8Array,
  p: number
): { stones: number[]; liberties: number } {
  const color = board[p];
  const stones: number[] = [];
  const seen = new Set<number>([p]);
  const libSet = new Set<number>();
  const stack = [p];
  while (stack.length > 0) {
    const x = stack.pop()!;
    stones.push(x);
    for (const q of ADJ[x]) {
      const v = board[q];
      if (v === 0) libSet.add(q);
      else if (v === color && !seen.has(q)) {
        seen.add(q);
        stack.push(q);
      }
    }
  }
  return { stones, liberties: libSet.size };
}

export class Game {
  readonly komi: number;
  board: Uint8Array = new Uint8Array(N);
  turn: PlayerColor = BLACK;
  passCount = 0;
  over = false;
  resigned: PlayerColor | null = null;
  moveLog: MoveRecord[] = [];
  undoCounts: Record<PlayerColor, number> = { 1: 0, 2: 0 };

  // snapshots[k] = moveLog[k] を打つ「前」の状態。snapshots.length = moveLog.length + 1
  private snapshots: Snapshot[] = [];
  // positionKeys[k] = snapshots[k] の盤面キー（同形反復チェック用）
  private positionKeys: string[] = [];

  constructor(komi = 0) {
    this.komi = komi;
    this.snapshots.push(this.takeSnapshot());
    this.positionKeys.push(this.boardKey(this.board));
  }

  private boardKey(b: Uint8Array): string {
    return String.fromCharCode(...b);
  }

  private takeSnapshot(): Snapshot {
    return {
      board: this.board.slice(),
      turn: this.turn,
      passCount: this.passCount,
      over: this.over,
    };
  }

  /** 着手の合法性を判定し、合法なら結果盤面を返す（状態は変更しない） */
  tryPlace(p: number): PlaceResult {
    if (this.over) return { ok: false, reason: 'gameover' };
    if (this.board[p] !== 0) return { ok: false, reason: 'occupied' };

    const me = this.turn;
    const enemy = opponentOf(me);
    const b = this.board.slice();
    b[p] = me;

    // 相手の連で呼吸点ゼロになったものを取り除く
    const captures: number[] = [];
    for (const q of ADJ[p]) {
      if (b[q] === enemy) {
        const g = groupOf(b, q);
        if (g.liberties === 0) {
          for (const s of g.stones) {
            if (b[s] === enemy) {
              b[s] = 0;
              captures.push(s);
            }
          }
        }
      }
    }

    // 取れる石がなく、自分の連の呼吸点がゼロ → 自滅禁止
    if (captures.length === 0) {
      const g = groupOf(b, p);
      if (g.liberties === 0) return { ok: false, reason: 'suicide' };
    }

    // 同形反復の禁止（過去すべての盤面と比較）
    const key = this.boardKey(b);
    if (this.positionKeys.includes(key)) return { ok: false, reason: 'superko' };

    return { ok: true, board: b, captures };
  }

  /** 着手する。失敗時は理由を返す */
  play(p: number): { ok: true; captures: number[] } | { ok: false; reason: IllegalReason } {
    const r = this.tryPlace(p);
    if (!r.ok) return r;
    this.moveLog.push({ by: this.turn, type: 'move', point: p, captures: r.captures });
    this.board = r.board;
    this.turn = opponentOf(this.turn);
    this.passCount = 0;
    this.snapshots.push(this.takeSnapshot());
    this.positionKeys.push(this.boardKey(this.board));
    return { ok: true, captures: r.captures };
  }

  /** パスする。両者連続パスで終局 */
  pass(): { ok: boolean } {
    if (this.over) return { ok: false };
    this.moveLog.push({ by: this.turn, type: 'pass' });
    this.turn = opponentOf(this.turn);
    this.passCount += 1;
    if (this.passCount >= 2) this.over = true;
    this.snapshots.push(this.takeSnapshot());
    this.positionKeys.push(this.boardKey(this.board));
    return { ok: true };
  }

  /** 投了する。手番に関係なくいつでも可能（対局中のみ） */
  resign(color: PlayerColor): boolean {
    if (this.over) return false;
    this.moveLog.push({ by: color, type: 'resign' });
    this.over = true;
    this.resigned = color;
    this.snapshots.push(this.takeSnapshot());
    this.positionKeys.push(this.boardKey(this.board));
    return true;
  }

  /** 待った: color の最後の着手（とそれ以降）を取り消す */
  undoFor(color: PlayerColor): boolean {
    if (this.over) return false;
    let idx = -1;
    for (let k = this.moveLog.length - 1; k >= 0; k--) {
      if (this.moveLog[k].by === color) {
        idx = k;
        break;
      }
    }
    if (idx < 0) return false;
    this.moveLog.length = idx;
    this.snapshots.length = idx + 1;
    this.positionKeys.length = idx + 1;
    const s = this.snapshots[idx];
    this.board = s.board.slice();
    this.turn = s.turn;
    this.passCount = s.passCount;
    this.over = s.over;
    this.undoCounts[color] += 1;
    return true;
  }

  /** 最後に石を置いた点（パスは除く）。なければ -1 */
  lastMovePoint(): number {
    for (let k = this.moveLog.length - 1; k >= 0; k--) {
      const m = this.moveLog[k];
      if (m.type === 'move') return m.point!;
      // 最後の行動がパスならマーカーは直前の着手に付ける
    }
    return -1;
  }

  /** 純碁の採点: 盤上の石数 + 白へのコミ */
  score(): Score {
    let black = 0;
    let white = 0;
    for (let i = 0; i < N; i++) {
      if (this.board[i] === BLACK) black++;
      else if (this.board[i] === WHITE) white++;
    }
    const whiteTotal = white + this.komi;
    const margin = black - whiteTotal;
    if (this.resigned !== null) {
      return {
        black,
        white,
        komi: this.komi,
        whiteTotal,
        winner: this.resigned === BLACK ? 'white' : 'black',
        margin,
        byResign: this.resigned,
      };
    }
    const winner = margin > 0 ? 'black' : margin < 0 ? 'white' : 'draw';
    return { black, white, komi: this.komi, whiteTotal, winner, margin };
  }

  /** 現在の手番から見た合法手の一覧 */
  legalMoves(): number[] {
    const out: number[] = [];
    if (this.over) return out;
    for (let p = 0; p < N; p++) {
      if (this.board[p] !== 0) continue;
      if (this.tryPlace(p).ok) out.push(p);
    }
    return out;
  }

  /** 過去の盤面キー一覧（NPC探索用） */
  positionKeyList(): readonly string[] {
    return this.positionKeys;
  }
}
