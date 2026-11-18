'use strict';
/*
 * StreamHive server — zero dependencies (Node.js >= 18).
 *
 * - Serves the web app from /public
 * - JSON REST API under /api
 * - Server-Sent Events (/api/events) for chat, alerts and WebRTC signalling
 * - Data persisted to data/db.json
 *
 * Video travels peer-to-peer (WebRTC) from the streamer's browser to each viewer,
 * so no broadcasting software (OBS) and no media server are required.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const MAX_BODY = 300 * 1024;

const PLATFORM_FEE = 0.08; // 8 % commission (business model target: 8–10 %, below external donation services), includes payment processing
// Hive Pro: optional streamer subscription ("Streamer Premium" in the business model canvas).
const PRO = { price: 1999, fee: 0.06 };
const DONATION_MIN = 100; // cents
const DONATION_MAX = 50000; // cents
const SUB_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CLIENT_GRACE_MS = 10 * 1000;
const CHAT_HISTORY = 100;

const TIERS = {
  bronze: { id: 'bronze', name: 'Bronze', price: 299, perks: ['Supporter badge in chat', 'Name on the supporter wall'] },
  silver: { id: 'silver', name: 'Silver', price: 499, perks: ['Everything in Bronze', 'Highlighted chat messages'] },
  gold: { id: 'gold', name: 'Gold', price: 999, perks: ['Everything in Silver', 'Gold badge and top spot on the supporter wall'] },
};

const CATEGORIES = ['Just Chatting', 'Gaming', 'Music', 'Art & Creative', 'Cooking', 'Fitness', 'Education', 'Tech', 'Outdoors', 'Other'];

function iceServers() {
  const servers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL) {
    servers.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
  }
  return servers;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function fail(status, message) {
  throw new HttpError(status, message);
}
const now = () => Date.now();
const newId = (bytes = 8) => crypto.randomBytes(bytes).toString('hex');

function text(value, { name, min = 0, max }) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (s.length < min) fail(400, min <= 1 ? `${name} is required.` : `${name} must be at least ${min} characters.`);
  if (s.length > max) fail(400, `${name} must be at most ${max} characters.`);
  return s;
}

// ---------------------------------------------------------------------------
// Database (JSON file)
// ---------------------------------------------------------------------------
function emptyDb() {
  return { users: {}, sessions: {}, follows: [], payments: [], subscriptions: [], posts: [], streams: [], feedback: [] };
}
let db = emptyDb();

function loadDb() {
  let raw;
  try {
    raw = fs.readFileSync(DB_FILE, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  try {
    db = Object.assign(emptyDb(), JSON.parse(raw));
  } catch {
    const backup = DB_FILE.replace(/\.json$/, `.corrupt-${now()}.json`);
    fs.renameSync(DB_FILE, backup);
    console.error(`Database file was unreadable. It was moved to ${backup}; starting with an empty database.`);
  }
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flush();
  }, 250);
}
function flush() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

// ---------------------------------------------------------------------------
// Users & sessions
// ---------------------------------------------------------------------------
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function findUserByName(name) {
  const n = String(name || '').toLowerCase();
  return Object.values(db.users).find((u) => u.username === n) || null;
}
function colorFor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 70% 62%)`;
}
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, displayName: u.displayName, bio: u.bio || '', color: colorFor(u.username), createdAt: u.createdAt, pro: isPro(u) };
}
function createSession(userId) {
  const token = newId(32);
  db.sessions[token] = { userId, createdAt: now() };
  save();
  return token;
}
function userFromToken(token) {
  if (!token || typeof token !== 'string') return null;
  const s = db.sessions[token];
  if (!s) return null;
  if (now() - s.createdAt > SESSION_TTL_MS) {
    delete db.sessions[token];
    save();
    return null;
  }
  return db.users[s.userId] || null;
}
function tokenFromReq(req) {
  const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization || '');
  return m ? m[1] : null;
}
function getUser(req) {
  return userFromToken(tokenFromReq(req));
}
function requireUser(req) {
  const u = getUser(req);
  if (!u) fail(401, 'Please log in first.');
  return u;
}
function channelOrFail(username) {
  const u = findUserByName(username);
  if (!u) fail(404, 'Channel not found.');
  return u;
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
const buckets = new Map();
function limit(key, max, windowMs, message = 'Slow down a little and try again.') {
  const t = now();
  let b = buckets.get(key);
  if (!b || t - b.start > windowMs) {
    b = { start: t, count: 0, windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  if (b.count > max) fail(429, message);
}
setInterval(() => {
  const t = now();
  for (const [k, b] of buckets) if (t - b.start > b.windowMs) buckets.delete(k);
}, 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Payments (demo provider) & subscriptions
// ---------------------------------------------------------------------------
// All money is stored in euro cents. The "demo" provider records successful
// payments without moving real money. See README for connecting a real PSP.
function isPro(u) {
  const p = u && u.premium;
  return !!p && (p.status === 'active' || p.status === 'cancelled') && p.renewsAt > now();
}
function feeRate(userId) {
  return isPro(db.users[userId]) ? PRO.fee : PLATFORM_FEE;
}
function premiumView(u) {
  const p = u && u.premium;
  if (!p) return null;
  return { status: isPro(u) ? p.status : 'expired', startedAt: p.startedAt, renewsAt: p.renewsAt, price: PRO.price, active: isPro(u) };
}
function chargePremium(u, renewal = false) {
  const payment = {
    id: newId(8), type: 'premium', from: u.id, to: null, amount: PRO.price, fee: 0, net: 0, tier: null, message: '', renewal,
    currency: 'EUR', provider: 'demo', status: 'succeeded', createdAt: now(),
  };
  db.payments.push(payment);
  save();
  return payment;
}

function charge({ type, from, to, amount, tier = null, message = '', renewal = false, offline = false }) {
  const fee = Math.round(amount * feeRate(to));
  const payment = {
    id: newId(8), type, from, to, amount, fee, net: amount - fee, tier, message, renewal, offline,
    currency: 'EUR', provider: 'demo', status: 'succeeded', createdAt: now(),
  };
  db.payments.push(payment);
  save();
  return payment;
}

function isActive(s) {
  return (s.status === 'active' || s.status === 'cancelled') && s.renewsAt > now();
}
function findSub(subscriber, streamer) {
  return db.subscriptions.find((s) => s.subscriber === subscriber && s.streamer === streamer && s.status !== 'expired') || null;
}
function activeTier(subscriberId, streamerId) {
  if (!subscriberId) return null;
  const s = findSub(subscriberId, streamerId);
  return s && isActive(s) ? s.tier : null;
}
function subSummary(s) {
  const t = TIERS[s.tier];
  return {
    id: s.id, tier: s.tier, tierName: t.name, price: t.price,
    nextTier: s.nextTier || null, nextTierName: s.nextTier ? TIERS[s.nextTier].name : null,
    status: s.status, startedAt: s.startedAt, renewsAt: s.renewsAt, active: isActive(s),
  };
}
function processRenewals() {
  const t = now();
  let changed = false;
  for (const s of db.subscriptions) {
    if (s.status === 'expired' || s.renewsAt > t) continue;
    changed = true;
    if (s.status === 'cancelled' || !db.users[s.subscriber] || !db.users[s.streamer]) {
      s.status = 'expired';
      continue;
    }
    if (s.nextTier) {
      s.tier = s.nextTier;
      s.nextTier = null;
    }
    charge({ type: 'subscription', from: s.subscriber, to: s.streamer, amount: TIERS[s.tier].price, tier: s.tier, renewal: true });
    s.renewsAt += SUB_PERIOD_MS;
    if (s.renewsAt <= t) s.renewsAt = t + SUB_PERIOD_MS; // server was offline for a long time: start a fresh period
  }
  for (const u of Object.values(db.users)) {
    const p = u.premium;
    if (!p || p.status === 'expired' || p.renewsAt > t) continue;
    changed = true;
    if (p.status === 'cancelled') {
      p.status = 'expired';
      continue;
    }
    chargePremium(u, true);
    p.renewsAt += SUB_PERIOD_MS;
    if (p.renewsAt <= t) p.renewsAt = t + SUB_PERIOD_MS;
  }
  if (changed) save();
}
setInterval(processRenewals, 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Realtime: SSE clients, rooms, live streams
// ---------------------------------------------------------------------------
const clients = new Map(); // secret clientId -> client
const peers = new Map(); // public peerId -> secret clientId
const live = new Map(); // streamer userId -> live stream state
const chats = new Map(); // streamer userId -> recent chat messages

function send(client, event, data) {
  if (!client || client.closed || client.res.writableEnded || client.res.destroyed) return;
  client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function roomClients(streamerId) {
  return [...clients.values()].filter((c) => c.room === streamerId);
}
function broadcastRoom(streamerId, event, data) {
  for (const c of roomClients(streamerId)) send(c, event, data);
}
function viewerCount(streamerId) {
  const l = live.get(streamerId);
  if (!l) return 0;
  return roomClients(streamerId).filter((c) => c.id !== l.broadcasterClient).length;
}
function liveInfo(streamerId) {
  const l = live.get(streamerId);
  if (!l) return null;
  return {
    title: l.title, category: l.category, startedAt: l.startedAt, viewers: viewerCount(streamerId),
    thumbnail: l.thumbnail, streamer: publicUser(db.users[streamerId]),
  };
}
function pushViewerCount(streamerId) {
  const l = live.get(streamerId);
  if (!l) return;
  const count = viewerCount(streamerId);
  if (count > l.peak) l.peak = count;
  broadcastRoom(streamerId, 'viewers', { streamer: db.users[streamerId].username, viewers: count });
}

function joinRoom(client, streamerId) {
  if (client.room && client.room !== streamerId) leaveRoom(client);
  client.room = streamerId;
  const l = live.get(streamerId);
  if (l && l.broadcasterClient !== client.id) {
    send(clients.get(l.broadcasterClient), 'viewer-joined', { peerId: client.peerId });
  }
  pushViewerCount(streamerId);
}
function leaveRoom(client) {
  const room = client.room;
  if (!room) return;
  client.room = null;
  const l = live.get(room);
  if (l && l.broadcasterClient !== client.id) {
    send(clients.get(l.broadcasterClient), 'viewer-left', { peerId: client.peerId });
  }
  pushViewerCount(room);
}

function endStream(streamerId) {
  const l = live.get(streamerId);
  if (!l) return;
  live.delete(streamerId);
  db.streams.push({
    id: newId(8), streamer: streamerId, title: l.title, category: l.category,
    startedAt: l.startedAt, endedAt: now(), peakViewers: l.peak,
  });
  save();
  broadcastRoom(streamerId, 'offline', { streamer: db.users[streamerId] ? db.users[streamerId].username : null });
}

function removeClient(client) {
  if (clients.get(client.id) !== client) return;
  clients.delete(client.id);
  if (peers.get(client.peerId) === client.id) peers.delete(client.peerId);
  for (const [streamerId, l] of live) {
    if (l.broadcasterClient === client.id) endStream(streamerId);
  }
  leaveRoom(client);
}

function handleEvents(req, res, query) {
  const clientId = query.get('clientId') || '';
  if (!/^[a-f0-9]{32}$/.test(clientId)) return sendJson(res, 400, { error: 'Invalid client id.' });
  const user = userFromToken(query.get('token'));
  const userId = user ? user.id : null;
  const prev = clients.get(clientId);
  if (prev && prev.userId !== userId) return sendJson(res, 409, { error: 'Client id already in use.' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const client = { id: clientId, peerId: prev ? prev.peerId : newId(8), res, userId, room: prev ? prev.room : null, closed: false, graceTimer: null };
  if (prev) {
    clearTimeout(prev.graceTimer);
    prev.closed = true;
    try { prev.res.end(); } catch { /* already closed */ }
  }
  clients.set(clientId, client);
  peers.set(client.peerId, clientId);

  const broadcasting = [...live.values()].some((l) => l.broadcasterClient === clientId);
  send(client, 'hello', { peerId: client.peerId, room: client.room && db.users[client.room] ? db.users[client.room].username : null, broadcasting });

  const ping = setInterval(() => {
    if (!client.closed) res.write(': ping\n\n');
  }, 25 * 1000);

  res.on('close', () => {
    clearInterval(ping);
    if (clients.get(clientId) !== client) return; // replaced by a reconnect
    client.closed = true;
    client.graceTimer = setTimeout(() => removeClient(client), CLIENT_GRACE_MS);
  });
}

function clientOrFail(clientId) {
  const c = typeof clientId === 'string' ? clients.get(clientId) : null;
  if (!c) fail(400, 'Realtime connection not found. Please refresh the page.');
  return c;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      size += c.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        reject(new HttpError(413, 'Request body too large.'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return;
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

const routes = [];
function route(method, pattern, handler) {
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`);
  routes.push({ method, re, handler });
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
route('GET', '/config', () => ({
  iceServers: iceServers(),
  tiers: Object.values(TIERS),
  categories: CATEGORIES,
  platformFee: PLATFORM_FEE,
  donation: { min: DONATION_MIN, max: DONATION_MAX },
  paymentsMode: 'demo',
  pro: PRO,
}));

// --- Auth ---------------------------------------------------------------
route('POST', '/auth/register', ({ req, body }) => {
  limit(`auth:${req.socket.remoteAddress}`, 20, 10 * 60 * 1000, 'Too many attempts. Please wait a few minutes.');
  const username = String(body.username || '').trim().toLowerCase();
  if (!USERNAME_RE.test(username)) fail(400, 'Username must be 3–20 characters: letters, numbers or underscores.');
  if (findUserByName(username)) fail(409, 'That username is already taken.');
  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < 8) fail(400, 'Password must be at least 8 characters.');
  if (password.length > 200) fail(400, 'Password is too long.');
  const displayName = text(body.displayName || username, { name: 'Display name', min: 1, max: 30 });
  const salt = newId(16);
  const user = { id: newId(8), username, displayName, bio: '', salt, passHash: hashPassword(password, salt), createdAt: now() };
  db.users[user.id] = user;
  save();
  return { token: createSession(user.id), user: publicUser(user) };
});

route('POST', '/auth/login', ({ req, body }) => {
  limit(`auth:${req.socket.remoteAddress}`, 20, 10 * 60 * 1000, 'Too many attempts. Please wait a few minutes.');
  const user = findUserByName(body.username);
  const password = typeof body.password === 'string' ? body.password : '';
  const ok = user && checkPassword(user, password);
  if (!ok) fail(401, 'Wrong username or password.');
  return { token: createSession(user.id), user: publicUser(user) };
});

route('POST', '/auth/logout', ({ req }) => {
  const token = tokenFromReq(req);
  if (token && db.sessions[token]) {
    delete db.sessions[token];
    save();
  }
  return { ok: true };
});

route('GET', '/me', ({ req }) => ({ user: publicUser(getUser(req)) }));

route('PUT', '/me', ({ req, body }) => {
  const u = requireUser(req);
  u.displayName = text(body.displayName, { name: 'Display name', min: 1, max: 30 });
  u.bio = text(body.bio, { name: 'Bio', max: 300 });
  save();
  return { user: publicUser(u) };
});

function checkPassword(user, password) {
  const pw = typeof password === 'string' ? password : '';
  return crypto.timingSafeEqual(Buffer.from(hashPassword(pw, user.salt), 'hex'), Buffer.from(user.passHash, 'hex'));
}

route('DELETE', '/me', ({ req, body }) => {
  const me = requireUser(req);
  if (!checkPassword(me, body.password)) fail(403, 'Wrong password.');
  endStream(me.id);
  for (const c of clients.values()) if (c.room === me.id) c.room = null;
  for (const [token, s] of Object.entries(db.sessions)) if (s.userId === me.id) delete db.sessions[token];
  db.follows = db.follows.filter((f) => f.follower !== me.id && f.streamer !== me.id);
  db.posts = db.posts.filter((p) => p.author !== me.id && p.streamer !== me.id);
  for (const s of db.subscriptions) {
    if (s.subscriber === me.id || s.streamer === me.id) {
      s.status = 'expired';
      s.nextTier = null;
    }
  }
  for (const f of db.feedback) if (f.userId === me.id) f.userId = null;
  chats.delete(me.id);
  delete db.users[me.id];
  // Payment records are kept (without profile data) for accounting obligations.
  save();
  return { ok: true };
});

// --- Support, feedback, reports, advertising enquiries ------------------
const FEEDBACK_KINDS = ['support', 'feedback', 'report', 'advertise', 'school', 'other'];
route('POST', '/feedback', ({ req, body }) => {
  const me = getUser(req);
  const kind = FEEDBACK_KINDS.includes(body.kind) ? body.kind : 'feedback';
  const name = text(body.name, { name: 'Name', max: 80 });
  const subject = text(body.subject, { name: 'Subject', max: 120 });
  const email = text(body.email, { name: 'Email', max: 200 });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Please enter a valid email address.');
  if (!me && !email && kind !== 'report') fail(400, 'Please enter your email so we can reply.');
  const message = text(body.message, { name: 'Message', min: 10, max: 2000 });
  const channel = body.channel ? channelOrFail(body.channel).id : null;
  limit(`feedback:${req.socket.remoteAddress}`, 5, 10 * 60 * 1000, 'You sent several messages already. Please try again later.');
  const item = { id: newId(8), kind, userId: me ? me.id : null, name, subject, email, message, channel, createdAt: now() };
  db.feedback.push(item);
  save();
  return { ok: true, id: item.id };
});

// --- Browse -------------------------------------------------------------
route('GET', '/streams', ({ query }) => {
  const category = query.get('category');
  let list = [...live.keys()].map(liveInfo).filter(Boolean);
  if (category) list = list.filter((s) => s.category === category);
  list.sort((a, b) => b.viewers - a.viewers || b.startedAt - a.startedAt);
  return { streams: list };
});

route('GET', '/search', ({ query }) => {
  const q = String(query.get('q') || '').trim().toLowerCase();
  if (!q) return { channels: [] };
  const channels = Object.values(db.users)
    .filter((u) => u.username.includes(q) || u.displayName.toLowerCase().includes(q))
    .slice(0, 20)
    .map((u) => ({ user: publicUser(u), live: liveInfo(u.id) }));
  return { channels };
});

// Discover channels: live first, then most followed, then newest.
route('GET', '/channels', ({ req }) => {
  const me = getUser(req);
  const followerCount = new Map();
  for (const f of db.follows) followerCount.set(f.streamer, (followerCount.get(f.streamer) || 0) + 1);
  const followed = new Set(me ? db.follows.filter((f) => f.follower === me.id).map((f) => f.streamer) : []);
  const channels = Object.values(db.users)
    .filter((u) => !me || u.id !== me.id)
    .map((u) => ({ user: publicUser(u), live: liveInfo(u.id), followers: followerCount.get(u.id) || 0, following: followed.has(u.id) }))
    .sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0) || (b.user.pro ? 1 : 0) - (a.user.pro ? 1 : 0) || b.followers - a.followers || b.user.createdAt - a.user.createdAt)
    .slice(0, 24);
  return { channels };
});

route('GET', '/channels/:username', ({ req, params }) => {
  const ch = channelOrFail(params.username);
  const me = getUser(req);
  const sub = me ? findSub(me.id, ch.id) : null;
  const supporters = db.subscriptions
    .filter((s) => s.streamer === ch.id && isActive(s))
    .map((s) => ({ user: publicUser(db.users[s.subscriber]), tier: s.tier }))
    .filter((s) => s.user)
    .sort((a, b) => TIERS[b.tier].price - TIERS[a.tier].price);
  const posts = db.posts
    .filter((p) => p.streamer === ch.id)
    .slice(-50)
    .reverse()
    .map((p) => ({ id: p.id, text: p.text, createdAt: p.createdAt, author: publicUser(db.users[p.author]) }))
    .filter((p) => p.author);
  return {
    user: publicUser(ch),
    live: liveInfo(ch.id),
    followers: db.follows.filter((f) => f.streamer === ch.id).length,
    following: !!(me && db.follows.some((f) => f.follower === me.id && f.streamer === ch.id)),
    subscription: sub ? subSummary(sub) : null,
    supporters,
    posts,
    isOwner: !!(me && me.id === ch.id),
  };
});

// --- Follows ------------------------------------------------------------
route('POST', '/follows', ({ req, body }) => {
  const me = requireUser(req);
  const ch = channelOrFail(body.streamer);
  if (ch.id === me.id) fail(400, "You can't follow yourself.");
  if (!db.follows.some((f) => f.follower === me.id && f.streamer === ch.id)) {
    db.follows.push({ follower: me.id, streamer: ch.id, createdAt: now() });
    save();
  }
  return { following: true, followers: db.follows.filter((f) => f.streamer === ch.id).length };
});

route('DELETE', '/follows/:username', ({ req, params }) => {
  const me = requireUser(req);
  const ch = channelOrFail(params.username);
  db.follows = db.follows.filter((f) => !(f.follower === me.id && f.streamer === ch.id));
  save();
  return { following: false, followers: db.follows.filter((f) => f.streamer === ch.id).length };
});

route('GET', '/me/following', ({ req }) => {
  const me = requireUser(req);
  const channels = db.follows
    .filter((f) => f.follower === me.id && db.users[f.streamer])
    .map((f) => ({ user: publicUser(db.users[f.streamer]), live: liveInfo(f.streamer) }))
    .sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0) || a.user.displayName.localeCompare(b.user.displayName));
  return { channels };
});

// --- Realtime rooms & signalling ----------------------------------------
route('POST', '/rooms/join', ({ body }) => {
  const client = clientOrFail(body.clientId);
  const ch = channelOrFail(body.streamer);
  joinRoom(client, ch.id);
  return { live: liveInfo(ch.id), chat: chats.get(ch.id) || [], viewers: viewerCount(ch.id) };
});

route('POST', '/rooms/leave', ({ body }) => {
  const client = clients.get(body.clientId);
  if (client) leaveRoom(client);
  return { ok: true };
});

function isBroadcastPair(b, v) {
  if (!b.userId) return false;
  const l = live.get(b.userId);
  return !!l && l.broadcasterClient === b.id && v.room === b.userId && v.id !== b.id;
}

route('POST', '/signal', ({ body }) => {
  const sender = clientOrFail(body.clientId);
  const targetId = peers.get(String(body.to || ''));
  const target = targetId ? clients.get(targetId) : null;
  if (!target) fail(404, 'Peer not found.');
  if (!isBroadcastPair(sender, target) && !isBroadcastPair(target, sender)) fail(403, 'Not allowed.');
  const data = body.data;
  if (!data || typeof data !== 'object' || !['offer', 'answer', 'candidate'].includes(data.type)) fail(400, 'Invalid signal.');
  send(target, 'signal', { from: sender.peerId, data });
  return { ok: true };
});

// --- Going live ---------------------------------------------------------
route('POST', '/streams/start', ({ req, body }) => {
  const me = requireUser(req);
  const client = clientOrFail(body.clientId);
  if (client.userId !== me.id) fail(403, 'Please refresh the page and try again.');
  const title = text(body.title, { name: 'Title', min: 1, max: 100 });
  const category = CATEGORIES.includes(body.category) ? body.category : 'Other';

  const existing = live.get(me.id);
  if (existing && existing.broadcasterClient !== client.id) {
    const old = clients.get(existing.broadcasterClient);
    if (old) {
      send(old, 'broadcast-replaced', {});
      old.room = null;
    }
  }
  live.set(me.id, {
    title, category, broadcasterClient: client.id,
    startedAt: existing ? existing.startedAt : now(),
    thumbnail: existing ? existing.thumbnail : null,
    peak: existing ? existing.peak : 0,
  });
  joinRoom(client, me.id);
  for (const c of roomClients(me.id)) {
    if (c.id !== client.id) send(client, 'viewer-joined', { peerId: c.peerId });
  }
  const info = liveInfo(me.id);
  broadcastRoom(me.id, 'live', info);

  let offlineSupport = null;
  if (!existing) {
    const lastEnd = db.streams.filter((x) => x.streamer === me.id).reduce((m, x) => Math.max(m, x.endedAt), 0);
    const away = db.payments.filter((p) => p.to === me.id && p.type === 'donation' && p.offline && p.createdAt > lastEnd);
    if (away.length) {
      offlineSupport = { count: away.length, gross: away.reduce((a, p) => a + p.amount, 0), net: away.reduce((a, p) => a + p.net, 0) };
      // Show the latest ones in chat so the streamer can thank them on stream.
      const history = chats.get(me.id) || [];
      for (const p of away.slice(-5)) {
        const donor = db.users[p.from];
        if (!donor || history.some((m) => m.id === p.id)) continue; // already in the chat history
        pushChat(me.id, { id: `off_${p.id}`, kind: 'donation', offline: true, user: chatAuthor(donor, me.id), amount: p.amount, text: p.message, at: p.createdAt });
      }
    }
    const followerIds = new Set(db.follows.filter((f) => f.streamer === me.id).map((f) => f.follower));
    for (const c of clients.values()) {
      if (c.userId && followerIds.has(c.userId) && c.room !== me.id) {
        send(c, 'notify', { kind: 'live', streamer: publicUser(me), title });
      }
    }
  }
  return { live: info, offlineSupport };
});

route('POST', '/streams/update', ({ req, body }) => {
  const me = requireUser(req);
  const l = live.get(me.id);
  if (!l) fail(400, 'You are not live.');
  l.title = text(body.title, { name: 'Title', min: 1, max: 100 });
  if (CATEGORIES.includes(body.category)) l.category = body.category;
  const info = liveInfo(me.id);
  broadcastRoom(me.id, 'live', info);
  return { live: info };
});

route('POST', '/streams/thumbnail', ({ req, body }) => {
  const me = requireUser(req);
  const l = live.get(me.id);
  if (!l) fail(400, 'You are not live.');
  const image = typeof body.image === 'string' ? body.image : '';
  if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image) || image.length > 200 * 1024) fail(400, 'Invalid thumbnail.');
  l.thumbnail = image;
  return { ok: true };
});

route('POST', '/streams/stop', ({ req }) => {
  const me = requireUser(req);
  endStream(me.id);
  return { ok: true };
});

// --- Chat ---------------------------------------------------------------
function pushChat(streamerId, message) {
  const list = chats.get(streamerId) || [];
  list.push(message);
  if (list.length > CHAT_HISTORY) list.splice(0, list.length - CHAT_HISTORY);
  chats.set(streamerId, list);
  broadcastRoom(streamerId, 'chat', { streamer: db.users[streamerId].username, message });
}
function chatAuthor(user, streamerId) {
  return { ...publicUser(user), tier: activeTier(user.id, streamerId), isStreamer: user.id === streamerId };
}

route('POST', '/chat', ({ req, body }) => {
  const me = requireUser(req);
  const ch = channelOrFail(body.streamer);
  limit(`chat:${me.id}`, 5, 5000, 'You are sending messages too quickly.');
  const msg = text(body.text, { name: 'Message', min: 1, max: 300 });
  pushChat(ch.id, { id: newId(6), kind: 'chat', user: chatAuthor(me, ch.id), text: msg, at: now() });
  return { ok: true };
});

// --- Donations ----------------------------------------------------------
route('POST', '/donations', ({ req, body }) => {
  const me = requireUser(req);
  const ch = channelOrFail(body.streamer);
  if (ch.id === me.id) fail(400, "You can't donate to yourself.");
  limit(`pay:${me.id}`, 10, 60 * 1000);
  const amount = Number(body.amount);
  if (!Number.isInteger(amount) || amount < DONATION_MIN || amount > DONATION_MAX) {
    fail(400, `Donations must be between €${(DONATION_MIN / 100).toFixed(2)} and €${(DONATION_MAX / 100).toFixed(2)}.`);
  }
  const message = text(body.message, { name: 'Message', max: 200 });
  const offline = !live.has(ch.id);
  const payment = charge({ type: 'donation', from: me.id, to: ch.id, amount, message, offline });
  const event = { id: payment.id, kind: 'donation', offline, user: chatAuthor(me, ch.id), amount, text: message, at: payment.createdAt };
  pushChat(ch.id, event);
  broadcastRoom(ch.id, 'alert', { streamer: ch.username, alert: event });
  return { payment };
});

// --- Subscriptions ------------------------------------------------------
route('POST', '/subscriptions', ({ req, body }) => {
  const me = requireUser(req);
  const ch = channelOrFail(body.streamer);
  if (ch.id === me.id) fail(400, "You can't subscribe to yourself.");
  const tier = TIERS[body.tier] ? body.tier : null;
  if (!tier) fail(400, 'Please choose a tier.');
  limit(`pay:${me.id}`, 10, 60 * 1000);

  const existing = findSub(me.id, ch.id);
  if (existing && isActive(existing)) {
    // Already paid for this period: resume and/or schedule a tier change for the next renewal. No extra charge.
    existing.status = 'active';
    existing.nextTier = tier === existing.tier ? null : tier;
    save();
    return { subscription: subSummary(existing), charged: null };
  }
  if (existing) existing.status = 'expired';
  const sub = { id: newId(8), subscriber: me.id, streamer: ch.id, tier, nextTier: null, status: 'active', startedAt: now(), renewsAt: now() + SUB_PERIOD_MS };
  db.subscriptions.push(sub);
  const payment = charge({ type: 'subscription', from: me.id, to: ch.id, amount: TIERS[tier].price, tier });
  const event = { id: payment.id, kind: 'subscription', user: chatAuthor(me, ch.id), tier, at: payment.createdAt };
  pushChat(ch.id, event);
  broadcastRoom(ch.id, 'alert', { streamer: ch.username, alert: event });
  return { subscription: subSummary(sub), charged: payment };
});

route('DELETE', '/subscriptions/:username', ({ req, params }) => {
  const me = requireUser(req);
  const ch = channelOrFail(params.username);
  const sub = findSub(me.id, ch.id);
  if (!sub || !isActive(sub)) fail(404, 'You have no active subscription to this channel.');
  sub.status = 'cancelled';
  sub.nextTier = null;
  save();
  return { subscription: subSummary(sub) };
});

// --- Community posts ----------------------------------------------------
route('POST', '/posts', ({ req, body }) => {
  const me = requireUser(req);
  const ch = channelOrFail(body.streamer);
  limit(`post:${me.id}`, 5, 60 * 1000, 'You are posting too quickly.');
  const post = { id: newId(8), streamer: ch.id, author: me.id, text: text(body.text, { name: 'Post', min: 1, max: 500 }), createdAt: now() };
  db.posts.push(post);
  save();
  return { post: { id: post.id, text: post.text, createdAt: post.createdAt, author: publicUser(me) } };
});

route('DELETE', '/posts/:id', ({ req, params }) => {
  const me = requireUser(req);
  const post = db.posts.find((p) => p.id === params.id);
  if (!post) fail(404, 'Post not found.');
  if (post.author !== me.id && post.streamer !== me.id) fail(403, 'You can only delete your own posts or posts on your channel.');
  db.posts = db.posts.filter((p) => p.id !== post.id);
  save();
  return { ok: true };
});

// --- Dashboards ---------------------------------------------------------
function paymentView(p, otherId) {
  return {
    id: p.id, type: p.type, amount: p.amount, fee: p.fee, net: p.net, tier: p.tier, message: p.message,
    renewal: !!p.renewal, offline: !!p.offline, createdAt: p.createdAt, user: publicUser(db.users[otherId]),
  };
}

// Advanced analytics (shown to Hive Pro streamers).
function proAnalytics(received) {
  const donations = received.filter((p) => p.type === 'donation');
  const byDay = [0, 0, 0, 0, 0, 0, 0];
  for (const p of received) byDay[new Date(p.createdAt).getDay()] += p.net;
  const best = byDay.indexOf(Math.max(...byDay));
  return {
    averageDonation: donations.length ? Math.round(donations.reduce((a, p) => a + p.amount, 0) / donations.length) : 0,
    donationCount: donations.length,
    uniqueSupporters: new Set(received.map((p) => p.from)).size,
    bestDay: received.length ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][best] : null,
    byDay,
  };
}

// --- Hive Pro (streamer subscription) -----------------------------------
route('GET', '/premium', ({ req }) => {
  const me = getUser(req);
  return {
    price: PRO.price,
    fee: PRO.fee,
    standardFee: PLATFORM_FEE,
    premium: me ? premiumView(me) : null,
    payments: me ? db.payments.filter((p) => p.type === 'premium' && p.from === me.id).slice(-12).reverse() : [],
  };
});

route('POST', '/premium', ({ req }) => {
  const me = requireUser(req);
  limit(`pay:${me.id}`, 10, 60 * 1000);
  if (isPro(me)) {
    // Already paid for this month: resume if it was cancelled, no new charge.
    me.premium.status = 'active';
    save();
    return { user: publicUser(me), premium: premiumView(me), charged: null };
  }
  me.premium = { status: 'active', startedAt: now(), renewsAt: now() + SUB_PERIOD_MS };
  const payment = chargePremium(me);
  return { user: publicUser(me), premium: premiumView(me), charged: payment };
});

route('DELETE', '/premium', ({ req }) => {
  const me = requireUser(req);
  if (!isPro(me)) fail(404, 'You are not on Hive Pro.');
  me.premium.status = 'cancelled';
  save();
  return { user: publicUser(me), premium: premiumView(me) };
});

route('GET', '/me/dashboard', ({ req }) => {
  const me = requireUser(req);
  const received = db.payments.filter((p) => p.to === me.id);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const sum = (list, key) => list.reduce((acc, p) => acc + p[key], 0);
  const activeSubs = db.subscriptions.filter((s) => s.streamer === me.id && isActive(s));
  const recurring = activeSubs
    .filter((s) => s.status === 'active')
    .reduce((acc, s) => {
      const price = TIERS[s.nextTier || s.tier].price;
      return acc + price - Math.round(price * feeRate(me.id));
    }, 0);
  const byUser = new Map();
  for (const p of received) byUser.set(p.from, (byUser.get(p.from) || 0) + p.amount);
  const topSupporters = [...byUser.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([uid, total]) => ({ user: publicUser(db.users[uid]), total, tier: activeTier(uid, me.id) }))
    .filter((s) => s.user);
  return {
    live: liveInfo(me.id),
    totals: {
      gross: sum(received, 'amount'),
      fees: sum(received, 'fee'),
      net: sum(received, 'net'),
      donationsNet: sum(received.filter((p) => p.type === 'donation'), 'net'),
      subscriptionsNet: sum(received.filter((p) => p.type === 'subscription'), 'net'),
      thisMonthNet: sum(received.filter((p) => p.createdAt >= monthStart.getTime()), 'net'),
      expectedMonthlyNet: recurring,
      activeSubscribers: activeSubs.length,
      followers: db.follows.filter((f) => f.streamer === me.id).length,
    },
    recent: received.slice(-25).reverse().map((p) => paymentView(p, p.from)),
    topSupporters,
    streams: db.streams.filter((s) => s.streamer === me.id).slice(-10).reverse(),
    premium: premiumView(me),
    feeRate: feeRate(me.id),
    analytics: proAnalytics(received),
  };
});

route('GET', '/me/support', ({ req }) => {
  const me = requireUser(req);
  const subs = db.subscriptions
    .filter((s) => s.subscriber === me.id && s.status !== 'expired' && db.users[s.streamer])
    .map((s) => ({ ...subSummary(s), streamer: publicUser(db.users[s.streamer]) }));
  const given = db.payments.filter((p) => p.from === me.id && p.type !== 'premium');
  return {
    subscriptions: subs,
    payments: given.slice(-50).reverse().map((p) => paymentView(p, p.to)),
    totals: {
      given: given.reduce((a, p) => a + p.amount, 0),
      monthly: subs.filter((s) => s.status === 'active').reduce((a, s) => a + TIERS[s.nextTier || s.tier].price, 0),
    },
  };
});

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function serveFile(res, file, head) {
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  if (head) return res.end();
  fs.createReadStream(file).pipe(res);
}

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  const head = req.method === 'HEAD';
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(404);
    return res.end('Not found');
  }
  fs.stat(file, (err, st) => {
    if (!err && st.isFile()) return serveFile(res, file, head);
    if (path.extname(rel)) {
      res.writeHead(404);
      return res.end('Not found');
    }
    serveFile(res, path.join(PUBLIC_DIR, 'index.html'), head);
  });
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------
function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
}

async function handle(req, res) {
  securityHeaders(res);
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  if (pathname === '/api/events' && req.method === 'GET') return handleEvents(req, res, url.searchParams);

  if (pathname.startsWith('/api/')) {
    try {
      const sub = pathname.slice(4);
      let match = null;
      let found = null;
      for (const r of routes) {
        if (r.method !== req.method) continue;
        match = r.re.exec(sub);
        if (match) {
          found = r;
          break;
        }
      }
      if (!found) fail(404, 'Not found.');
      const params = {};
      for (const [k, v] of Object.entries(match.groups || {})) params[k] = decodeURIComponent(v);
      const body = req.method === 'GET' ? {} : await readBody(req);
      processRenewals();
      const result = await found.handler({ req, res, params, query: url.searchParams, body });
      sendJson(res, 200, result === undefined ? { ok: true } : result);
    } catch (e) {
      if (e instanceof HttpError) sendJson(res, e.status, { error: e.message });
      else if (e instanceof URIError) sendJson(res, 400, { error: 'Bad request.' });
      else {
        console.error(e);
        sendJson(res, 500, { error: 'Something went wrong on our side.' });
      }
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end('Method not allowed');
  }
  serveStatic(req, res, pathname);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
loadDb();
processRenewals();

const useHttps = process.env.SSL_KEY && process.env.SSL_CERT;
const server = useHttps
  ? https.createServer({ key: fs.readFileSync(process.env.SSL_KEY), cert: fs.readFileSync(process.env.SSL_CERT) }, handle)
  : http.createServer(handle);

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — StreamHive is probably already running. Open http://localhost:${PORT}, or start on another port with PORT=3001 npm start.`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  const proto = useHttps ? 'https' : 'http';
  console.log(`StreamHive is running at ${proto}://localhost:${PORT}`);
});

function shutdown() {
  try {
    if (saveTimer) clearTimeout(saveTimer);
    flush();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { server };
