const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log('Server running on port ' + PORT));

const wss = new WebSocketServer({ server });

const GAME_DURATION = 2 * 60 * 60 * 1000; // 2h
const COOLDOWN      = 24 * 60 * 60 * 1000; // 24h
const MAMADOU_BASE_CPS = 2.0;   // lent au début (facile à battre)
const BOOST_START   = 20 * 60 * 1000; // boost commence 20min avant la fin
const FINAL_LOCK    = 2 * 60 * 1000;  // imbattable dans les 2 dernières minutes

let players = {};
let session = { state: 'idle', startTime: null, endTime: null };
let mamadouInterval = null;
let broadcastThrottle = null;

function getMamadouCPS() {
  if (session.state !== 'playing') return MAMADOU_BASE_CPS;
  const now = Date.now();
  const remaining = session.endTime - now;

  if (remaining <= FINAL_LOCK) {
    // 2 dernières minutes : Mamadou clique à vitesse FOLLE, impossible à battre
    // On calcule le max de tous les joueurs et on reste toujours au-dessus
    const topHuman = getTopHumanScore();
    const cpsNeeded = (topHuman + 5000) / ((remaining / 1000) || 1);
    return Math.max(50, cpsNeeded); // minimum 50 clics/sec
  }

  if (remaining <= BOOST_START) {
    // Dans les 20 dernières minutes : accélération progressive
    const boostProgress = 1 - (remaining / BOOST_START); // 0 → 1
    return MAMADOU_BASE_CPS + (boostProgress * boostProgress * 40);
  }

  return MAMADOU_BASE_CPS;
}

function getTopHumanScore() {
  let max = 0;
  Object.entries(players).forEach(([id, p]) => {
    if (id !== 'MAMADOU' && p.score > max) max = p.score;
  });
  return max;
}

function updateMamadouScore() {
  if (session.state !== 'playing') return;
  const now = Date.now();
  const remaining = session.endTime - now;
  const elapsed = (now - session.startTime) / 1000;

  if (remaining <= FINAL_LOCK) {
    // IMBATTABLE : toujours au-dessus du meilleur humain
    const topHuman = getTopHumanScore();
    players['MAMADOU'].score = topHuman + Math.floor((FINAL_LOCK - remaining) / 1000 * 60) + 500;
  } else {
    const cps = getMamadouCPS();
    players['MAMADOU'].score = Math.floor(elapsed * cps);
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
      mamadouBoosting: session.endTime && remaining <= BOOST_START,
      mamadouUnstoppable: session.endTime && remaining <= FINAL_LOCK
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

  // Envoie l'état actuel immédiatement
  const now = Date.now();
  const remaining = session.endTime ? Math.max(0, session.endTime - now) : 0;
  ws.send(JSON.stringify({
    type: 'state',
    session,
    leaderboard: getTop10(),
    total: Object.keys(players).filter(k => k !== 'MAMADOU').length,
    mamadouBoosting: session.endTime && remaining <= BOOST_START,
    mamadouUnstoppable: session.endTime && remaining <= FINAL_LOCK
  }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'join') {
      // ✅ ON ACCEPTE TOUT LE MONDE même si la partie est en cours
      if (session.state === 'ended') {
        ws.send(JSON.stringify({ type: 'error', reason: 'ended', session, leaderboard: getTop10() }));
        return;
      }

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
      // Si session.state === 'playing' → on laisse rejoindre directement

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
