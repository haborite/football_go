// かんたんルール説明（チュートリアル）
// 囲碁を知らない人向けの数枚のスライド。初回訪問時に表示を提案し、
// タイトル画面のボタンからいつでも開ける。

const LS_SEEN = 'gofb-tut-seen';

// ---------- 盤面イラスト（SVG）生成 ----------
// 実際の碁盤球（切頂二十面体）を五角形の正面から見た図。
// 中央五角形 P0..P4、スポーク先 S0..S4、外周 OA[k]/OB[k]（S[k] と S[k+1] の間）

const CX = 140;
const CY = 128;
const BALL_R = 112;

type Pt = readonly [number, number];

function pt(angleDeg: number, r: number): Pt {
  const a = (angleDeg * Math.PI) / 180;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
}

const ANG = [0, 1, 2, 3, 4].map((k) => -90 + 72 * k);
const P = ANG.map((a) => pt(a, 48));
const S = ANG.map((a) => pt(a, 86));
const OA = ANG.map((a) => pt(a + 24, 103));
const OB = ANG.map((a) => pt(a + 48, 103));

const f = (p: Pt) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;

/** 文書内で共有する <defs>（グラデーション・盤面 1 個分）を持つ不可視SVG */
function boardDefsSvg(): string {
  // 隣の五角形（球の縁で切れて見える黒いパッチ）
  let slivers = '';
  for (let k = 0; k < 5; k++) {
    const ea = pt(ANG[k] + 24, 150);
    const eb = pt(ANG[k] + 48, 150);
    slivers += `<polygon points="${f(OA[k])} ${f(ea)} ${f(eb)} ${f(OB[k])}" fill="#33271a"/>`;
  }
  // 線: スポーク（P-S）＋外周リング（S-OA-OB-S…）
  let lines = '';
  for (let k = 0; k < 5; k++) lines += `M${f(P[k])}L${f(S[k])}`;
  lines += `M${f(S[0])}`;
  for (let k = 0; k < 5; k++) lines += `L${f(OA[k])}L${f(OB[k])}L${f(S[(k + 1) % 5])}`;
  // 外周点から縁の外へ続く線（盤は球の裏側へ続いている）
  let stubs = '';
  for (let k = 0; k < 5; k++) {
    stubs += `M${f(OA[k])}L${f(pt(ANG[k] + 24, BALL_R))}`;
    stubs += `M${f(OB[k])}L${f(pt(ANG[k] + 48, BALL_R))}`;
  }
  const dots = [...P, ...S, ...OA, ...OB]
    .map((p) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3" fill="#241b0e"/>`)
    .join('');
  return `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
    <radialGradient id="tg-ball" cx="38%" cy="30%" r="85%">
      <stop offset="0%" stop-color="#f0d59c"/>
      <stop offset="55%" stop-color="#d9b36c"/>
      <stop offset="100%" stop-color="#96702f"/>
    </radialGradient>
    <radialGradient id="tg-black" cx="35%" cy="30%" r="75%">
      <stop offset="0%" stop-color="#606060"/>
      <stop offset="100%" stop-color="#0a0a0a"/>
    </radialGradient>
    <radialGradient id="tg-white" cx="35%" cy="30%" r="75%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#c6c6ba"/>
    </radialGradient>
    <clipPath id="tg-clip"><circle cx="${CX}" cy="${CY}" r="${BALL_R}"/></clipPath>
    <g id="tg-board">
      <circle cx="${CX}" cy="${CY}" r="${BALL_R}" fill="url(#tg-ball)" stroke="#221a0c" stroke-width="2"/>
      <g clip-path="url(#tg-clip)">${slivers}</g>
      <path d="${lines}" stroke="#3c2c18" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      <path d="${stubs}" stroke="#3c2c18" stroke-width="2.5" fill="none" opacity="0.5"/>
      <polygon points="${P.map(f).join(' ')}" fill="#33271a" stroke="#3c2c18" stroke-width="2.5"/>
      ${dots}
    </g>
  </defs></svg>`;
}

function stone(p: Pt, color: 'b' | 'w', opts: { num?: number; faded?: boolean } = {}): string {
  const x = p[0].toFixed(1);
  const y = p[1].toFixed(1);
  const grad = color === 'b' ? 'tg-black' : 'tg-white';
  const stroke = color === 'b' ? '#000' : '#8a8a80';
  let s = `<g${opts.faded ? ' opacity="0.35"' : ''}>`;
  s += `<circle cx="${x}" cy="${y}" r="12.5" fill="url(#${grad})" stroke="${stroke}" stroke-width="1"/>`;
  if (opts.num !== undefined) {
    const fill = color === 'b' ? '#fff' : '#222';
    s += `<text x="${x}" y="${(p[1] + 4.5).toFixed(1)}" text-anchor="middle" font-size="13" font-weight="bold" fill="${fill}">${opts.num}</text>`;
  }
  return s + '</g>';
}

/** 破線の丸印（着目点） */
function ring(p: Pt, color = '#e0452f'): string {
  return `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="16" fill="none" stroke="${color}" stroke-width="2.5" stroke-dasharray="4 3"/>`;
}

/** 「目」マーク（金色の破線丸＋文字） */
function eyeMark(p: Pt): string {
  return (
    ring(p, '#ffd76e') +
    `<text x="${p[0].toFixed(1)}" y="${(p[1] + 4).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="bold" fill="#ffd76e">目</text>`
  );
}

/** 盤面1個＋その上の要素 */
function ball(inner: string, transform = ''): string {
  return `<g${transform ? ` transform="${transform}"` : ''}><use href="#tg-board"/>${inner}</g>`;
}

function caption(x: number, y: number, text: string, color = '#c8cede'): string {
  return `<text x="${x}" y="${y}" text-anchor="middle" font-size="16" font-weight="bold" fill="${color}">${text}</text>`;
}

/** 左右パネルの間の矢印 */
const ARROW = `<polygon points="294,114 320,114 320,103 346,126 320,149 320,138 294,138" fill="#ffd76e"/>`;

// ---------- スライド定義 ----------

interface Slide {
  title: string;
  svg: string;
  body: string;
}

function buildSlides(): Slide[] {
  // 1枚目: 打ち方
  const s1 =
    `<svg class="tut-img" viewBox="0 0 280 260">` +
    ball(
      stone(P[0], 'b', { num: 1 }) +
        stone(S[2], 'w', { num: 2 }) +
        stone(OA[4], 'b', { num: 3 }) +
        ring(P[3], '#ffd76e')
    ) +
    `</svg>`;

  // 2枚目: 取り方（左: アタリ → 右: 取られた後）
  const s2 =
    `<svg class="tut-img wide" viewBox="0 0 640 300">` +
    ball(
      stone(P[0], 'b') + stone(P[1], 'w') + stone(P[4], 'w') + ring(S[0]),
      'translate(8,6) scale(0.92)'
    ) +
    ball(
      stone(P[1], 'w') + stone(P[4], 'w') + stone(S[0], 'w') + ring(S[0]) +
        stone(P[0], 'b', { faded: true }) +
        `<path d="M${(P[0][0] - 9).toFixed(1)},${(P[0][1] - 9).toFixed(1)}l18,18m0,-18l-18,18" stroke="#e0452f" stroke-width="4" stroke-linecap="round"/>`,
      'translate(366,6) scale(0.92)'
    ) +
    ARROW +
    caption(137, 282, '黒の「いき」は のこり1つ！') +
    caption(495, 282, '白に置かれると…取られて消える！') +
    `</svg>`;

  // 3枚目: 終局と勝敗（盤がほぼ埋まった様子）
  const s3Black = [P[0], P[3], P[4], S[0], S[3], S[4], OB[3], OA[4], OB[4]];
  const s3White = [P[1], P[2], S[1], S[2], OB[0], OA[1], OB[1], OA[2]];
  const s3 =
    `<svg class="tut-img" viewBox="0 0 280 260">` +
    ball(
      s3Black.map((p) => stone(p, 'b')).join('') + s3White.map((p) => stone(p, 'w')).join('')
    ) +
    `</svg>`;

  // 4枚目: ヒント（左: 埋めすぎて全滅 / 右: 空き点2つで安泰）
  // 黒のかたまり: 五角形＋スポーク＋外周の一部。右図は P0・P2 を空けて「目」にする
  const groupBlack = [P[1], P[3], P[4], S[0], S[1], S[2], S[4], OA[1], OB[1], OA[4], OB[4]];
  const groupWhite = [S[3], OA[0], OB[0], OA[2], OB[2], OA[3], OB[3]];
  const s4 =
    `<svg class="tut-img wide" viewBox="0 0 640 300">` +
    ball(
      [...groupBlack, P[0], P[2]].map((p) => stone(p, 'b')).join('') +
        groupWhite.map((p) => stone(p, 'w')).join('') +
        `<path d="M95,83l90,90m0,-90l-90,90" stroke="#e0452f" stroke-width="8" stroke-linecap="round" opacity="0.85"/>`,
      'translate(8,6) scale(0.92)'
    ) +
    ball(
      groupBlack.map((p) => stone(p, 'b')).join('') +
        groupWhite.map((p) => stone(p, 'w')).join('') +
        eyeMark(P[0]) +
        eyeMark(P[2]),
      'translate(366,6) scale(0.92)'
    ) +
    caption(137, 282, '埋めすぎ → まるごと取られる！', '#ff8c7a') +
    caption(495, 282, '空き点2つ → ぜったい取られない！', '#ffd76e') +
    `</svg>`;

  return [
    {
      title: '線の交わる点に、こうたいで置く',
      svg: s1,
      body:
        'サッカーボール型の碁盤です。黒と白が、<strong>線の交わる点</strong>（全部で60か所）に' +
        '<strong>こうたいで</strong>石を置いていきます。黒が先です。' +
        '黄色の印のように、<strong>空いている点ならどこでもOK</strong>。一度置いた石は動かせません。',
    },
    {
      title: '囲むと取れる',
      svg: s2,
      body:
        '石から線でつながった<strong>となりの空き点</strong>が、その石の「<strong>いき</strong>」です。' +
        'いきを相手に<strong>全部ふさがれる</strong>と、石は取られて盤から消えます。' +
        'くっついている味方の石どうしは、ひとつのかたまりとして同じ運命になります。',
    },
    {
      title: '多いほうが勝ち',
      svg: s3,
      body:
        '置きたい場所がなくなったら「パス」。<strong>二人が続けてパス</strong>すると試合終了です。' +
        '<strong>盤の上に石が多いほう</strong>の勝ち！（例：黒31子・白29子なら黒の2目勝ち）',
    },
    {
      title: 'ヒント：埋めすぎに注意！',
      svg: s4,
      body:
        '自分の陣地を<strong>すき間なく埋めつくすのは危険</strong>。最後にまるごと囲まれて、全部取られてしまいます。' +
        '陣地の中に<strong>はなれた空き点を2つ</strong>残しておけば、相手はどちらの空き点にも置けない' +
        '（置いたとたんに自分が囲まれてしまう手は禁止）ので、その石たちは<strong>絶対に取られません</strong>。',
    },
  ];
}

// ---------- 表示・ナビゲーション ----------

export function initTutorial(opts: { firstVisitPrompt: boolean }): void {
  const $ = (id: string) => document.getElementById(id) as HTMLElement;
  const overlay = $('overlay-tutorial');
  const welcome = $('overlay-welcome');
  const slidesEl = $('tut-slides');
  const dotsEl = $('tut-dots');
  const prevBtn = $('btn-tut-prev') as HTMLButtonElement;
  const nextBtn = $('btn-tut-next') as HTMLButtonElement;

  const slides = buildSlides();
  slidesEl.insertAdjacentHTML('beforebegin', boardDefsSvg());
  slidesEl.innerHTML = slides
    .map(
      (s, i) => `<section class="tut-slide${i === 0 ? '' : ' hidden'}">
        <h3>${i + 1}. ${s.title}</h3>
        ${s.svg}
        <p>${s.body}</p>
      </section>`
    )
    .join('');
  dotsEl.innerHTML = slides.map((_, i) => `<button class="tut-dot" data-i="${i}"></button>`).join('');

  let cur = 0;

  function render() {
    slidesEl.querySelectorAll('.tut-slide').forEach((el, i) => {
      el.classList.toggle('hidden', i !== cur);
    });
    dotsEl.querySelectorAll('.tut-dot').forEach((el, i) => {
      el.classList.toggle('on', i === cur);
    });
    prevBtn.disabled = cur === 0;
    nextBtn.textContent = cur === slides.length - 1 ? 'さっそく対局へ！' : '次へ →';
  }

  function open() {
    localStorage.setItem(LS_SEEN, '1');
    cur = 0;
    render();
    overlay.classList.remove('hidden');
  }

  function close() {
    overlay.classList.add('hidden');
  }

  prevBtn.addEventListener('click', () => {
    if (cur > 0) {
      cur--;
      render();
    }
  });
  nextBtn.addEventListener('click', () => {
    if (cur < slides.length - 1) {
      cur++;
      render();
    } else {
      close();
    }
  });
  dotsEl.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('.tut-dot') as HTMLElement | null;
    if (!t) return;
    cur = Number(t.dataset.i);
    render();
  });
  $('btn-tut-close').addEventListener('click', close);
  $('btn-tutorial').addEventListener('click', open);

  document.addEventListener('keydown', (e) => {
    if (overlay.classList.contains('hidden')) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft' && cur > 0) {
      cur--;
      render();
    } else if (e.key === 'ArrowRight' && cur < slides.length - 1) {
      cur++;
      render();
    } else {
      return;
    }
    e.preventDefault();
  });

  // 初回訪問: ルール説明を見るかどうかを聞く
  $('btn-welcome-yes').addEventListener('click', () => {
    welcome.classList.add('hidden');
    open();
  });
  $('btn-welcome-no').addEventListener('click', () => {
    localStorage.setItem(LS_SEEN, '1');
    welcome.classList.add('hidden');
  });
  if (opts.firstVisitPrompt && localStorage.getItem(LS_SEEN) === null) {
    welcome.classList.remove('hidden');
  }
}
