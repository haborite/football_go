// ブラウザ起動スモークテスト: タイトル画面 → NPC対局開始 → 3D碁盤球の描画確認
// 使い方: npm run dev を起動した状態で `node scripts/browsertest.mjs`
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = 'http://localhost:5173';
mkdirSync('scripts/shots', { recursive: true });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));
page.on('dialog', (d) => d.accept()); // confirm（投了など）を承認

console.log('タイトル画面へ…');
await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
await page.waitForSelector('text=囲碁サッカー', { timeout: 15000 });
await page.screenshot({ path: 'scripts/shots/01-title.png' });
console.log('タイトル画面OK → スクリーンショット保存');

console.log('NPC対局開始…');
await page.click('#btn-npc-start');
await page.waitForSelector('#board-canvas', { timeout: 15000 });
// 3D初期化と最初の描画を待つ
await page.waitForTimeout(2500);
await page.screenshot({ path: 'scripts/shots/02-game.png' });

const status = await page.textContent('#status-line');
console.log(`状態表示: ${status}`);

// 盤の中央付近をクリックして石が置けるか試す（頂点に当たれば手番が変わる）
const box = await page.locator('#board-canvas').boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
let placed = false;
for (const [dx, dy] of [[0, 0], [40, 0], [0, 40], [-40, -20], [60, 50], [-60, 40], [30, -50]]) {
  await page.mouse.click(cx + dx, cy + dy);
  await page.waitForTimeout(300);
  const st = await page.textContent('#status-line');
  if (st && !st.startsWith('あなたの番')) {
    placed = true;
    console.log(`着手成功（クリック位置 +${dx},+${dy}）→ 状態: ${st}`);
    break;
  }
}
if (!placed) {
  console.error('NG: クリックでの着手ができなかった');
  process.exitCode = 1;
}
await page.screenshot({ path: 'scripts/shots/03-after-click.png' });

// NPC（Web Worker）の応手を待つ
if (placed) {
  await page.waitForFunction(
    () => document.getElementById('status-line').textContent.startsWith('あなたの番'),
    null,
    { timeout: 20000 }
  );
  const white = await page.textContent('#count-white');
  console.log(`NPCが応手した（白 ${white.trim()} 子）`);
  if (white.trim() !== '1') {
    console.error('NG: NPCの応手後の白石数が1ではない');
    process.exitCode = 1;
  }
  await page.screenshot({ path: 'scripts/shots/04-npc-replied.png' });
}

// サウンドトグルの動作確認（合成音はクリックフロー全体で発火済み。エラーが出ないこと）
console.log('サウンドトグルテスト…');
await page.click('#btn-bgm');
let bgmLabel = (await page.textContent('#btn-bgm')).trim();
if (!bgmLabel.includes('OFF')) {
  console.error(`NG: BGMトグルが効かない: ${bgmLabel}`);
  process.exitCode = 1;
}
await page.click('#btn-bgm');
await page.click('#btn-se');
await page.click('#btn-se');
bgmLabel = (await page.textContent('#btn-bgm')).trim();
const seLabel = (await page.textContent('#btn-se')).trim();
console.log(`サウンドトグルOK（${bgmLabel} / ${seLabel}）`);

// 回転操作（縦方向に大きくドラッグ — 旧OrbitControlsでは極でロックしていた動き）
console.log('回転操作テスト…');
for (let i = 0; i < 4; i++) {
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy - 200, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}
await page.screenshot({ path: 'scripts/shots/05-after-rotate.png' });
console.log('縦方向連続回転OK（エラーなしで継続）');

// 投了 → 中押し勝ちの結果画面
console.log('投了テスト…');
await page.click('#btn-resign');
await page.waitForSelector('#overlay-result:not(.hidden)', { timeout: 5000 });
const resignText = (await page.textContent('#result-winner')).trim();
if (!resignText.includes('中押し勝ち')) {
  console.error(`NG: 投了の結果表示が不正: ${resignText}`);
  process.exitCode = 1;
} else {
  console.log(`投了OK（${resignText}）`);
}
await page.screenshot({ path: 'scripts/shots/07-resign.png' });

// 棋譜URL再生モード
console.log('棋譜再生モードテスト…');
// kifu形式: [1, コミ*2, ...手] を Base64URL 化。コミ6.5、黒0→白10 の2手
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const bytes = [1, 13, 0, 10];
let kifu = '';
for (let i = 0; i < bytes.length; i += 3) {
  const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
  kifu += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
  if (i + 1 < bytes.length) kifu += B64[(n >> 6) & 63];
  if (i + 2 < bytes.length) kifu += B64[n & 63];
}
await page.goto(`${URL}/?kifu=${kifu}`, { waitUntil: 'load' });
await page.waitForSelector('#replay-controls:not(.hidden)', { timeout: 15000 });
let counter = (await page.textContent('#rp-counter')).trim();
if (counter !== '0 / 2 手') {
  console.error(`NG: 再生カウンタが不正: ${counter}`);
  process.exitCode = 1;
}
await page.click('#btn-rp-next');
await page.click('#btn-rp-next');
await page.waitForTimeout(400);
counter = (await page.textContent('#rp-counter')).trim();
const rb = (await page.textContent('#count-black')).trim();
const rw = (await page.textContent('#count-white')).trim();
if (counter === '2 / 2 手' && rb === '1' && rw === '1') {
  console.log(`再生モードOK（${counter}、黒${rb}子 白${rw}子）`);
} else {
  console.error(`NG: 再生結果が不正: ${counter} 黒${rb} 白${rw}`);
  process.exitCode = 1;
}
await page.screenshot({ path: 'scripts/shots/06-replay.png' });

if (consoleErrors.length > 0) {
  console.error('コンソールエラー:');
  for (const e of consoleErrors) console.error('  ' + e);
  process.exitCode = 1;
} else {
  console.log('コンソールエラーなし');
}

await browser.close();
