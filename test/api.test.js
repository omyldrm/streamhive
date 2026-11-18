'use strict';
// End-to-end API test: starts the real server on a random port with a temporary database.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = 3900 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhive-test-'));
let server;

async function call(method, url, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

// Minimal SSE client that collects events.
function openEvents(token) {
  const clientId = crypto.randomBytes(16).toString('hex');
  const controller = new AbortController();
  const events = [];
  const waiters = [];
  const q = new URLSearchParams({ clientId });
  if (token) q.set('token', token);
  const ready = fetch(`${BASE}/api/events?${q}`, { signal: controller.signal }).then(async (res) => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = /^event: (.+)$/m.exec(block);
            const data = /^data: (.+)$/m.exec(block);
            if (ev && data) {
              const e = { event: ev[1], data: JSON.parse(data[1]) };
              events.push(e);
              for (const w of [...waiters]) {
                if (w.match(e)) {
                  waiters.splice(waiters.indexOf(w), 1);
                  w.resolve(e);
                }
              }
            }
          }
        }
      } catch { /* aborted */ }
    })();
  });
  return {
    clientId,
    events,
    ready,
    waitFor(event, pred = () => true, ms = 3000) {
      const found = events.find((e) => e.event === event && pred(e.data));
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const w = { match: (e) => e.event === event && pred(e.data), resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
      });
    },
    close: () => controller.abort(),
  };
}

before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { if (String(d).includes('running')) resolve(); });
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
});

after(() => {
  server.kill();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('full streamer / viewer flow', async () => {
  // static files
  const page = await fetch(`${BASE}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /StreamHive/);
  assert.equal((await fetch(`${BASE}/app.js`)).status, 200);
  assert.equal((await fetch(`${BASE}/%2e%2e/server.js`)).status, 404);

  // config
  const cfg = await call('GET', '/api/config');
  assert.equal(cfg.status, 200);
  assert.equal(cfg.data.tiers.length, 3);

  // register validation
  assert.equal((await call('POST', '/api/auth/register', { body: { username: 'a', password: 'longenough' } })).status, 400);
  assert.equal((await call('POST', '/api/auth/register', { body: { username: 'alice', password: 'short' } })).status, 400);

  const alice = (await call('POST', '/api/auth/register', { body: { username: 'Alice', password: 'password123', displayName: 'Alice A' } })).data;
  assert.equal(alice.user.username, 'alice');
  const bob = (await call('POST', '/api/auth/register', { body: { username: 'bob', password: 'password123' } })).data;
  assert.equal((await call('POST', '/api/auth/register', { body: { username: 'bob', password: 'password123' } })).status, 409);

  // login
  assert.equal((await call('POST', '/api/auth/login', { body: { username: 'bob', password: 'wrongpass' } })).status, 401);
  const bobLogin = await call('POST', '/api/auth/login', { body: { username: 'BOB', password: 'password123' } });
  assert.equal(bobLogin.status, 200);
  assert.equal((await call('GET', '/api/me', { token: bob.token })).data.user.username, 'bob');

  // auth required
  assert.equal((await call('POST', '/api/chat', { body: { streamer: 'alice', text: 'hi' } })).status, 401);

  // follow
  const f = await call('POST', '/api/follows', { token: bob.token, body: { streamer: 'alice' } });
  assert.equal(f.data.followers, 1);
  assert.equal((await call('POST', '/api/follows', { token: alice.token, body: { streamer: 'alice' } })).status, 400);

  // realtime: alice (streamer) and bob (viewer) connect
  const aEv = openEvents(alice.token);
  const bEv = openEvents(bob.token);
  await aEv.ready;
  await bEv.ready;
  const aHello = await aEv.waitFor('hello');
  const bHello = await bEv.waitFor('hello');

  // bob joins alice's room before she is live
  const join = await call('POST', '/api/rooms/join', { body: { clientId: bEv.clientId, streamer: 'alice' } });
  assert.equal(join.status, 200);
  assert.equal(join.data.live, null);

  // alice cannot start with someone else's client id
  assert.equal((await call('POST', '/api/streams/start', { token: alice.token, body: { clientId: bEv.clientId, title: 'x' } })).status, 403);

  // alice goes live -> she is told about bob, bob gets 'live'
  const start = await call('POST', '/api/streams/start', { token: alice.token, body: { clientId: aEv.clientId, title: 'My first stream', category: 'Gaming' } });
  assert.equal(start.status, 200);
  assert.equal(start.data.live.title, 'My first stream');
  assert.equal(start.data.live.viewers, 1);
  const vj = await aEv.waitFor('viewer-joined');
  assert.equal(vj.data.peerId, bHello.data.peerId);
  await bEv.waitFor('live', (d) => d.title === 'My first stream');

  const streams = await call('GET', '/api/streams');
  assert.equal(streams.data.streams.length, 1);
  assert.equal((await call('GET', '/api/streams?category=Music')).data.streams.length, 0);

  // signalling: alice -> bob offer, bob -> alice answer
  const off = await call('POST', '/api/signal', { body: { clientId: aEv.clientId, to: bHello.data.peerId, data: { type: 'offer', sdp: 'v=0' } } });
  assert.equal(off.status, 200);
  const sig = await bEv.waitFor('signal', (d) => d.data.type === 'offer');
  assert.equal(sig.data.from, aHello.data.peerId);
  assert.equal((await call('POST', '/api/signal', { body: { clientId: bEv.clientId, to: aHello.data.peerId, data: { type: 'answer', sdp: 'v=0' } } })).status, 200);
  await aEv.waitFor('signal', (d) => d.data.type === 'answer');
  // signals between two non-broadcast clients are refused
  const carol = (await call('POST', '/api/auth/register', { body: { username: 'carol', password: 'password123' } })).data;
  const cEv = openEvents(carol.token);
  await cEv.ready;
  const cHello = await cEv.waitFor('hello');
  assert.equal((await call('POST', '/api/signal', { body: { clientId: bEv.clientId, to: cHello.data.peerId, data: { type: 'offer', sdp: 'x' } } })).status, 403);

  // chat
  assert.equal((await call('POST', '/api/chat', { token: bob.token, body: { streamer: 'alice', text: '   ' } })).status, 400);
  assert.equal((await call('POST', '/api/chat', { token: bob.token, body: { streamer: 'alice', text: 'Hello <b>alice</b>' } })).status, 200);
  const chatMsg = await aEv.waitFor('chat', (d) => d.message.kind === 'chat');
  assert.equal(chatMsg.data.message.text, 'Hello <b>alice</b>');
  assert.equal(chatMsg.data.message.user.tier, null);

  // donation with transparent fee
  assert.equal((await call('POST', '/api/donations', { token: bob.token, body: { streamer: 'alice', amount: 50 } })).status, 400);
  assert.equal((await call('POST', '/api/donations', { token: bob.token, body: { streamer: 'alice', amount: 2.5 } })).status, 400);
  assert.equal((await call('POST', '/api/donations', { token: alice.token, body: { streamer: 'alice', amount: 500 } })).status, 400);
  const don = await call('POST', '/api/donations', { token: bob.token, body: { streamer: 'alice', amount: 500, message: 'Great stream!' } });
  assert.equal(don.status, 200);
  assert.equal(don.data.payment.fee, 40); // 8 %
  assert.equal(don.data.payment.net, 460);
  const alert = await aEv.waitFor('alert', (d) => d.alert.kind === 'donation');
  assert.equal(alert.data.alert.amount, 500);

  // subscription
  const sub = await call('POST', '/api/subscriptions', { token: bob.token, body: { streamer: 'alice', tier: 'silver' } });
  assert.equal(sub.status, 200);
  assert.equal(sub.data.charged.amount, 499);
  assert.equal(sub.data.subscription.active, true);
  // same tier again: no extra charge
  const again = await call('POST', '/api/subscriptions', { token: bob.token, body: { streamer: 'alice', tier: 'silver' } });
  assert.equal(again.data.charged, null);
  // upgrade scheduled for next renewal, no charge now
  const up = await call('POST', '/api/subscriptions', { token: bob.token, body: { streamer: 'alice', tier: 'gold' } });
  assert.equal(up.data.charged, null);
  assert.equal(up.data.subscription.nextTier, 'gold');
  // chat badge now shows tier
  await call('POST', '/api/chat', { token: bob.token, body: { streamer: 'alice', text: 'now a supporter' } });
  const badged = await aEv.waitFor('chat', (d) => d.message.text === 'now a supporter');
  assert.equal(badged.data.message.user.tier, 'silver');
  // cancel keeps access until period end
  const cancel = await call('DELETE', '/api/subscriptions/alice', { token: bob.token });
  assert.equal(cancel.data.subscription.status, 'cancelled');
  assert.equal(cancel.data.subscription.active, true);
  assert.equal(cancel.data.subscription.nextTier, null);
  // resume without charge
  const resume = await call('POST', '/api/subscriptions', { token: bob.token, body: { streamer: 'alice', tier: 'silver' } });
  assert.equal(resume.data.charged, null);
  assert.equal(resume.data.subscription.status, 'active');

  // channel view
  const ch = await call('GET', '/api/channels/alice', { token: bob.token });
  assert.equal(ch.data.following, true);
  assert.equal(ch.data.subscription.tier, 'silver');
  assert.equal(ch.data.supporters.length, 1);
  assert.ok(ch.data.live);

  // community posts
  const post = await call('POST', '/api/posts', { token: bob.token, body: { streamer: 'alice', text: 'See you tomorrow!' } });
  assert.equal(post.status, 200);
  assert.equal((await call('DELETE', `/api/posts/${post.data.post.id}`, { token: carol.token })).status, 403);
  assert.equal((await call('DELETE', `/api/posts/${post.data.post.id}`, { token: alice.token })).status, 200);

  // dashboards
  const dash = await call('GET', '/api/me/dashboard', { token: alice.token });
  assert.equal(dash.data.totals.gross, 999);
  assert.equal(dash.data.totals.net, 460 + 459);
  assert.equal(dash.data.totals.activeSubscribers, 1);
  assert.equal(dash.data.totals.expectedMonthlyNet, 459);
  assert.equal(dash.data.topSupporters[0].user.username, 'bob');
  const support = await call('GET', '/api/me/support', { token: bob.token });
  assert.equal(support.data.totals.given, 999);
  assert.equal(support.data.totals.monthly, 499);
  assert.equal(support.data.payments.length, 2);

  // following list shows alice live
  const following = await call('GET', '/api/me/following', { token: bob.token });
  assert.ok(following.data.channels[0].live);

  // thumbnails
  assert.equal((await call('POST', '/api/streams/thumbnail', { token: alice.token, body: { image: 'javascript:alert(1)' } })).status, 400);
  assert.equal((await call('POST', '/api/streams/thumbnail', { token: alice.token, body: { image: 'data:image/jpeg;base64,AAAA' } })).status, 200);

  // bob leaves -> alice gets viewer-left
  await call('POST', '/api/rooms/leave', { body: { clientId: bEv.clientId } });
  await aEv.waitFor('viewer-left', (d) => d.peerId === bHello.data.peerId);

  // end stream
  await call('POST', '/api/rooms/join', { body: { clientId: bEv.clientId, streamer: 'alice' } });
  assert.equal((await call('POST', '/api/streams/stop', { token: alice.token })).status, 200);
  await bEv.waitFor('offline', (d) => d.streamer === 'alice');
  assert.equal((await call('GET', '/api/streams')).data.streams.length, 0);
  const dash2 = await call('GET', '/api/me/dashboard', { token: alice.token });
  assert.equal(dash2.data.streams.length, 1);
  assert.equal(dash2.data.streams[0].peakViewers, 1);

  // search & profile
  assert.equal((await call('GET', '/api/search?q=ali')).data.channels[0].user.username, 'alice');
  const prof = await call('PUT', '/api/me', { token: alice.token, body: { displayName: 'Alice!', bio: 'I stream games.' } });
  assert.equal(prof.data.user.bio, 'I stream games.');

  // support / feedback / reports
  assert.equal((await call('POST', '/api/feedback', { body: { kind: 'support', message: 'Help me please with my stream' } })).status, 400); // anonymous needs email
  assert.equal((await call('POST', '/api/feedback', { body: { kind: 'support', email: 'not-an-email', message: 'Help me please with my stream' } })).status, 400);
  assert.equal((await call('POST', '/api/feedback', { body: { kind: 'support', email: 'a@b.co', message: 'short' } })).status, 400);
  assert.equal((await call('POST', '/api/feedback', { body: { kind: 'support', email: 'a@b.co', message: 'Help me please with my stream' } })).status, 200);
  assert.equal((await call('POST', '/api/feedback', { body: { kind: 'report', channel: 'alice', message: 'Anonymous report about this channel' } })).status, 200);
  assert.equal((await call('POST', '/api/feedback', { token: bob.token, body: { kind: 'feedback', message: 'Love the hive metaphor!' } })).status, 200);
  assert.equal((await call('POST', '/api/feedback', { body: { kind: 'school', name: 'Omar', subject: 'Class test', email: 'omar@example.com', message: 'We would like to test StreamHive in class.' } })).status, 200);

  // delete account: wrong password refused, then bob is removed everywhere
  assert.equal((await call('DELETE', '/api/me', { token: bob.token, body: { password: 'nope' } })).status, 403);
  assert.equal((await call('DELETE', '/api/me', { token: bob.token, body: { password: 'password123' } })).status, 200);
  assert.equal((await call('GET', '/api/me', { token: bob.token })).data.user, null);
  assert.equal((await call('GET', '/api/channels/bob')).status, 404);
  const chAfter = await call('GET', '/api/channels/alice');
  assert.equal(chAfter.data.followers, 0);
  assert.equal(chAfter.data.supporters.length, 0);
  const dashAfter = await call('GET', '/api/me/dashboard', { token: alice.token });
  assert.equal(dashAfter.data.totals.gross, 999); // payment records kept
  assert.equal(dashAfter.data.recent[0].user, null);
  assert.equal(dashAfter.data.totals.activeSubscribers, 0);

  // Hive Pro: €19.99 / month, lower fee, PRO badge, no double charge
  assert.equal((await call('GET', '/api/config')).data.pro.price, 1999);
  const pro = await call('POST', '/api/premium', { token: alice.token });
  assert.equal(pro.status, 200);
  assert.equal(pro.data.charged.amount, 1999);
  assert.equal(pro.data.user.pro, true);
  assert.equal((await call('POST', '/api/premium', { token: alice.token })).data.charged, null);
  const proDonation = await call('POST', '/api/donations', { token: carol.token, body: { streamer: 'alice', amount: 1000 } });
  assert.equal(proDonation.data.payment.fee, 60); // 6 % instead of 8 %
  // donating while the streamer is offline works, and is greeted when they go live again
  assert.equal(proDonation.data.payment.offline, true);
  const back = await call('POST', '/api/streams/start', { token: alice.token, body: { clientId: aEv.clientId, title: 'Back again', category: 'Gaming' } });
  assert.equal(back.status, 200);
  assert.equal(back.data.offlineSupport.count, 1);
  assert.equal(back.data.offlineSupport.gross, 1000);
  await aEv.waitFor('chat', (d) => d.message.offline === true && d.message.amount === 1000);
  assert.equal((await call('POST', '/api/streams/stop', { token: alice.token })).status, 200);
  const proChat = await call('POST', '/api/chat', { token: alice.token, body: { streamer: 'alice', text: 'pro now' } });
  assert.equal(proChat.status, 200);
  assert.equal((await call('GET', '/api/channels/alice')).data.user.pro, true);
  const proDash = await call('GET', '/api/me/dashboard', { token: alice.token });
  assert.equal(proDash.data.premium.active, true);
  assert.equal(proDash.data.analytics.averageDonation > 0, true);
  const proCancel = await call('DELETE', '/api/premium', { token: alice.token });
  assert.equal(proCancel.data.premium.status, 'cancelled');
  assert.equal(proCancel.data.user.pro, true); // keeps Pro until the end of the paid month
  const proInfo = await call('GET', '/api/premium', { token: alice.token });
  assert.equal(proInfo.data.payments.length, 1);
  assert.equal((await call('GET', '/api/me/support', { token: alice.token })).data.payments.some((x) => x.type === 'premium'), false);

  // logout invalidates token
  await call('POST', '/api/auth/logout', { token: carol.token });
  assert.equal((await call('GET', '/api/me', { token: carol.token })).data.user, null);

  aEv.close();
  bEv.close();
  cEv.close();
});
