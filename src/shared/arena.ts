// エンジン設定同士の対戦による強さ検証
// 使い方: npx tsx src/shared/arena.ts [対局数] [ms/手] [設定A] [設定B]
// 設定: "base"(素のUCT) / "heur"(プレイアウト改善) / "rave" / "heur+rave"
// 例: npx tsx src/shared/arena.ts 40 150 base heur

import { MctsEngine, MctsOptions } from './mcts';
import { PASS_CODE } from './kifu';
import { Game } from './rules';

function parseOpts(s: string): MctsOptions {
  return {
    playoutHeuristics: s.includes('heur'),
    rave: s.includes('rave'),
  };
}

const GAMES = Number(process.argv[2] || 40);
const MS = Number(process.argv[3] || 150);
const nameA = process.argv[4] || 'base';
const nameB = process.argv[5] || 'heur';
const optsA = parseOpts(nameA);
const optsB = parseOpts(nameB);

console.log(`アリーナ: A=${nameA} vs B=${nameB}, ${GAMES}局, ${MS}ms/手`);

let scoreB = 0; // Bの勝ち=1, 引き分け=0.5
let bWins = 0;
let aWins = 0;
let draws = 0;
const t0 = Date.now();

for (let g = 0; g < GAMES; g++) {
  // 色を交互に入れ替える（g偶数: Aが黒）
  const aIsBlack = g % 2 === 0;
  const engines = {
    1: new MctsEngine(aIsBlack ? optsA : optsB),
    2: new MctsEngine(aIsBlack ? optsB : optsA),
  } as const;
  const game = new Game(6.5);
  const moves: number[] = [];
  let guard = 0;
  while (!game.over && guard < 400) {
    guard++;
    const eng = engines[game.turn];
    eng.syncTo(6.5, moves);
    const r = eng.think(MS);
    if (r.point < 0) {
      game.pass();
      moves.push(PASS_CODE);
    } else {
      const res = game.play(r.point);
      if (!res.ok) throw new Error(`非合法手: ${r.point} (${res.reason})`);
      moves.push(r.point);
    }
  }
  if (!game.over) throw new Error('対局が終わらない');
  const s = game.score();
  const blackWon = s.winner === 'black';
  const whiteWon = s.winner === 'white';
  const bWon = (blackWon && !aIsBlack) || (whiteWon && aIsBlack);
  const aWon = (blackWon && aIsBlack) || (whiteWon && !aIsBlack);
  if (bWon) {
    bWins++;
    scoreB += 1;
  } else if (aWon) {
    aWins++;
  } else {
    draws++;
    scoreB += 0.5;
  }
  console.log(
    `${g + 1}/${GAMES}: ${aIsBlack ? 'A=黒' : 'B=黒'} 黒${s.black} 白${s.white}+${s.komi} → ` +
      `${bWon ? 'B勝ち' : aWon ? 'A勝ち' : '引き分け'} [${game.moveLog.length}手] ` +
      `(累計 B ${bWins}-${aWins} A)`
  );
}

const n = GAMES;
const p = scoreB / n;
const se = Math.sqrt((p * (1 - p)) / n);
const elo =
  p <= 0 ? -Infinity : p >= 1 ? Infinity : Math.round(400 * Math.log10(p / (1 - p)));
console.log(`\n結果: B(${nameB}) ${bWins}勝 ${aWins}敗 ${draws}分 vs A(${nameA})`);
console.log(
  `Bの勝率: ${(p * 100).toFixed(1)}% ± ${(se * 196).toFixed(1)}% (95%CI) ≈ ${elo > 0 ? '+' : ''}${elo} Elo`
);
console.log(`所要時間: ${((Date.now() - t0) / 1000 / 60).toFixed(1)}分`);
