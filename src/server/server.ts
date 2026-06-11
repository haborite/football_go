// 囲碁サッカー オンライン対戦サーバー
// - WebSocket（/ws）で部屋の作成・参加・着手中継
// - サーバー側が正本のルールエンジンを持ち、すべての手を検証する
// - ビルド済みクライアント（dist/）の静的配信も行う

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { BLACK, Game, PlayerColor, WHITE } from '../shared/rules';

const PORT = Number(process.env.PORT || 8787);
const DIST = path.resolve(process.cwd(), 'dist');

// ---------- 部屋管理 ----------

interface Room {
  code: string;
  komi: number;
  creatorPrefers: 'black' | 'white' | 'random';
  game: Game | null; // 2人揃うまで null
  sockets: WebSocket[]; // [作成者, 参加者]
  colors: Map<WebSocket, PlayerColor>;
}

const rooms = new Map<string, Room>();
const socketRoom = new Map<WebSocket, Room>();

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 紛らわしい文字を除外
function newRoomCode(): string {
  for (;;) {
    let code = '';
    for (let i = 0; i < 5; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
    if (!rooms.has(code)) return code;
  }
}

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastState(room: Room) {
  if (!room.game) return;
  const msg = {
    t: 'state',
    log: room.game.moveLog,
    undoCounts: room.game.undoCounts,
    over: room.game.over,
  };
  for (const ws of room.sockets) send(ws, msg);
}

function handleMessage(ws: WebSocket, raw: string) {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof msg !== 'object' || msg === null) return;

  switch (msg.t) {
    case 'create': {
      if (socketRoom.has(ws)) return;
      const komi = Number.isFinite(Number(msg.komi)) ? Number(msg.komi) : 0;
      const prefers =
        msg.color === 'black' || msg.color === 'white' ? msg.color : 'random';
      const room: Room = {
        code: newRoomCode(),
        komi,
        creatorPrefers: prefers,
        game: null,
        sockets: [ws],
        colors: new Map(),
      };
      rooms.set(room.code, room);
      socketRoom.set(ws, room);
      send(ws, { t: 'created', room: room.code });
      break;
    }

    case 'join': {
      if (socketRoom.has(ws)) return;
      const code = String(msg.room || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        send(ws, { t: 'error', msg: '部屋が見つかりません' });
        return;
      }
      if (room.sockets.length >= 2) {
        send(ws, { t: 'error', msg: 'この部屋は満員です' });
        return;
      }
      room.sockets.push(ws);
      socketRoom.set(ws, room);

      // 色を決定して対局開始
      const creatorColor: PlayerColor =
        room.creatorPrefers === 'black'
          ? BLACK
          : room.creatorPrefers === 'white'
            ? WHITE
            : Math.random() < 0.5
              ? BLACK
              : WHITE;
      const joinerColor: PlayerColor = creatorColor === BLACK ? WHITE : BLACK;
      room.colors.set(room.sockets[0], creatorColor);
      room.colors.set(room.sockets[1], joinerColor);
      room.game = new Game(room.komi);

      send(room.sockets[0], { t: 'start', color: creatorColor, komi: room.komi, room: room.code });
      send(room.sockets[1], { t: 'start', color: joinerColor, komi: room.komi, room: room.code });
      broadcastState(room);
      break;
    }

    case 'move':
    case 'pass':
    case 'resign':
    case 'undo': {
      const room = socketRoom.get(ws);
      if (!room || !room.game) return;
      const color = room.colors.get(ws);
      if (color === undefined) return;
      const game = room.game;

      if (msg.t === 'undo') {
        if (game.undoFor(color)) {
          for (const s of room.sockets) send(s, { t: 'undone', by: color });
          broadcastState(room);
        } else {
          send(ws, { t: 'illegal', reason: 'undo' });
        }
        return;
      }

      if (game.over) {
        send(ws, { t: 'illegal', reason: 'gameover' });
        return;
      }
      if (msg.t === 'resign') {
        // 投了は手番に関係なく可能
        game.resign(color);
        broadcastState(room);
        return;
      }
      if (game.turn !== color) {
        send(ws, { t: 'illegal', reason: 'notyourturn' });
        return;
      }
      if (msg.t === 'pass') {
        game.pass();
        broadcastState(room);
      } else {
        const p = Number(msg.p);
        if (!Number.isInteger(p) || p < 0 || p >= 60) return;
        const r = game.play(p);
        if (!r.ok) {
          send(ws, { t: 'illegal', reason: r.reason });
          return;
        }
        broadcastState(room);
      }
      break;
    }
  }
}

function handleClose(ws: WebSocket) {
  const room = socketRoom.get(ws);
  if (!room) return;
  socketRoom.delete(ws);
  rooms.delete(room.code);
  for (const other of room.sockets) {
    if (other !== ws) {
      send(other, { t: 'opponentLeft' });
      socketRoom.delete(other);
    }
  }
}

// ---------- 静的配信 ----------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
};

const server = http.createServer(async (req, res) => {
  if (!existsSync(DIST)) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('クライアントが未ビルドです。`npm run build` を実行してください。（開発時は `npm run dev` で http://localhost:5173 を開きます）');
    return;
  }
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.join(DIST, rel);
    if (!file.startsWith(DIST)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const data = await readFile(file);
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    // SPAフォールバック
    try {
      const data = await readFile(path.join(DIST, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  ws.on('message', (data) => handleMessage(ws, data.toString()));
  ws.on('close', () => handleClose(ws));
  ws.on('error', () => {});
});

server.listen(PORT, () => {
  console.log(`囲碁サッカー サーバー起動: http://localhost:${PORT} (WebSocket: /ws)`);
});
