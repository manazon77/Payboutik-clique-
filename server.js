const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log('Server running on port ' + PORT));

const wss = new WebSocketServer({ server });

const GAME_DURATION = 2 * 60 * 60 * 1000;
const COOLDOWN      = 24 * 60 * 60 * 1000;
const MAMADOU_CPS   = 3.5;

let players = {};
let session = { state: 'idle', startTime: null, endTime: null };
let mamadouInterval = null;
let broadcastThrottle = null;

function startMamadou() {
  if (mamadouInterval) return;
  mamadouInterval = setInterval(() => {
    if (session.state !== 'playing') { clearInterval(mamadouInterval); mamadouInterval = null; return; }
    const elapsed = (Date.now() - session.startTime) / 1000;
    players['MAMADOU'] = { name: 'Mamadou 👑', score: Math.floor(elapsed * MAMADOU_CPS), isMamadou: true };
    throttledBroadcast();
  }, 3000);
}

function getTop10() {
  return Object.entries(players)
    .map(([id, p]) => ({ id, name: p.name, score: p.score || 0, isMamadou: !!p.isMamadou }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

function throttledBroadcast() {
  if (broadcastThrottle) return;
  broadcastThrottle = setTimeout(() => {
    broadcastThrottle = null;
    const msg = JSON.stringify({
      type: 'leaderboard',
      players: getTop10(),
      total: Object.keys(players).filter(k => k !== 'MAMADOU').length
    });
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
  }, 500);
}

function broadcast(obj) {
  const str = JSON.stringify(obj);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(str); });
}

function checkGameEnd() {
  if (session.state !== 'playing') return;
  if (Date.now() >= session.endTime) endGame();
}

function endGame() {
  session.state = 'ended';
  session.endTime = Date.now();
  clearInterval(mamadouInterval);
  mamadouInterval = null;
  broadcast({ type: 'game_end', leaderboard: getTop10(), endTime: session.endTime });
  setTimeout(() => {
    players = {};
    session = { state: 'idle', startTime: null, endTime: null };
    broadcast({ type: 'reset' });
  }, COOLDOWN);
}

setInterval(checkGameEnd, 10000);

wss.on('connection', (ws) => {
  let myId = null;

  ws.send(JSON.stringify({
    type: 'state',
    session,
    leaderboard: getTop10(),
    total: Object.keys(players).filter(k => k !== 'MAMADOU').length
  }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'join') {
      if (session.state === 'playing' || session.state === 'ended') {
        ws.send(JSON.stringify({ type: 'error', reason: session.state, session, leaderboard: getTop10() }));
        return;
      }
      myId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      const name = String(msg.name || 'Anonyme').slice(0, 20).replace(/[<>]/g, '');
      players[myId] = { name, score: 0 };

      if (session.state === 'idle') {
        session.state = 'playing';
        session.startTime = Date.now();
        session.endTime = session.startTime + GAME_DURATION;
        players['MAMADOU'] = { name: 'Mamadou 👑', score: 0, isMamadou: true };
        startMamadou();
      }

      ws.send(JSON.stringify({ type: 'joined', id: myId, session }));
      throttledBroadcast();
    }

    if (msg.type === 'click' && myId && players[myId]) {
      const count = Math.min(parseInt(msg.count) || 1, 50);
      players[myId].score = (players[myId].score || 0) + count;
      throttledBroadcast();
    }
  });

  ws.on('close', () => {
    if (myId && players[myId]) {
      delete players[myId];
      throttledBroadcast();
    }
  });

  ws.on('error', () => {});
});
