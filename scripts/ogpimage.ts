// OGP画像（public/ogp.png, 1200×630）の生成
// 実際の3D碁盤球を中盤風の局面で撮影し、タイトルを添えたカードに合成する。
// 使い方: npm run dev を起動した状態で `npx tsx scripts/ogpimage.ts`
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { Game } from '../src/shared/rules';
import { encodeKifu, logToMoves } from '../src/shared/kifu';

const URL = 'http://localhost:5173';
const OUT = 'public/ogp.png';

// 再現性のためシード付き乱数で局面を作る
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20260612);
const game = new Game(0);
for (let i = 0; i < 42 && !game.over; i++) {
  const cands: number[] = [];
  for (let p = 0; p < 60; p++) if (game.tryPlace(p).ok) cands.push(p);
  if (cands.length === 0) {
    game.pass();
    continue;
  }
  game.play(cands[Math.floor(rand() * cands.length)]);
}
const kifu = encodeKifu(0, logToMoves(game.moveLog));

const browser = await chromium.launch({ channel: 'msedge', headless: true });

// 1) 再生モードで盤面を表示し、碁盤球だけを正方形に切り出す
const page = await browser.newPage({
  viewport: { width: 1180, height: 900 },
  deviceScaleFactor: 2, // 高解像度で撮って合成時に縮小
});
await page.goto(`${URL}/?kifu=${kifu}`, { waitUntil: 'load' });
await page.waitForSelector('#replay-controls:not(.hidden)', { timeout: 15000 });
await page.click('#btn-rp-last');
// 視点ボタン・反対側ビュー（非表示にすると描画自体が止まる）・トーストを隠す
await page.addStyleTag({ content: '#view-buttons,#inset-frame,#toast{display:none!important}' });
await page.waitForTimeout(2000); // 3D描画の安定待ち
const box = await page.locator('#board-container').boundingBox();
if (!box) throw new Error('盤面コンテナが見つからない');
const side = Math.min(box.width, box.height) * 0.84;
const ballPng = await page.screenshot({
  clip: {
    x: box.x + box.width / 2 - side / 2,
    y: box.y + box.height / 2 - side / 2,
    width: side,
    height: side,
  },
});

// 2) タイトル入りの1200×630カードに合成
const card = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await card.setContent(`<!doctype html><html><body style="
    margin:0;width:1200px;height:630px;overflow:hidden;display:flex;align-items:center;
    background:radial-gradient(120% 120% at 30% 20%, #20293d 0%, #131826 55%, #0b0e17 100%);
    font-family:'Hiragino Kaku Gothic ProN','Yu Gothic UI','Meiryo',sans-serif;">
  <div style="flex:1;padding-left:76px;">
    <div style="font-size:84px;font-weight:bold;letter-spacing:0.1em;line-height:1.2;
        background:linear-gradient(180deg,#ffffff,#b8c4e0);-webkit-background-clip:text;
        background-clip:text;color:transparent;">囲碁サッカー</div>
    <div style="font-size:27px;color:#9aa6c0;margin-top:20px;letter-spacing:0.03em;">
      サッカーボール型の碁盤球で打つ、球面の純碁</div>
    <div style="font-size:23px;color:#ffd76e;margin-top:30px;">
      ⚽ NPC対戦・オンライン対戦・かんたんルール説明つき</div>
    <div style="font-size:21px;color:#707b96;margin-top:46px;">football-go.haborite.com</div>
  </div>
  <img src="data:image/png;base64,${ballPng.toString('base64')}"
    style="width:470px;height:470px;border-radius:50%;margin-right:62px;flex-shrink:0;
        box-shadow:0 30px 90px rgba(0,0,0,0.6);" />
</body></html>`);
await card.waitForTimeout(400);
mkdirSync('public', { recursive: true });
await card.screenshot({ path: OUT });
console.log(`OGP画像を生成しました: ${OUT}（手数: ${game.moveLog.length}）`);

await browser.close();
