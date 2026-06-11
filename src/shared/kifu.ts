// 棋譜のURL用エンコード/デコード
// 形式: [バージョン(1), コミ×2(符号付き8bit)] + 各手1バイトを Base64URL 化
// 手のコード: 0-59=着点, 60=パス, 61=手番側の投了, 62=非手番側の投了

import { BLACK, Game, MoveRecord, opponentOf, PlayerColor } from './rules';

export const PASS_CODE = 60;
export const RESIGN_TURN_CODE = 61; // 手番側が投了
export const RESIGN_OPP_CODE = 62; // 手番でない側が投了

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export interface DecodedKifu {
  komi: number;
  moves: number[]; // 0-59=着点, 60=パス, 61/62=投了
}

/** 棋譜ログを手のコード列に変換 */
export function logToMoves(log: readonly MoveRecord[]): number[] {
  const out: number[] = [];
  let turn: PlayerColor = BLACK;
  for (const m of log) {
    if (m.type === 'resign') {
      out.push(m.by === turn ? RESIGN_TURN_CODE : RESIGN_OPP_CODE);
    } else {
      out.push(m.type === 'pass' ? PASS_CODE : m.point!);
      turn = opponentOf(turn);
    }
  }
  return out;
}

/** 手のコードをGameに適用する。失敗時 false */
export function applyMoveCode(g: Game, code: number): boolean {
  if (code === PASS_CODE) return g.pass().ok;
  if (code === RESIGN_TURN_CODE) return g.resign(g.turn);
  if (code === RESIGN_OPP_CODE) return g.resign(opponentOf(g.turn));
  return g.play(code).ok;
}

export function encodeKifu(komi: number, moves: readonly number[]): string {
  const k = Math.round(Math.max(-63.5, Math.min(63.5, komi)) * 2);
  const bytes = new Uint8Array(2 + moves.length);
  bytes[0] = 1; // バージョン
  bytes[1] = k & 0xff;
  for (let i = 0; i < moves.length; i++) bytes[2 + i] = moves[i];
  return toBase64Url(bytes);
}

export function decodeKifu(s: string): DecodedKifu | null {
  const bytes = fromBase64Url(s);
  if (!bytes || bytes.length < 2 || bytes[0] !== 1) return null;
  const komiRaw = bytes[1] > 127 ? bytes[1] - 256 : bytes[1];
  const moves: number[] = [];
  for (let i = 2; i < bytes.length; i++) {
    if (bytes[i] > RESIGN_OPP_CODE) return null;
    moves.push(bytes[i]);
  }
  return { komi: komiRaw / 2, moves };
}

/** 棋譜を最後まで再生して検証。違法手を含む場合は null */
export function replayKifu(k: DecodedKifu): Game | null {
  const g = new Game(k.komi);
  for (const v of k.moves) {
    if (g.over) return null;
    if (!applyMoveCode(g, v)) return null;
  }
  return g;
}

function toBase64Url(data: Uint8Array): string {
  let out = '';
  for (let i = 0; i < data.length; i += 3) {
    const b0 = data[i];
    const b1 = i + 1 < data.length ? data[i + 1] : 0;
    const b2 = i + 2 < data.length ? data[i + 2] : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += B64[(n >> 18) & 63];
    out += B64[(n >> 12) & 63];
    if (i + 1 < data.length) out += B64[(n >> 6) & 63];
    if (i + 2 < data.length) out += B64[n & 63];
  }
  return out;
}

function fromBase64Url(s: string): Uint8Array | null {
  if (s.length % 4 === 1) return null;
  const vals: number[] = [];
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) return null;
    vals.push(v);
  }
  const out: number[] = [];
  for (let i = 0; i < vals.length; i += 4) {
    const n =
      (vals[i] << 18) |
      ((vals[i + 1] ?? 0) << 12) |
      ((vals[i + 2] ?? 0) << 6) |
      (vals[i + 3] ?? 0);
    out.push((n >> 16) & 0xff);
    if (i + 2 < vals.length) out.push((n >> 8) & 0xff);
    if (i + 3 < vals.length) out.push(n & 0xff);
  }
  return Uint8Array.from(out);
}
