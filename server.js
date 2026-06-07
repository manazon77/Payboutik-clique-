const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log('Server running on port ' + PORT));

const wss = new WebSocketServer({ server });

const GAME_DURATION    = 2 * 60 * 60 * 1000;
const COOLDOWN         = 24 * 60 * 60 * 1000;
const MAMADOU_BASE_CPS = 2.0;
const BOOST_START      = 20 * 60 * 1000;
const FINAL_LOCK       = 2 * 60 * 1000;

let players = {};
let session = { state: 'idle', startTime: null, endTime: null };
let mamadouInterval = null;
let broadcastThrottle = null;

function getTopHumanScore() {
  let max = 0;
  Object.entries(players).forEach(([id, p]) => {
    if (id !== 'MAMADOU' && (p.score || 0) > max) max = p.score;
  });
  return max;
}

function updateMamadouScore() {
  if (session.state !== 'playing') return;
  const now = Date.now();
  const remaining = session.endTime - now;
  const elapsed = (now - session.startTime) / 1000;

  if (remaining <= FINAL_LOCK) {
    // IMBATTABLE : toujours 500+ au-dessus du meilleur humain
    const topHuman = getTopHumanScore();
    const extra = Math.floor((FINAL_LOCK - remaining) / 1000 * 60);
    players['MAMADOU'].score = topHuman + 500 + extra;
  } else if (remaining <= BOOST_START) {
    // Accélération progressive sur 20 min
    const boostProgress = 1 - (remaining / BOOST_START);
    const cps = MAMADOU_BASE_CPS + (boostProgress * boostProgress * 40);
    players['MAMADOU'].score = Math.floor(elapsed * cps);
  } else {
    // Début de partie : lent, facile à battre
    players['MAMADOU'].score = Math.floor(elapsed * MAMADOU_BASE_CPS);
  }
}

function startMamadou() {
  if (mamadouInterval) return;
  mamadouInterval = setInterval(() => {
    if (session.state !== 'playing') {
      clearInterval(mamadouInterval);
      mamadouInterval = null;
      return;
    }
    updateMamadouScore();
    throttledBroadcast();
  }, 2000);
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
    const now = Date.now();
    const remaining = session.endTime ? Math.max(0, session.endTime - now) : 0;
    const msg = JSON.stringify({
      type: 'leaderboard',
      players: getTop10(),
      total: Object.keys(players).filter(k => k !== 'MAMADOU').length,
      mamadouBoosting: !!(session.endTime && remaining <= BOOST_START),
      mamadouUnstoppable: !!(session.endTime && remaining <= FINAL_LOCK)
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

setInterval(checkGameEnd, 5000);

wss.on('connection', (ws) => {
  let myId = null;

  const now = Date.now();
  const remaining = session.endTime ? Math.max(0, session.endTime - now) : 0;
  ws.send(JSON.stringify({
    type: 'state',
    session,
    leaderboard: getTop10(),
    total: Object.keys(players).filter(k => k !== 'MAMADOU').length,
    mamadouBoosting: !!(session.endTime && remaining <= BOOST_START),
    mamadouUnstoppable: !!(session.endTime && remaining <= FINAL_LOCK)
  }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'join') {

      // ✅ Seul cas de blocage : partie TERMINÉE (cooldown 24h)
      if (session.state === 'ended') {
        ws.send(JSON.stringify({
          type: 'error',
          reason: 'ended',
          session,
          leaderboard: getTop10()
        }));
        return;
      }

      // ✅ Partie en cours OU idle → on accepte tout le monde
      myId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      const name = String(msg.name || 'Anonyme').slice(0, 20).replace(/[<>]/g, '');
      players[myId] = { name, score: 0 };

      if (session.state === 'idle') {
        // Première personne → démarre la session
        session.state = 'playing';
        session.startTime = Date.now();
        session.endTime = session.startTime + GAME_DURATION;
        players['MAMADOU'] = { name: 'Mamadou 👑', score: 0, isMamadou: true };
        startMamadou();
      }
      // Si 'playing' → rejoint directement sans bloquer

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
