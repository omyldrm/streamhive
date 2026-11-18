'use strict';
/*
 * StreamHive demo mode.
 * Used when the pages are opened without the server (for example straight from the file system).
 * It answers the same API calls as server.js with sample streamers, and simulates chat, viewers and support.
 * All names and numbers here are fictional sample data.
 */
window.StreamHiveMock = (() => {
  const FEE = 0.08;
  const PRO = { price: 1999, fee: 0.06 };
  const PRO_STREAMERS = ['kaiplays', 'lenalearns', 'jadebeats'];
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const CATEGORIES = ['Just Chatting', 'Gaming', 'Music', 'Art & Creative', 'Cooking', 'Fitness', 'Education', 'Tech', 'Outdoors', 'Other'];
  const TIERS = [
    { id: 'bronze', name: 'Bronze', price: 299, perks: ['Supporter badge in chat', 'Name on the supporter wall'] },
    { id: 'silver', name: 'Silver', price: 499, perks: ['Everything in Bronze', 'Highlighted chat messages'] },
    { id: 'gold', name: 'Gold', price: 999, perks: ['Everything in Silver', 'Gold badge and top spot on the supporter wall'] },
  ];
  const tierPrice = (id) => (TIERS.find((t) => t.id === id) || TIERS[0]).price;
  const feeOf = (c, rate = FEE) => Math.round(c * rate);
  const rateFor = (user) => (user && user.pro ? PRO.fee : FEE);

  // [username, display name, hue, emoji, category, title, bio, followers, live viewers (0 = offline), minutes live / days since last live, schedule]
  const PEOPLE = [
    ['jadebeats', 'Jade', 320, '🎧', 'Music', 'Late-night lo-fi & chill chat', 'Lo-fi producer. I make beats live every night and you pick the vibe.', 1240, 128, 47, 'Every night · 22:00'],
    ['kaiplays', 'Kai Plays', 200, '🎮', 'Gaming', 'Ranked grind to Diamond — road to 1000 wins', 'Competitive gamer, chill vibes. Streaming from a 6-year-old laptop.', 3810, 342, 135, 'Mon–Fri · 19:00'],
    ['lenalearns', 'Lena Learns', 180, '📚', 'Education', 'Study with me — 50/10 pomodoro', 'Medical student. Study sessions, exam tips and a lot of tea.', 2150, 215, 92, 'Weekdays · 09:00'],
    ['saracooks', 'Sara Cooks', 25, '🍳', 'Cooking', 'Sunday brunch: fluffy pancakes 3 ways', 'Home cook streaming from my tiny kitchen with just my phone.', 960, 87, 31, 'Sundays · 11:00'],
    ['chatwithzoe', 'Zoe', 340, '💬', 'Just Chatting', 'Ask me anything Friday ✨', 'Talking about life, books and everything in between.', 1730, 76, 64, 'Fridays · 20:00'],
    ['milodraws', 'Milo Draws', 270, '🎨', 'Art & Creative', 'Sketching fantasy maps — come hang out', 'Illustrator. Fantasy maps, characters and your requests.', 610, 54, 18, 'Tue & Thu · 18:00'],
    ['noahfit', 'Noah Fit', 140, '🏋️', 'Fitness', '20-minute morning workout, no equipment', 'Personal trainer. Short workouts you can do in your living room.', 880, 41, 12, 'Daily · 07:30'],
    ['techtom', 'Tech Tom', 220, '💻', 'Tech', 'Building a weather app from scratch', 'Developer teaching coding live, one small project at a time.', 1420, 0, 1, 'Wednesdays · 20:00'],
    ['pianopia', 'Pia Piano', 300, '🎹', 'Music', 'Requests on the piano', 'Classical pianist playing your favourite songs on request.', 2040, 0, 2, 'Saturdays · 16:00'],
    ['outdoorava', 'Ava Outdoors', 100, '🏕️', 'Outdoors', 'Sunrise hike in the Ardennes', 'Hiking and camping, streamed straight from my phone.', 730, 0, 4, 'Weekends'],
    ['retrorik', 'Rik Retro', 45, '👾', 'Gaming', 'Speedrunning 90s classics', 'Retro games, speedruns and nostalgia.', 1180, 0, 6, 'Fri & Sat · 21:00'],
    ['skatesam', 'Sam Skates', 15, '🛹', 'Outdoors', 'Learning a kickflip, day 30', 'Learning to skate at 30. Falling a lot, laughing more.', 450, 0, 9, 'When it doesn\'t rain'],
  ];
  const VIEWER_NAMES = ['bee_happy', 'mila_x', 'sam', 'noor', 'lucas.v', 'emma_r', 'yusuf', 'finn', 'ines', 'thijs', 'aya', 'jules', 'ruben', 'lotte', 'omar'];
  const CHAT_LINES = [
    'this is so cozy 💛', 'hello from Antwerp!', 'first time here, love it', 'how long have you been streaming?', 'the quality is so good for a phone',
    'can you say hi to my sister? 😄', 'GG!', 'haha', 'this is my favourite stream', 'just followed!', 'what are you using to stream?',
    'no OBS?? nice', 'brb getting snacks', 'that was amazing', '🔥🔥🔥', 'love the vibe today', 'greetings from Ghent 👋',
  ];
  const DONATION_LINES = ['Love this stream!', 'Keep going 💛', 'For a coffee ☕', '', 'Thanks for the tips!', 'You made my day', ''];

  function colorFor(name) {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `hsl(${h % 360} 70% 62%)`;
  }

  function thumb(hue, emoji) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><defs><radialGradient id="g" cx="50%" cy="38%" r="80%"><stop offset="0" stop-color="hsl(${hue},62%,46%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},55%,10%)"/></radialGradient></defs><rect width="320" height="180" fill="url(#g)"/><circle cx="262" cy="26" r="64" fill="hsl(${(hue + 180) % 360},80%,62%)" opacity=".16"/><circle cx="36" cy="164" r="74" fill="#fff" opacity=".06"/><path d="M0 150 Q80 120 160 146 T320 138 V180 H0Z" fill="#000" opacity=".22"/><text x="160" y="114" font-size="74" text-anchor="middle" font-family="Segoe UI Emoji,Apple Color Emoji,Noto Color Emoji,sans-serif">${emoji}</text></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  const T0 = Date.now();
  const people = PEOPLE.map(([username, displayName, hue, emoji, category, title, bio, followers, viewers, ago, schedule], i) => ({
    user: { id: `m_${username}`, username, displayName, bio, color: colorFor(username), createdAt: T0 - (200 + i * 37) * DAY, pro: PRO_STREAMERS.includes(username) },
    hue, emoji, category, title, followers, schedule,
    live: viewers > 0 ? { viewers, startedAt: T0 - ago * MIN } : null,
    lastLiveAt: viewers > 0 ? null : T0 - ago * DAY,
    posts: [
      { id: `p1_${username}`, text: `Next stream: ${schedule}. See you there! 🐝`, createdAt: T0 - 5 * HOUR },
      { id: `p2_${username}`, text: 'Thank you all for the support this week — we hit a new record! 💛', createdAt: T0 - 3 * DAY },
    ],
  }));
  const byName = (u) => people.find((p) => p.user.username === String(u || '').toLowerCase()) || null;

  // ----- persisted demo state (shared by all pages through localStorage) -----
  const KEY = 'sh_demo_state';
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && typeof s === 'object') return { me: null, follows: [], seeded: false, subs: {}, payments: [], posts: {}, ...s };
    } catch { /* ignore */ }
    return { me: null, follows: [], seeded: false, subs: {}, payments: [], posts: {} };
  }
  let st = load();
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* ignore */ }
  }

  let hooks = { emit: () => {}, isLive: () => false };
  let liveMe = null;
  const tickers = new Map();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (a) => a[Math.floor(Math.random() * a.length)];
  const id = () => Math.random().toString(16).slice(2, 12);
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const fail = (msg) => { throw new Error(msg); };

  function proActive() {
    const p = st.premium;
    if (!p) return false;
    if (p.renewsAt <= Date.now()) {
      if (p.status === 'cancelled') {
        st.premium = null;
        persist();
        return false;
      }
      p.renewsAt += 30 * DAY;
      st.premiumPayments = [...(st.premiumPayments || []), { id: id(), type: 'premium', amount: PRO.price, renewal: true, createdAt: Date.now() }];
      persist();
    }
    return true;
  }
  function premiumView() {
    if (!proActive()) return null;
    return { status: st.premium.status, startedAt: st.premium.startedAt, renewsAt: st.premium.renewsAt, price: PRO.price, active: true };
  }
  function meUser() {
    return st.me ? { ...st.me, color: colorFor(st.me.username), pro: proActive() } : null;
  }
  function liveInfo(p) {
    if (!p.live) return null;
    return { title: p.title, category: p.category, startedAt: p.live.startedAt, viewers: p.live.viewers, thumbnail: thumb(p.hue, p.emoji), streamer: p.user };
  }
  function myLiveInfo() {
    if (!liveMe || !st.me) return null;
    return { ...liveMe, thumbnail: thumb(45, '🐝'), streamer: meUser() };
  }
  function activeSub(username) {
    const s = st.subs[username];
    if (!s) return null;
    if (s.renewsAt <= Date.now()) {
      if (s.status === 'cancelled') {
        delete st.subs[username];
        persist();
        return null;
      }
      s.renewsAt += 30 * DAY;
    }
    return s;
  }
  function subSummary(s) {
    const t = TIERS.find((x) => x.id === s.tier);
    const n = s.nextTier ? TIERS.find((x) => x.id === s.nextTier) : null;
    return { id: s.id, tier: s.tier, tierName: t.name, price: t.price, nextTier: s.nextTier || null, nextTierName: n ? n.name : null, status: s.status, startedAt: s.startedAt, renewsAt: s.renewsAt, active: true };
  }
  function viewerUser(name) {
    return { id: `v_${name}`, username: name.replace(/[^a-z0-9_]/gi, '').toLowerCase().slice(0, 20).padEnd(3, '_'), displayName: name, bio: '', color: colorFor(name), createdAt: T0 - 90 * DAY };
  }
  function chatAuthor(user, streamer) {
    return { ...user, tier: st.me && user.username === st.me.username ? (activeSub(streamer) || {}).tier || null : null, isStreamer: user.username === streamer };
  }
  function fakeMessage(streamer) {
    const u = viewerUser(rnd(VIEWER_NAMES));
    const roll = Math.random();
    const tier = roll < 0.15 ? 'gold' : roll < 0.3 ? 'silver' : roll < 0.4 ? 'bronze' : null;
    return { id: id(), kind: 'chat', user: { ...u, tier, isStreamer: false }, text: rnd(CHAT_LINES), at: Date.now(), streamer };
  }
  function seedChat(streamer) {
    const list = [];
    for (let i = 0; i < 8; i += 1) {
      const m = fakeMessage(streamer);
      m.at = Date.now() - (8 - i) * 40 * 1000;
      list.push(m);
    }
    return list;
  }

  // Simulated activity in a room: chat, viewer count, donations and new supporters.
  function startTicker(streamer) {
    stopTicker(streamer);
    const own = st.me && streamer === st.me.username;
    const p = byName(streamer);
    let timer = null;
    const step = () => {
      timer = setTimeout(step, 2500 + Math.random() * 3500);
      tickers.set(streamer, timer);
      if (own && !hooks.isLive()) return;
      if (!own && (!p || !p.live)) return;
      const r = Math.random();
      if (r < 0.1) {
        const amount = rnd([200, 300, 500, 500, 1000]);
        const alert = { id: id(), kind: 'donation', user: { ...viewerUser(rnd(VIEWER_NAMES)), tier: null, isStreamer: false }, amount, text: rnd(DONATION_LINES), at: Date.now() };
        hooks.emit('chat', { streamer, message: alert });
        hooks.emit('alert', { streamer, alert });
      } else if (r < 0.14) {
        const alert = { id: id(), kind: 'subscription', user: { ...viewerUser(rnd(VIEWER_NAMES)), tier: null, isStreamer: false }, tier: rnd(['bronze', 'silver', 'gold']), at: Date.now() };
        hooks.emit('chat', { streamer, message: alert });
        hooks.emit('alert', { streamer, alert });
      } else {
        hooks.emit('chat', { streamer, message: fakeMessage(streamer) });
      }
      if (own && liveMe) {
        // A fresh stream gains viewers quickly at first, then levels off.
        liveMe.viewers = Math.max(1, liveMe.viewers + (liveMe.viewers < 25 ? rnd([1, 2, 2, 3]) : rnd([1, 0, -1, 2, -1])));
        hooks.emit('viewers', { streamer, viewers: liveMe.viewers });
      } else if (p && p.live) {
        p.live.viewers = Math.max(1, p.live.viewers + rnd([-2, -1, 0, 1, 2, 3]));
        hooks.emit('viewers', { streamer, viewers: p.live.viewers });
      }
    };
    timer = setTimeout(step, 1500);
    tickers.set(streamer, timer);
  }
  function stopTicker(streamer) {
    clearTimeout(tickers.get(streamer));
    tickers.delete(streamer);
  }
  function stopAllTickers() {
    for (const k of [...tickers.keys()]) stopTicker(k);
  }

  function requireMe() {
    if (!st.me) fail('Please log in first.');
    return meUser();
  }
  function followingEntry(p) {
    return { user: p.user, live: liveInfo(p), followers: p.followers + 1, lastLiveAt: p.lastLiveAt, schedule: p.schedule, category: p.category, emoji: p.emoji, hue: p.hue };
  }
  function receivedDemo(me) {
    // A believable history of support for the demo creator dashboard.
    const list = [];
    const names = VIEWER_NAMES.slice(0, 9);
    for (let i = 0; i < 14; i += 1) {
      const isSub = i % 3 === 0;
      const amount = isSub ? tierPrice(['silver', 'gold', 'bronze'][i % 3]) : [300, 500, 1000, 200, 500][i % 5];
      list.push({
        id: `d${i}`, type: isSub ? 'subscription' : 'donation', amount, fee: feeOf(amount), net: amount - feeOf(amount),
        tier: isSub ? ['silver', 'gold', 'bronze'][i % 3] : null, message: isSub ? '' : ['Great stream!', 'Keep it up 💛', '', 'For a coffee ☕', ''][i % 5],
        renewal: isSub && i > 6, createdAt: Date.now() - (i * 1.7 + 0.2) * DAY, user: viewerUser(names[i % names.length]), to: me.username,
      });
    }
    return list;
  }

  async function api(path, { method = 'GET', body = {} } = {}) {
    await wait(80 + Math.random() * 120);
    const url = new URL(path, 'http://demo');
    const p = url.pathname;
    const q = url.searchParams;
    const b = body || {};
    let m;

    if (p === '/config') {
      return { iceServers: [], tiers: TIERS, categories: CATEGORIES, platformFee: FEE, donation: { min: 100, max: 50000 }, paymentsMode: 'demo', pro: PRO };
    }
    if (p === '/me' && method === 'GET') return { user: meUser() };
    if (p === '/auth/register' || p === '/auth/login') {
      const username = String(b.username || '').trim().toLowerCase();
      if (!/^[a-z0-9_]{3,20}$/.test(username)) fail('Username must be 3–20 characters: letters, numbers or underscores.');
      if (byName(username)) fail('That username belongs to a demo streamer. Pick another one.');
      const pw = typeof b.password === 'string' ? b.password : '';
      if (p === '/auth/register' && pw.length < 8) fail('Password must be at least 8 characters.');
      if (!pw) fail('Please enter a password.');
      const displayName = String(b.displayName || '').trim().slice(0, 30) || (st.me && st.me.username === username ? st.me.displayName : username);
      st.me = { id: `me_${username}`, username, displayName, bio: st.me && st.me.username === username ? st.me.bio : '', createdAt: Date.now() };
      if (!st.seeded) {
        st.follows = ['jadebeats', 'kaiplays', 'lenalearns', 'saracooks', 'milodraws', 'techtom', 'pianopia', 'outdoorava'];
        st.seeded = true;
      }
      persist();
      return { token: 'demo', user: meUser() };
    }
    if (p === '/auth/logout') {
      st.me = null;
      liveMe = null;
      persist();
      return { ok: true };
    }
    if (p === '/me' && method === 'PUT') {
      requireMe();
      const dn = String(b.displayName || '').trim();
      if (!dn) fail('Display name is required.');
      st.me.displayName = dn.slice(0, 30);
      st.me.bio = String(b.bio || '').trim().slice(0, 300);
      persist();
      return { user: meUser() };
    }
    if (p === '/me' && method === 'DELETE') {
      requireMe();
      if (!b.password) fail('Wrong password.');
      st = { me: null, follows: [], seeded: false, subs: {}, payments: [], posts: {}, premium: null, premiumPayments: [] };
      liveMe = null;
      persist();
      return { ok: true };
    }

    if (p === '/streams') {
      const cat = q.get('category');
      let list = people.filter((x) => x.live).map(liveInfo);
      const mine = myLiveInfo();
      if (mine) list.push(mine);
      if (cat) list = list.filter((s) => s.category === cat);
      return { streams: list.sort((a, c) => c.viewers - a.viewers) };
    }
    if (p === '/search') {
      const s = String(q.get('q') || '').toLowerCase().trim();
      return { channels: s ? people.filter((x) => x.user.username.includes(s) || x.user.displayName.toLowerCase().includes(s)).map((x) => ({ user: x.user, live: liveInfo(x) })) : [] };
    }
    if (p === '/channels' && method === 'GET') {
      return {
        channels: people
          .map((x) => ({ user: x.user, live: liveInfo(x), followers: x.followers + (st.follows.includes(x.user.username) ? 1 : 0), following: st.follows.includes(x.user.username) }))
          .sort((a, c) => (c.live ? 1 : 0) - (a.live ? 1 : 0) || (c.user.pro ? 1 : 0) - (a.user.pro ? 1 : 0) || c.followers - a.followers),
      };
    }
    if ((m = /^\/channels\/([^/]+)$/.exec(p))) {
      const name = decodeURIComponent(m[1]).toLowerCase();
      const mine = st.me && st.me.username === name;
      const x = byName(name);
      if (!x && !mine) fail('Channel not found.');
      const following = st.follows.includes(name);
      const extra = (st.posts[name] || []).map((post) => ({ ...post, author: meUser() || viewerUser('former user') }));
      const sub = activeSub(name);
      const supporters = [];
      if (sub && st.me) supporters.push({ user: meUser(), tier: sub.tier });
      if (x) VIEWER_NAMES.slice(0, 7).forEach((n, i) => supporters.push({ user: viewerUser(n), tier: ['gold', 'silver', 'silver', 'bronze', 'gold', 'bronze', 'bronze'][i] }));
      supporters.sort((a, c) => tierPrice(c.tier) - tierPrice(a.tier));
      return {
        user: mine ? meUser() : x.user,
        live: mine ? myLiveInfo() : liveInfo(x),
        followers: mine ? 0 : x.followers + (following ? 1 : 0),
        following,
        subscription: sub ? subSummary(sub) : null,
        supporters,
        posts: [...extra.reverse(), ...(x ? x.posts.map((post) => ({ ...post, author: x.user })) : [])],
        isOwner: !!mine,
      };
    }
    if (p === '/follows' && method === 'POST') {
      requireMe();
      const x = byName(b.streamer);
      if (!x) fail("You can't follow this channel.");
      if (!st.follows.includes(x.user.username)) st.follows.push(x.user.username);
      persist();
      return { following: true, followers: x.followers + 1 };
    }
    if ((m = /^\/follows\/([^/]+)$/.exec(p)) && method === 'DELETE') {
      requireMe();
      const name = decodeURIComponent(m[1]).toLowerCase();
      st.follows = st.follows.filter((f) => f !== name);
      persist();
      const x = byName(name);
      return { following: false, followers: x ? x.followers : 0 };
    }
    if (p === '/me/following') {
      requireMe();
      const list = st.follows.map(byName).filter(Boolean).map(followingEntry);
      list.sort((a, c) => (c.live ? 1 : 0) - (a.live ? 1 : 0) || a.user.displayName.localeCompare(c.user.displayName));
      return { channels: list };
    }

    if (p === '/rooms/join') {
      const name = String(b.streamer || '').toLowerCase();
      const x = byName(name);
      const mine = st.me && st.me.username === name;
      if (!x && !mine) fail('Channel not found.');
      stopAllTickers();
      startTicker(name);
      const live = mine ? myLiveInfo() : liveInfo(x);
      return { live, chat: live ? seedChat(name) : [], viewers: live ? live.viewers : 0 };
    }
    if (p === '/rooms/leave') {
      stopAllTickers();
      return { ok: true };
    }
    if (p === '/signal') return { ok: true };

    if (p === '/streams/start') {
      const me = requireMe();
      const title = String(b.title || '').trim();
      if (!title) fail('Title is required.');
      liveMe = { title: title.slice(0, 100), category: CATEGORIES.includes(b.category) ? b.category : 'Other', startedAt: liveMe ? liveMe.startedAt : Date.now(), viewers: liveMe ? liveMe.viewers : 3 };
      startTicker(me.username);
      return { live: myLiveInfo() };
    }
    if (p === '/streams/update') {
      requireMe();
      if (!liveMe) fail('You are not live.');
      liveMe.title = String(b.title || '').trim().slice(0, 100) || liveMe.title;
      if (CATEGORIES.includes(b.category)) liveMe.category = b.category;
      return { live: myLiveInfo() };
    }
    if (p === '/streams/thumbnail') return { ok: true };
    if (p === '/streams/stop') {
      liveMe = null;
      return { ok: true };
    }

    if (p === '/chat') {
      const me = requireMe();
      const text = String(b.text || '').trim();
      if (!text) fail('Message is required.');
      if (text.length > 300) fail('Message must be at most 300 characters.');
      const streamer = String(b.streamer || '').toLowerCase();
      hooks.emit('chat', { streamer, message: { id: id(), kind: 'chat', user: chatAuthor(me, streamer), text, at: Date.now() } });
      const x = byName(streamer);
      if (x && x.live && Math.random() < 0.5) {
        setTimeout(() => hooks.emit('chat', {
          streamer,
          message: { id: id(), kind: 'chat', user: { ...x.user, tier: null, isStreamer: true }, text: rnd([`Hi ${me.displayName}, welcome! 💛`, `Thanks for the message, ${me.displayName}!`, `Good question ${me.displayName} — give me a sec 😄`]), at: Date.now() },
        }), 1800);
      }
      return { ok: true };
    }
    if (p === '/donations') {
      const me = requireMe();
      const x = byName(b.streamer);
      if (!x) fail("You can't donate to this channel.");
      const amount = Number(b.amount);
      if (!Number.isInteger(amount) || amount < 100 || amount > 50000) fail('Donations must be between €1.00 and €500.00.');
      const message = String(b.message || '').trim().slice(0, 200);
      const fee = feeOf(amount, rateFor(x.user));
      const payment = { id: id(), type: 'donation', amount, fee, net: amount - fee, tier: null, message, renewal: false, offline: !x.live, createdAt: Date.now(), to: x.user.username };
      st.payments.push(payment);
      persist();
      const alert = { id: payment.id, kind: 'donation', offline: !x.live, user: chatAuthor(me, x.user.username), amount, text: message, at: payment.createdAt };
      hooks.emit('chat', { streamer: x.user.username, message: alert });
      hooks.emit('alert', { streamer: x.user.username, alert });
      return { payment };
    }
    if (p === '/subscriptions' && method === 'POST') {
      const me = requireMe();
      const x = byName(b.streamer);
      if (!x) fail("You can't subscribe to this channel.");
      if (!TIERS.some((t) => t.id === b.tier)) fail('Please choose a tier.');
      const existing = activeSub(x.user.username);
      if (existing) {
        existing.status = 'active';
        existing.nextTier = b.tier === existing.tier ? null : b.tier;
        persist();
        return { subscription: subSummary(existing), charged: null };
      }
      const sub = { id: id(), tier: b.tier, nextTier: null, status: 'active', startedAt: Date.now(), renewsAt: Date.now() + 30 * DAY };
      st.subs[x.user.username] = sub;
      const price = tierPrice(b.tier);
      const sfee = feeOf(price, rateFor(x.user));
      const payment = { id: id(), type: 'subscription', amount: price, fee: sfee, net: price - sfee, tier: b.tier, message: '', renewal: false, createdAt: Date.now(), to: x.user.username };
      st.payments.push(payment);
      persist();
      const alert = { id: payment.id, kind: 'subscription', user: chatAuthor(me, x.user.username), tier: b.tier, at: payment.createdAt };
      hooks.emit('chat', { streamer: x.user.username, message: alert });
      hooks.emit('alert', { streamer: x.user.username, alert });
      return { subscription: subSummary(sub), charged: payment };
    }
    if ((m = /^\/subscriptions\/([^/]+)$/.exec(p)) && method === 'DELETE') {
      requireMe();
      const s = activeSub(decodeURIComponent(m[1]).toLowerCase());
      if (!s) fail('You have no active subscription to this channel.');
      s.status = 'cancelled';
      s.nextTier = null;
      persist();
      return { subscription: subSummary(s) };
    }
    if (p === '/posts' && method === 'POST') {
      const me = requireMe();
      const text = String(b.text || '').trim();
      if (!text) fail('Post is required.');
      const name = String(b.streamer || '').toLowerCase();
      const post = { id: id(), text: text.slice(0, 500), createdAt: Date.now() };
      (st.posts[name] = st.posts[name] || []).push(post);
      persist();
      return { post: { ...post, author: me } };
    }
    if ((m = /^\/posts\/([^/]+)$/.exec(p)) && method === 'DELETE') {
      const pid = decodeURIComponent(m[1]);
      for (const k of Object.keys(st.posts)) st.posts[k] = st.posts[k].filter((x) => x.id !== pid);
      persist();
      return { ok: true };
    }
    if (p === '/feedback') {
      const msg = String(b.message || '').trim();
      if (msg.length < 10) fail('Message must be at least 10 characters.');
      if (b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.email).trim())) fail('Please enter a valid email address.');
      if (!st.me && !b.email && b.kind !== 'report') fail('Please enter your email so we can reply.');
      return { ok: true, id: id() };
    }

    if (p === '/premium' && method === 'GET') {
      return { price: PRO.price, fee: PRO.fee, standardFee: FEE, premium: st.me ? premiumView() : null, payments: st.me ? (st.premiumPayments || []).slice().reverse() : [] };
    }
    if (p === '/premium' && method === 'POST') {
      requireMe();
      if (proActive()) {
        st.premium.status = 'active';
        persist();
        return { user: meUser(), premium: premiumView(), charged: null };
      }
      st.premium = { status: 'active', startedAt: Date.now(), renewsAt: Date.now() + 30 * DAY };
      const charged = { id: id(), type: 'premium', amount: PRO.price, renewal: false, createdAt: Date.now() };
      st.premiumPayments = [...(st.premiumPayments || []), charged];
      persist();
      return { user: meUser(), premium: premiumView(), charged };
    }
    if (p === '/premium' && method === 'DELETE') {
      requireMe();
      if (!proActive()) fail('You are not on Hive Pro.');
      st.premium.status = 'cancelled';
      persist();
      return { user: meUser(), premium: premiumView() };
    }
    if (p === '/me/dashboard') {
      const me = requireMe();
      const received = receivedDemo(me);
      const sum = (l, k) => l.reduce((a, x) => a + x[k], 0);
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const byUser = new Map();
      for (const x of received) byUser.set(x.user.displayName, { user: x.user, total: ((byUser.get(x.user.displayName) || {}).total || 0) + x.amount, tier: x.tier });
      return {
        live: myLiveInfo(),
        totals: {
          gross: sum(received, 'amount'), fees: sum(received, 'fee'), net: sum(received, 'net'),
          donationsNet: sum(received.filter((x) => x.type === 'donation'), 'net'),
          subscriptionsNet: sum(received.filter((x) => x.type === 'subscription'), 'net'),
          thisMonthNet: sum(received.filter((x) => x.createdAt >= monthStart.getTime()), 'net'),
          expectedMonthlyNet: 5 * (499 - feeOf(499)) + 2 * (999 - feeOf(999)) + 3 * (299 - feeOf(299)),
          activeSubscribers: 10, followers: 186,
        },
        recent: received,
        topSupporters: [...byUser.values()].sort((a, c) => c.total - a.total).slice(0, 6),
        premium: premiumView(),
        feeRate: proActive() ? PRO.fee : FEE,
        analytics: {
          averageDonation: Math.round(received.filter((x) => x.type === 'donation').reduce((a, x) => a + x.amount, 0) / Math.max(1, received.filter((x) => x.type === 'donation').length)),
          donationCount: received.filter((x) => x.type === 'donation').length,
          uniqueSupporters: new Set(received.map((x) => x.user.displayName)).size,
          bestDay: 'Friday',
          byDay: [1840, 920, 1210, 1460, 2210, 3980, 2650],
        },
        streams: [
          { id: 's1', title: 'My first stream on StreamHive!', category: 'Just Chatting', startedAt: Date.now() - 2 * DAY, endedAt: Date.now() - 2 * DAY + 95 * MIN, peakViewers: 23 },
          { id: 's2', title: 'Q&A and chill', category: 'Just Chatting', startedAt: Date.now() - 5 * DAY, endedAt: Date.now() - 5 * DAY + 62 * MIN, peakViewers: 14 },
          { id: 's3', title: 'Trying screen sharing', category: 'Gaming', startedAt: Date.now() - 9 * DAY, endedAt: Date.now() - 9 * DAY + 40 * MIN, peakViewers: 8 },
        ],
      };
    }
    if (p === '/me/support') {
      requireMe();
      const subs = Object.entries(st.subs).map(([name, s]) => {
        const x = byName(name);
        return x && activeSub(name) ? { ...subSummary(s), streamer: x.user } : null;
      }).filter(Boolean);
      return {
        subscriptions: subs,
        payments: st.payments.slice(-50).reverse().map((x) => ({ ...x, user: (byName(x.to) || {}).user || null })),
        totals: {
          given: st.payments.reduce((a, x) => a + x.amount, 0),
          monthly: subs.filter((s) => s.status === 'active').reduce((a, s) => a + tierPrice(s.nextTier || s.tier), 0),
        },
      };
    }
    fail('This action is not available in demo mode.');
    return null;
  }

  return {
    thumb,
    people: () => clone(people.map((x) => ({ user: x.user, live: liveInfo(x), category: x.category, emoji: x.emoji, hue: x.hue, followers: x.followers }))),
    create(h) {
      hooks = { ...hooks, ...h };
      return { api: (path, opts) => api(path, opts).then(clone) };
    },
  };
})();
