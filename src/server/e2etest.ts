// オンライン対戦サーバーのE2Eテスト: `npx tsx src/server/e2etest.ts`
// サーバーを子プロセスで起動し、2クライアントで 部屋作成→参加→着手→待った→パス×2終局 を検証する

import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 8790;
const URL = `ws://localhost:${PORT}/ws`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Client {
  ws: WebSocket;
  private queue: any[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data) => this.queue.push(JSON.parse(data.toString())));
  }

  static connect(): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(URL);
      ws.on('open', () => resolve(new Client(ws)));
      ws.on('error', reject);
    });
  }

  send(msg: unknown) {
    this.ws.send(JSON.stringify(msg));
  }

  /** type（と条件）に合う最初の未消費メッセージを待って返す */
  async expect(type: string, pred?: (m: any) => boolean, timeoutMs = 5000): Promise<any> {
    const limit = Date.now() + timeoutMs;
    while (Date.now() < limit) {
      const i = this.queue.findIndex((m) => m.t === type && (!pred || pred(m)));
      if (i >= 0) return this.queue.splice(i, 1)[0];
      await sleep(15);
    }
    throw new Error(`タイムアウト: ${type} を受信できず (queue=${JSON.stringify(this.queue)})`);
  }
}

async function main() {
  console.log('サーバー起動中…');
  const server = spawn(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'src/server/server.ts'],
    { env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe' }
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('サーバーが起動しない')), 15000);
      server.stdout.on('data', (d: Buffer) => {
        if (d.toString().includes('起動')) {
          clearTimeout(t);
          resolve();
        }
      });
      server.on('exit', () => reject(new Error('サーバーが終了した')));
    });
    console.log('サーバー起動OK');

    const a = await Client.connect(); // 作成者（黒を希望）
    const b = await Client.connect(); // 参加者

    a.send({ t: 'create', komi: 6.5, color: 'black' });
    const created = await a.expect('created');
    console.log(`部屋作成OK: ${created.room}`);

    b.send({ t: 'join', room: created.room });
    const [sa, sb] = await Promise.all([a.expect('start'), b.expect('start')]);
    if (sa.color !== 1 || sb.color !== 2)
      throw new Error(`色割り当てが不正: ${sa.color}/${sb.color}`);
    console.log('対局開始OK: 作成者=黒, 参加者=白');

    // 開始直後の初期盤面stateを消費しておく
    await Promise.all([
      a.expect('state', (m) => m.log.length === 0),
      b.expect('state', (m) => m.log.length === 0),
    ]);

    // 黒が打つ → 両者に反映
    a.send({ t: 'move', p: 0 });
    const st1 = await b.expect('state', (m) => m.log.length === 1);
    if (st1.log[0].point !== 0 || st1.log[0].by !== 1) throw new Error('着手内容が不正');
    await a.expect('state', (m) => m.log.length === 1);
    console.log('着手の同期OK');

    // 手番でない側の着手は拒否
    a.send({ t: 'move', p: 1 });
    const ill = await a.expect('illegal');
    if (ill.reason !== 'notyourturn') throw new Error('手番チェックが効いていない');
    console.log('手番チェックOK');

    // 白が打つ → 黒が待った → 黒の手とその後の白の応手が両方巻き戻る
    b.send({ t: 'move', p: 30 });
    await a.expect('state', (m) => m.log.length === 2);
    a.send({ t: 'undo' });
    const u = await b.expect('undone');
    if (u.by !== 1) throw new Error('待ったの主体が不正');
    const st2 = await b.expect('state', (m) => m.log.length === 0);
    if (st2.undoCounts['1'] !== 1) throw new Error('待った回数が不正');
    console.log('待ったOK（黒の手と白の応手が巻き戻り、回数がカウントされた）');

    // 連続パスで終局
    a.send({ t: 'pass' });
    await b.expect('state', (m) => m.log.length === 1);
    b.send({ t: 'pass' });
    const fin = await a.expect('state', (m) => m.over === true);
    if (fin.log.length !== 2) throw new Error('終局時の棋譜が不正');
    console.log('終局OK');

    // 退出通知
    a.ws.close();
    await b.expect('opponentLeft');
    console.log('退出通知OK');
    b.ws.close();

    // 投了シナリオ（別部屋）
    const c = await Client.connect();
    const d = await Client.connect();
    c.send({ t: 'create', komi: 6.5, color: 'black' });
    const created2 = await c.expect('created');
    d.send({ t: 'join', room: created2.room });
    await Promise.all([c.expect('start'), d.expect('start')]);
    await Promise.all([
      c.expect('state', (m) => m.log.length === 0),
      d.expect('state', (m) => m.log.length === 0),
    ]);
    c.send({ t: 'move', p: 5 });
    await d.expect('state', (m) => m.log.length === 1);
    // 黒(c)が手番外で投了 → 両者のstateが終局になる
    c.send({ t: 'resign' });
    const stR = await d.expect('state', (m) => m.over === true);
    const lastR = stR.log[stR.log.length - 1];
    if (lastR.type !== 'resign' || lastR.by !== 1) throw new Error('投了がstateに反映されない');
    console.log('投了OK（手番外の投了が両者に同期された）');
    c.ws.close();
    d.ws.close();

    console.log('\nE2Eテスト 全項目合格');
  } finally {
    server.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
