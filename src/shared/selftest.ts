// ルールエンジンと幾何の自己テスト: `npm test` で実行
import { ADJ, EDGES, N, VERTS } from './geometry';
import { decodeKifu, encodeKifu, logToMoves, replayKifu } from './kifu';
import { BLACK, Game, WHITE } from './rules';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    failures++;
    console.error(`  NG: ${msg}`);
  } else {
    console.log(`  OK: ${msg}`);
  }
}

console.log('[幾何]');
assert(VERTS.length === N, `頂点数 = ${N}`);
assert(EDGES.length === 90, '辺数 = 90');
assert(
  ADJ.every((a) => a.length === 3),
  '全頂点の次数 = 3'
);
assert(
  VERTS.every((v) => Math.abs(Math.hypot(v[0], v[1], v[2]) - 1) < 1e-9),
  '全頂点が単位球上'
);

// 0 とその近傍から十分離れた点を探す（テスト用の「遠い」点）
function farPoints(avoid: Set<number>, count: number): number[] {
  const out: number[] = [];
  for (let v = 0; v < N && out.length < count; v++) {
    if (avoid.has(v)) continue;
    if (ADJ[v].some((q) => avoid.has(q))) continue;
    out.push(v);
    avoid.add(v);
    for (const q of ADJ[v]) avoid.add(q);
  }
  return out;
}

console.log('[捕獲]');
{
  const g = new Game(6.5);
  const [a, b, c] = ADJ[0];
  const avoid = new Set<number>([0, a, b, c, ...ADJ[a], ...ADJ[b], ...ADJ[c]]);
  const far = farPoints(avoid, 2);
  assert(g.play(a).ok, '黒: 0の隣1');
  assert(g.play(0).ok, '白: 点0に着手');
  assert(g.play(b).ok, '黒: 0の隣2');
  assert(g.play(far[0]).ok, '白: 遠方');
  const r = g.play(c);
  assert(r.ok, '黒: 0の隣3（白を取る）');
  assert(r.ok && r.captures.length === 1 && r.captures[0] === 0, '白1子が取られた');
  assert(g.board[0] === 0, '点0が空になった');
}

console.log('[自滅禁止]');
{
  const g = new Game(6.5);
  const [a, b, c] = ADJ[0];
  const avoid = new Set<number>([0, a, b, c, ...ADJ[a], ...ADJ[b], ...ADJ[c]]);
  const far = farPoints(avoid, 3);
  assert(g.play(far[0]).ok, '黒: 遠方1');
  assert(g.play(a).ok, '白: 0の隣1');
  assert(g.play(far[1]).ok, '黒: 遠方2');
  assert(g.play(b).ok, '白: 0の隣2');
  assert(g.play(far[2]).ok, '黒: 遠方3');
  assert(g.play(c).ok, '白: 0の隣3');
  const r = g.play(0);
  assert(!r.ok && r.reason === 'suicide', '黒が点0に打つのは自滅禁止');
}

console.log('[終局と採点]');
{
  const g = new Game(6.5);
  assert(g.play(0).ok, '黒: 1手');
  g.pass();
  g.pass();
  assert(g.over, '連続パスで終局');
  const s = g.score();
  assert(s.black === 1 && s.white === 0, '石数: 黒1 白0');
  assert(s.winner === 'white' && Math.abs(s.margin - -5.5) < 1e-9, 'コミ6.5で白勝ち');
}

console.log('[待った]');
{
  const g = new Game(6.5);
  g.play(0); // 黒
  g.play(10); // 白
  const afterWhite = g.board.slice();
  g.play(20); // 黒
  // 黒の待った: 黒の最後の着手(20)だけが戻る（白の応手はまだ無い）
  assert(g.undoFor(BLACK), '黒の待ったが成功');
  assert(g.board.join() === afterWhite.join(), '黒の最後の着手前に戻った');
  assert(g.turn === BLACK, '手番は黒');
  assert(g.undoCounts[BLACK] === 1, '待った回数がカウントされた');
  assert(g.moveLog.length === 2, '棋譜が正しく巻き戻った');
  // さらに黒が打ち白が応手した後の黒の待った: 白の応手ごと戻る
  g.play(20); // 黒
  g.play(30); // 白
  assert(g.undoFor(BLACK), '黒の2度目の待ったが成功');
  assert(g.board.join() === afterWhite.join(), '白の応手ごと巻き戻った');
  assert(g.undoCounts[BLACK] === 2, '待った回数 = 2');
}

console.log('[性質テスト: ランダム対局]');
{
  let rngState = 12345;
  const rng = () => {
    rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
    return rngState / 0x80000000;
  };
  for (let trial = 0; trial < 100; trial++) {
    const g = new Game(6.5);
    let moves = 0;
    while (!g.over && moves < 500) {
      const legal = g.legalMoves();
      // 300手を超えたら強制的にパスして終局させる（終局性そのものは超劫により保証されるが時間がかかる）
      if (moves > 300 || legal.length === 0 || rng() < 0.03) {
        g.pass();
      } else {
        const p = legal[Math.floor(rng() * legal.length)];
        const r = g.play(p);
        if (!r.ok) throw new Error('legalMoves の手が拒否された');
      }
      moves++;
    }
    if (!g.over) throw new Error('対局が終わらない');
    // 同形反復が本当に起きていないか検証
    const keys = g.positionKeyList();
    const uniq = new Set<string>();
    for (let i = 0; i < keys.length; i++) {
      // パスでは盤面が変わらないため、直前と同じキーは許容
      if (i > 0 && keys[i] === keys[i - 1]) continue;
      if (uniq.has(keys[i])) throw new Error('盤面が同形反復している');
      uniq.add(keys[i]);
    }
  }
  assert(true, 'ランダム100局: 全局終局・同形反復なし');
}

console.log('[投了]');
{
  // 手番側の投了（黒0の後は白番 → 白の投了 = コード61）
  const g = new Game(6.5);
  g.play(0);
  assert(g.resign(WHITE), '白の投了が成功');
  assert(g.over, '投了で終局');
  let s = g.score();
  assert(s.winner === 'black' && s.byResign === WHITE, '黒の中押し勝ち');
  assert(!g.resign(BLACK), '終局後の投了は不可');
  assert(!g.undoFor(BLACK), '終局後の待ったは不可');
  const codes = logToMoves(g.moveLog);
  assert(codes.length === 2 && codes[1] === 61, '手番側の投了コード = 61');
  const rep = replayKifu(decodeKifu(encodeKifu(6.5, codes))!);
  assert(rep !== null && rep!.resigned === WHITE && rep!.score().winner === 'black',
    '投了を含む棋譜が往復で再現される');

  // 非手番側の投了（白番中に黒が投了 = コード62）
  const g2 = new Game(6.5);
  g2.play(0);
  assert(g2.resign(BLACK), '手番外でも投了できる');
  s = g2.score();
  assert(s.winner === 'white' && s.byResign === BLACK, '白の中押し勝ち');
  const codes2 = logToMoves(g2.moveLog);
  assert(codes2[1] === 62, '非手番側の投了コード = 62');
  const rep2 = replayKifu(decodeKifu(encodeKifu(6.5, codes2))!);
  assert(rep2 !== null && rep2!.resigned === BLACK, '非手番投了の棋譜も再現される');
}

console.log('[棋譜エンコード/デコード]');
{
  // ランダム対局を1局打って往復変換を確認
  const g = new Game(6.5);
  let rngState = 777;
  const rng = () => {
    rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
    return rngState / 0x80000000;
  };
  let moves = 0;
  while (!g.over && moves < 200) {
    const legal = g.legalMoves();
    if (moves > 150 || legal.length === 0 || rng() < 0.03) g.pass();
    else g.play(legal[Math.floor(rng() * legal.length)]);
    moves++;
  }
  const enc = encodeKifu(g.komi, logToMoves(g.moveLog));
  assert(/^[A-Za-z0-9\-_]+$/.test(enc), 'Base64URL安全な文字のみ');
  const dec = decodeKifu(enc);
  assert(dec !== null && dec.komi === 6.5, 'コミが往復で一致');
  assert(
    dec !== null && JSON.stringify(dec.moves) === JSON.stringify(logToMoves(g.moveLog)),
    '手順が往復で一致'
  );
  const replayed = dec && replayKifu(dec);
  assert(
    replayed !== null && replayed!.board.join() === g.board.join(),
    '再生結果の盤面が一致'
  );

  // 負のコミ・小数コミ
  const enc2 = encodeKifu(-3.5, [0, 60, 59]);
  const dec2 = decodeKifu(enc2);
  assert(dec2 !== null && dec2.komi === -3.5, '負のコミも往復で一致');
  assert(dec2 !== null && JSON.stringify(dec2.moves) === '[0,60,59]', 'パス(60)を含む手順が一致');

  // 不正な入力
  assert(decodeKifu('!!!') === null, '不正な文字は拒否');
  assert(decodeKifu('') === null, '空文字は拒否');
  // 違法手順（同じ点に2回）は再生検証で拒否
  const bad = decodeKifu(encodeKifu(6.5, [0, 0]));
  assert(bad !== null && replayKifu(bad) === null, '違法手順の棋譜は再生検証で拒否');
}

if (failures > 0) {
  console.error(`\n${failures} 件のテストが失敗`);
  process.exit(1);
}
console.log('\n全テスト合格');
