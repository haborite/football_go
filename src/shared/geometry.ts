// 碁盤球の幾何: 切頂二十面体（サッカーボール）の60頂点と90辺。
// すべての頂点は対称で、各頂点から延びる辺の数は3。

export const N = 60;

const PHI = (1 + Math.sqrt(5)) / 2;

function buildRawVertices(): number[][] {
  const pts: number[][] = [];
  // 偶置換（巡回置換）を追加
  const addEven = (x: number, y: number, z: number) => {
    pts.push([x, y, z], [y, z, x], [z, x, y]);
  };
  // 切頂二十面体の頂点座標（辺長2）:
  //   (0, ±1, ±3φ), (±1, ±(2+φ), ±2φ), (±2, ±(1+2φ), ±φ) の偶置換
  for (const s1 of [1, -1])
    for (const s2 of [1, -1]) addEven(0, s1 * 1, s2 * 3 * PHI);
  for (const s0 of [1, -1])
    for (const s1 of [1, -1])
      for (const s2 of [1, -1]) addEven(s0 * 1, s1 * (2 + PHI), s2 * 2 * PHI);
  for (const s0 of [1, -1])
    for (const s1 of [1, -1])
      for (const s2 of [1, -1]) addEven(s0 * 2, s1 * (1 + 2 * PHI), s2 * PHI);
  return pts;
}

function build(): { verts: number[][]; adj: number[][]; edges: [number, number][] } {
  const raw = buildRawVertices();
  if (raw.length !== N) throw new Error(`vertex count ${raw.length} !== ${N}`);

  const adj: number[][] = Array.from({ length: N }, () => []);
  const edges: [number, number][] = [];
  const EDGE_SQ = 4; // 辺長2
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const dx = raw[i][0] - raw[j][0];
      const dy = raw[i][1] - raw[j][1];
      const dz = raw[i][2] - raw[j][2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (Math.abs(d2 - EDGE_SQ) < 1e-6) {
        adj[i].push(j);
        adj[j].push(i);
        edges.push([i, j]);
      }
    }
  }
  if (edges.length !== 90) throw new Error(`edge count ${edges.length} !== 90`);
  for (let i = 0; i < N; i++) {
    if (adj[i].length !== 3) throw new Error(`vertex ${i} degree ${adj[i].length} !== 3`);
  }

  // 球面に投影（「膨らんだ」切頂二十面体）: 単位球上に正規化
  const verts = raw.map((v) => {
    const len = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / len, v[1] / len, v[2] / len];
  });

  return { verts, adj, edges };
}

const built = build();

/** 単位球上の60頂点座標 */
export const VERTS: readonly (readonly number[])[] = built.verts;
/** 隣接リスト（各頂点ちょうど3つ） */
export const ADJ: readonly (readonly number[])[] = built.adj;
/** 90辺 */
export const EDGES: readonly (readonly [number, number])[] = built.edges;

/** 12個の五角形面の中心方向（描画用・正二十面体の頂点方向） */
export const PENTAGON_DIRS: readonly (readonly number[])[] = (() => {
  const dirs: number[][] = [];
  for (const s1 of [1, -1])
    for (const s2 of [1, -1]) {
      dirs.push([0, s1, s2 * PHI], [s1, s2 * PHI, 0], [s2 * PHI, 0, s1]);
    }
  return dirs.map((v) => {
    const len = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / len, v[1] / len, v[2] / len];
  });
})();
