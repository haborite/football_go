// NPC(MCTS)の動作・強さの検証: `npx tsx src/shared/npctest.ts`
// NPC（短時間思考）対ランダムプレイヤーで対局し、NPCが圧勝することを確認する

import { genmove } from './mcts';
import { BLACK, Game, WHITE } from './rules';

const GAMES = 6;
const NPC_MS = 300;

let npcWins = 0;
let totalSims = 0;
let totalThinks = 0;

for (let g = 0; g < GAMES; g++) {
  const npcColor = g % 2 === 0 ? BLACK : WHITE;
  const game = new Game(6.5);
  let guard = 0;
  while (!game.over && guard < 500) {
    guard++;
    if (game.turn === npcColor) {
      const r = genmove(game, NPC_MS);
      totalSims += r.sims;
      totalThinks++;
      if (r.point < 0) game.pass();
      else {
        const res = game.play(r.point);
        if (!res.ok) throw new Error(`NPCが非合法手を打った: ${r.point} (${res.reason})`);
      }
    } else {
      // ランダムプレイヤー: 合法手からランダム（手がなければパス）
      const legal = game.legalMoves();
      if (legal.length === 0 || Math.random() < 0.02) game.pass();
      else game.play(legal[Math.floor(Math.random() * legal.length)]);
    }
  }
  if (!game.over) throw new Error('対局が終わらない');
  const s = game.score();
  const winner = s.winner === 'black' ? BLACK : s.winner === 'white' ? WHITE : 0;
  const npcWon = winner === npcColor;
  if (npcWon) npcWins++;
  console.log(
    `対局${g + 1}: NPC=${npcColor === BLACK ? '黒' : '白'} → ` +
      `黒${s.black} 白${s.white}+${s.komi} → ${s.winner} ${npcWon ? '(NPC勝ち)' : '(NPC負け)'} ` +
      `[${game.moveLog.length}手]`
  );
}

console.log(`\nNPC勝率: ${npcWins}/${GAMES}`);
console.log(`平均シミュレーション回数/手: ${Math.round(totalSims / totalThinks)} (${NPC_MS}ms思考)`);

if (npcWins < GAMES - 1) {
  console.error('NPCが弱すぎます');
  process.exit(1);
}

// NPC自己対局: 終局時に空点（=埋め残し）が眼の分程度しか残らないことを確認
console.log('\n[自己対局: 陣地の埋め確認]');
{
  const game = new Game(6.5);
  let guard = 0;
  while (!game.over && guard < 400) {
    guard++;
    const r = genmove(game, 250);
    if (r.point < 0) game.pass();
    else if (!game.play(r.point).ok) throw new Error('自己対局で非合法手');
  }
  if (!game.over) throw new Error('自己対局が終わらない');
  const s = game.score();
  let empties = 0;
  for (let i = 0; i < 60; i++) if (game.board[i] === 0) empties++;
  console.log(
    `終局: 黒${s.black} 白${s.white}+${s.komi} (${game.moveLog.length}手) 空点=${empties}`
  );
  if (empties > 20) {
    console.error('NG: 空点が多すぎる — 陣地を埋め切っていない');
    process.exit(1);
  }
  console.log('OK: 二眼などを残して陣地を埋め切っている');
}

console.log('\nNPC検証 合格');
