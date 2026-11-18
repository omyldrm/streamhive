'use strict';
/* StreamHive web client — vanilla JS, no build step. */
(() => {
  // =========================================================================
  // Utilities
  // =========================================================================
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
  const moneyFmt = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' });
  const money = (cents) => moneyFmt.format((cents || 0) / 100);
  const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtDate = (t) => dateFmt.format(new Date(t));
  const app = $('#app');

  function ago(t) {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24);
    if (d < 30) return `${d} d ago`;
    return fmtDate(t);
  }
  function duration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  const storage = {
    get(k) {
      try { return localStorage.getItem(k); } catch { return null; }
    },
    set(k, v) {
      try {
        if (v == null) localStorage.removeItem(k);
        else localStorage.setItem(k, v);
      } catch { /* storage unavailable */ }
    },
  };

  function randomHex(bytes) {
    const a = new Uint8Array(bytes);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function avatar(user, cls = '') {
    const initial = (user.displayName || user.username || '?').trim().charAt(0).toUpperCase();
    return `<span class="avatar ${cls}" style="background:${esc(user.color)}" aria-hidden="true">${esc(initial)}</span>`;
  }
  function tierName(id) {
    const t = state.config.tiers.find((x) => x.id === id);
    return t ? t.name : id;
  }
  function tierPrice(id) {
    const t = state.config.tiers.find((x) => x.id === id);
    return t ? t.price : 0;
  }
  function tierBadge(id) {
    return id ? `<span class="badge tier-${esc(id)}" title="${esc(tierName(id))} supporter">${esc(tierName(id))}</span>` : '';
  }
  const feeOf = (cents, rate = state.config.platformFee) => Math.round(cents * rate);
  // Hive Pro streamers pay a lower fee.
  const rateFor = (user) => (user && user.pro && state.config.pro ? state.config.pro.fee : state.config.platformFee);
  const proBadge = (user) => (user && user.pro ? '<span class="badge badge-pro" title="Hive Pro streamer">PRO</span>' : '');

  // =========================================================================
  // State, API, events
  // =========================================================================
  const state = {
    token: storage.get('sh_token'),
    me: null,
    config: null,
    clientId: null,
    peerId: null,
    es: null,
    ready: null,
    room: null,
  };

  function setToken(token) {
    state.token = token;
    storage.set('sh_token', token);
  }

  async function api(path, { method = 'GET', body } = {}) {
    if (state.mock) return state.mock.api(path, { method, body });
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    let res;
    try {
      res = await fetch(`/api${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch {
      throw new Error('Network error. Check your connection and try again.');
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (res.status === 401 && state.me && path !== '/auth/login') {
      // session expired
      setToken(null);
      state.me = null;
      renderAccount();
    }
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status}).`);
    return data;
  }

  const listeners = new Map();
  function on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
    return () => listeners.get(evt).delete(fn);
  }
  function emit(evt, data) {
    const set = listeners.get(evt);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(data); } catch (e) { console.error(e); }
    }
  }

  const SSE_EVENTS = ['hello', 'chat', 'viewers', 'live', 'offline', 'alert', 'viewer-joined', 'viewer-left', 'signal', 'notify', 'broadcast-replaced'];

  function connectEvents() {
    if (state.mock) {
      // Demo mode: mock.js emits chat, viewers and alerts directly.
      state.clientId = 'demo';
      state.peerId = 'demo';
      state.ready = Promise.resolve();
      return;
    }
    if (state.es) state.es.close();
    state.clientId = randomHex(16);
    state.peerId = null;
    let resolveReady;
    state.ready = new Promise((r) => { resolveReady = r; });
    const q = new URLSearchParams({ clientId: state.clientId });
    if (state.token) q.set('token', state.token);
    const es = new EventSource(`/api/events?${q}`);
    state.es = es;
    let firstHello = true;
    for (const name of SSE_EVENTS) {
      es.addEventListener(name, (e) => {
        if (state.es !== es) return;
        let data;
        try { data = JSON.parse(e.data); } catch { return; }
        if (name === 'hello') {
          state.peerId = data.peerId;
          resolveReady();
          // After a reconnect the server may have forgotten our room: join it again.
          if (!firstHello && state.room && data.room !== state.room) joinRoom(state.room).catch(() => {});
          firstHello = false;
          if (studio.live && !data.broadcasting) studio.reset('Connection was lost, so your stream ended. You can go live again.');
        }
        emit(name, data);
      });
    }
  }

  // Room operations and WebRTC signals are sent strictly in order.
  let roomChain = Promise.resolve();
  function joinRoom(username) {
    state.room = username;
    const p = roomChain.then(async () => {
      await state.ready;
      return api('/rooms/join', { method: 'POST', body: { clientId: state.clientId, streamer: username } });
    });
    roomChain = p.catch(() => {});
    return p;
  }
  function leaveRoom() {
    if (!state.room) return;
    state.room = null;
    const clientId = state.clientId;
    roomChain = roomChain.then(() => api('/rooms/leave', { method: 'POST', body: { clientId } })).catch(() => {});
  }

  let signalChain = Promise.resolve();
  function sendSignal(to, data) {
    const clientId = state.clientId;
    signalChain = signalChain
      .then(() => api('/signal', { method: 'POST', body: { clientId, to, data } }))
      .catch((e) => console.warn('Signal not delivered:', e.message));
  }

  // =========================================================================
  // WebRTC
  // =========================================================================
  function createPeer(remote) {
    const pc = new RTCPeerConnection({ iceServers: state.config.iceServers });
    const pending = [];
    pc.onicecandidate = (e) => {
      if (e.candidate) sendSignal(remote, { type: 'candidate', candidate: e.candidate.toJSON() });
    };
    return {
      pc,
      remote,
      async addCandidate(c) {
        if (!c) return;
        if (pc.remoteDescription) {
          try { await pc.addIceCandidate(c); } catch (e) { console.warn(e); }
        } else {
          pending.push(c);
        }
      },
      async setRemote(desc) {
        await pc.setRemoteDescription(desc);
        for (const c of pending.splice(0)) {
          try { await pc.addIceCandidate(c); } catch (e) { console.warn(e); }
        }
      },
    };
  }

  // ----- Viewer side --------------------------------------------------------
  const viewer = {
    video: null,
    bubble: null,
    bubbleId: null,
    bubbleTrack: null,
    bubbleWanted: false,
    peer: null,
    hooks: {},
    attach(video, hooks, bubble) {
      this.detach();
      this.video = video;
      this.bubble = bubble || null;
      this.hooks = hooks || {};
    },
    detach() {
      this.close();
      this.video = null;
      this.bubble = null;
      this.hooks = {};
    },
    close() {
      if (this.peer) {
        this.peer.pc.close();
        this.peer = null;
      }
      if (this.video) this.video.srcObject = null;
      if (this.bubble) {
        this.bubble.srcObject = null;
        this.bubble.hidden = true;
      }
    },
    // The streamer's camera bubble (shown while they share their screen).
    showBubble(track) {
      const b = this.bubble;
      if (!b) return;
      this.bubbleTrack = track;
      b.srcObject = new MediaStream([track]);
      const sync = () => this.syncBubble();
      track.onmute = sync;
      track.onunmute = sync;
      track.onended = sync;
      sync();
    },
    syncBubble() {
      const b = this.bubble;
      const t = this.bubbleTrack;
      if (!b) return;
      b.hidden = !this.bubbleWanted || !t || t.muted || t.readyState === 'ended';
      if (!b.hidden) b.play().catch(() => {});
    },
    async onOffer(from, sdp, bubbleId) {
      if (!this.video) return;
      this.close();
      this.bubbleId = bubbleId || null;
      this.bubbleTrack = null;
      this.bubbleWanted = false;
      const p = createPeer(from);
      this.peer = p;
      // Small control channel from the streamer: is the camera bubble on?
      p.pc.ondatachannel = (e) => {
        e.channel.onmessage = (m) => {
          if (this.peer !== p) return;
          try {
            this.bubbleWanted = !!JSON.parse(m.data).bubble;
            this.syncBubble();
          } catch { /* ignore malformed messages */ }
        };
      };
      p.pc.ontrack = (e) => {
        if (this.peer !== p || !this.video) return;
        if (this.bubbleId && e.streams[0] && e.streams[0].id === this.bubbleId) {
          this.showBubble(e.track);
          return;
        }
        const stream = e.streams[0] || new MediaStream([e.track]);
        if (this.video.srcObject !== stream) {
          this.video.srcObject = stream;
          this.video.play().catch(() => {});
        }
        if (this.hooks.onTrack) this.hooks.onTrack();
      };
      p.pc.onconnectionstatechange = () => {
        if (this.peer === p && this.hooks.onState) this.hooks.onState(p.pc.connectionState);
      };
      try {
        await p.setRemote({ type: 'offer', sdp });
        const answer = await p.pc.createAnswer();
        await p.pc.setLocalDescription(answer);
        sendSignal(from, { type: 'answer', sdp: p.pc.localDescription.sdp });
      } catch (e) {
        console.error('Could not answer stream offer', e);
        if (this.peer === p && this.hooks.onState) this.hooks.onState('failed');
      }
    },
    onCandidate(from, candidate) {
      if (this.peer && this.peer.remote === from) this.peer.addCandidate(candidate);
    },
  };

  // ----- Broadcaster side ("studio") ---------------------------------------
  // Microphone profiles: "voice" filters background noise, "music" keeps instruments natural.
  const MIC_PROFILES = {
    voice: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    music: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  };
  const micConstraints = () => MIC_PROFILES[studio.micProfile] || MIC_PROFILES.voice;
  const camConstraints = (facing) => {
    const hd = !!(state.me && state.me.pro); // Hive Pro: up to 1080p
    return {
      facingMode: { ideal: facing },
      width: { ideal: hd ? 1920 : 1280 },
      height: { ideal: hd ? 1080 : 720 },
      frameRate: { ideal: 30 },
    };
  };
  const gum = (c) => navigator.mediaDevices.getUserMedia(c);

  function mediaError(e) {
    const name = e && e.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return new Error('Access was blocked. Allow camera and microphone for this site in your browser settings, then try again.');
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return new Error('No camera or microphone was found on this device.');
    if (name === 'NotReadableError' || name === 'AbortError') return new Error('Your camera or microphone is being used by another app. Close it and try again.');
    return new Error((e && e.message) || 'Could not start your camera.');
  }

  const studio = {
    camTrack: null,
    micTrack: null,
    screenStream: null,
    videoTrack: null,
    audioTrack: null,
    mixedTrack: null,
    mixNodes: [],
    audioCtx: null,
    source: null, // 'camera' | 'screen' | null
    facing: 'user',
    videoInputs: 0,
    micOn: true,
    micProfile: 'voice',
    videoOn: true,
    live: false,
    startedAt: 0,
    title: '',
    category: '',
    viewers: 0,
    earned: 0,
    outStream: new MediaStream(),
    // Camera bubble while sharing the screen: sent as its own small video track.
    bubbleOn: false,
    bubbleTrack: null,
    bubbleStream: new MediaStream(),
    previewBubbleEl: null,
    peers: new Map(),
    previewEl: null,
    thumbVideo: null,
    thumbTimer: null,

    hasMedia() {
      return !!(this.videoTrack || this.audioTrack);
    },
    checkSupport() {
      if (!window.isSecureContext) {
        throw new Error('Camera access needs a secure connection. Open StreamHive over HTTPS (or on localhost).');
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || (!window.RTCPeerConnection && !state.mock)) {
        throw new Error('This browser cannot stream. Please use a recent Chrome, Safari, Edge or Firefox.');
      }
    },
    async countCameras() {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        this.videoInputs = devices.filter((d) => d.kind === 'videoinput').length;
      } catch {
        this.videoInputs = 0;
      }
    },
    async useCamera() {
      try {
        await this.useRealCamera();
      } catch (e) {
        if (!state.mock) throw e;
        // Demo mode: fall back to an animated demo camera so going live always works.
        toast('No camera available here, so a demo camera is used instead.');
        await this.useDemoCamera();
      }
    },
    async useDemoCamera() {
      this.stopBubbleTrack();
      this.stopScreen();
      this.stopDemo();
      if (this.camTrack) this.camTrack.stop();
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 720;
      const ctx = canvas.getContext('2d');
      const name = state.me ? state.me.displayName : 'You';
      const start = Date.now();
      const draw = () => {
        const t = (Date.now() - start) / 1000;
        const g = ctx.createLinearGradient(0, 0, 1280, 720);
        g.addColorStop(0, `hsl(${(t * 12) % 360} 60% 32%)`);
        g.addColorStop(1, `hsl(${(t * 12 + 80) % 360} 60% 14%)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 1280, 720);
        for (let i = 0; i < 6; i += 1) {
          ctx.fillStyle = 'rgba(245,183,10,0.08)';
          ctx.beginPath();
          ctx.arc(640 + Math.cos(t / 2 + i) * 420, 360 + Math.sin(t / 3 + i * 2) * 220, 90 + i * 14, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.textAlign = 'center';
        ctx.font = '180px "Segoe UI Emoji", "Apple Color Emoji", sans-serif';
        ctx.fillText('🐝', 640, 360 + Math.sin(t * 2) * 18);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 54px system-ui, sans-serif';
        ctx.fillText(`${name} — demo camera`, 640, 520);
        ctx.font = '32px system-ui, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.fillText(new Date().toLocaleTimeString(), 640, 575);
      };
      draw();
      this.demoTimer = setInterval(draw, 1000 / 30);
      this.camTrack = canvas.captureStream(30).getVideoTracks()[0];
      this.camTrack.enabled = this.videoOn;
      this.videoInputs = 0;
      this.facing = 'environment'; // no mirroring for the demo picture
      this.source = 'camera';
      this.videoTrack = this.camTrack;
      await this.updateTracks();
    },
    stopDemo() {
      clearInterval(this.demoTimer);
      this.demoTimer = null;
    },
    stopBubbleTrack() {
      if (this.bubbleTrack) this.bubbleTrack.stop();
      this.bubbleTrack = null;
      this.bubbleOn = false;
    },
    async toggleBubble() {
      if (this.bubbleOn) {
        this.stopBubbleTrack();
        await this.updateTracks();
        return;
      }
      if (this.source !== 'screen') return;
      try {
        const s = await gum({ video: { facingMode: { ideal: 'user' }, width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } } });
        this.bubbleTrack = s.getVideoTracks()[0];
      } catch (e) {
        throw mediaError(e);
      }
      this.bubbleOn = true;
      await this.updateTracks();
    },
    async useRealCamera() {
      this.checkSupport();
      this.stopBubbleTrack();
      if (this.demoTimer) {
        this.stopDemo();
        if (this.camTrack) this.camTrack.stop();
        this.camTrack = null;
        this.facing = 'user';
      }
      const camAlive = this.camTrack && this.camTrack.readyState === 'live';
      const micAlive = this.micTrack && this.micTrack.readyState === 'live';
      if (!camAlive && !micAlive) {
        try {
          const s = await gum({ video: camConstraints(this.facing), audio: micConstraints() });
          this.camTrack = s.getVideoTracks()[0] || null;
          this.micTrack = s.getAudioTracks()[0] || null;
        } catch (e) {
          if (e.name === 'NotAllowedError' || e.name === 'SecurityError') throw mediaError(e);
          // One of the devices is missing or busy: try them one by one.
          this.camTrack = await gum({ video: camConstraints(this.facing) }).then((s) => s.getVideoTracks()[0]).catch(() => null);
          this.micTrack = await gum({ audio: micConstraints() }).then((s) => s.getAudioTracks()[0]).catch(() => null);
          if (!this.camTrack && !this.micTrack) throw mediaError(e);
        }
      } else if (!camAlive) {
        try {
          this.camTrack = (await gum({ video: camConstraints(this.facing) })).getVideoTracks()[0] || null;
        } catch (e) {
          throw mediaError(e);
        }
      }
      if (this.micTrack) this.micTrack.enabled = this.micOn;
      if (this.camTrack) this.camTrack.enabled = this.videoOn;
      this.stopScreen();
      this.source = 'camera';
      this.videoTrack = this.camTrack;
      await this.countCameras();
      await this.updateTracks();
    },
    async useScreen() {
      this.checkSupport();
      if (!navigator.mediaDevices.getDisplayMedia) throw new Error('Screen sharing is not supported on this device. Use your camera instead.');
      let s;
      try {
        s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true });
      } catch (e) {
        if (e.name === 'NotAllowedError') return; // user cancelled the picker
        throw mediaError(e);
      }
      if (!this.micTrack || this.micTrack.readyState !== 'live') {
        this.micTrack = await gum({ audio: micConstraints() }).then((x) => x.getAudioTracks()[0]).catch(() => null);
        if (this.micTrack) this.micTrack.enabled = this.micOn;
      }
      this.stopScreen();
      this.screenStream = s;
      const v = s.getVideoTracks()[0];
      v.addEventListener('ended', () => {
        if (this.screenStream === s) this.useCamera().catch((err) => toast(err.message, 'error'));
      });
      if (this.camTrack) {
        this.camTrack.stop();
        this.camTrack = null;
      }
      v.enabled = this.videoOn;
      this.source = 'screen';
      this.videoTrack = v;
      await this.updateTracks();
    },
    async flip() {
      if (this.source !== 'camera') return;
      const prev = this.facing;
      this.facing = prev === 'user' ? 'environment' : 'user';
      if (this.camTrack) this.camTrack.stop();
      try {
        this.camTrack = (await gum({ video: camConstraints(this.facing) })).getVideoTracks()[0];
      } catch {
        this.facing = prev;
        this.camTrack = await gum({ video: camConstraints(prev) }).then((s) => s.getVideoTracks()[0]).catch(() => null);
        toast("Couldn't switch camera.", 'error');
      }
      if (this.camTrack) this.camTrack.enabled = this.videoOn;
      this.videoTrack = this.camTrack;
      await this.updateTracks();
    },
    setMicProfile(profile) {
      this.micProfile = MIC_PROFILES[profile] ? profile : 'voice';
      if (this.micTrack && this.micTrack.readyState === 'live' && this.micTrack.applyConstraints) {
        this.micTrack.applyConstraints(MIC_PROFILES[this.micProfile]).catch(() => {});
      }
    },
    toggleMic() {
      this.micOn = !this.micOn;
      if (this.micTrack) this.micTrack.enabled = this.micOn;
      emit('studio');
    },
    toggleVideo() {
      this.videoOn = !this.videoOn;
      if (this.videoTrack) this.videoTrack.enabled = this.videoOn;
      emit('studio');
    },
    stopScreen() {
      if (this.screenStream) {
        this.screenStream.getTracks().forEach((t) => t.stop());
        this.screenStream = null;
      }
    },
    teardownMix() {
      this.mixNodes.forEach((n) => n.disconnect());
      this.mixNodes = [];
      if (this.mixedTrack) {
        this.mixedTrack.stop();
        this.mixedTrack = null;
      }
    },
    async updateTracks() {
      this.teardownMix();
      const screenAudio = this.source === 'screen' && this.screenStream ? this.screenStream.getAudioTracks()[0] || null : null;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (screenAudio && this.micTrack && Ctx) {
        // Mix microphone and shared-tab/system audio into one track.
        if (!this.audioCtx) this.audioCtx = new Ctx();
        if (this.audioCtx.state === 'suspended') await this.audioCtx.resume().catch(() => {});
        const dest = this.audioCtx.createMediaStreamDestination();
        const a = this.audioCtx.createMediaStreamSource(new MediaStream([this.micTrack]));
        const b = this.audioCtx.createMediaStreamSource(new MediaStream([screenAudio]));
        a.connect(dest);
        b.connect(dest);
        this.mixNodes = [a, b];
        this.mixedTrack = dest.stream.getAudioTracks()[0];
        this.audioTrack = this.mixedTrack;
      } else {
        this.audioTrack = screenAudio || this.micTrack || null;
      }
      for (const t of this.outStream.getTracks()) this.outStream.removeTrack(t);
      if (this.videoTrack) this.outStream.addTrack(this.videoTrack);
      if (this.audioTrack) this.outStream.addTrack(this.audioTrack);
      const bubble = this.source === 'screen' ? this.bubbleTrack : null;
      for (const t of this.bubbleStream.getTracks()) this.bubbleStream.removeTrack(t);
      if (bubble) this.bubbleStream.addTrack(bubble);
      await Promise.all(
        [...this.peers.values()].map((p) => Promise.all([
          p.videoSender.replaceTrack(this.videoTrack).catch(() => {}),
          p.audioSender.replaceTrack(this.audioTrack).catch(() => {}),
          p.bubbleSender ? p.bubbleSender.replaceTrack(bubble).catch(() => {}) : null,
        ])),
      );
      for (const p of this.peers.values()) this.sendState(p);
      this.attachPreview();
      emit('studio');
    },
    attachPreview() {
      const stream = this.videoTrack ? new MediaStream([this.videoTrack]) : null;
      const v = this.previewEl;
      if (v) {
        v.srcObject = stream;
        v.classList.toggle('mirror', this.source === 'camera' && this.facing === 'user');
        if (stream) v.play().catch(() => {});
      }
      if (!this.thumbVideo) {
        this.thumbVideo = document.createElement('video');
        this.thumbVideo.muted = true;
        this.thumbVideo.playsInline = true;
      }
      this.thumbVideo.srcObject = stream;
      if (stream) this.thumbVideo.play().catch(() => {});
      const pb = this.previewBubbleEl;
      if (pb) {
        const bt = this.source === 'screen' ? this.bubbleTrack : null;
        pb.hidden = !bt;
        pb.srcObject = bt ? new MediaStream([bt]) : null;
        if (bt) pb.play().catch(() => {});
      }
    },
    stopMedia() {
      if (this.live) return;
      this.stopScreen();
      this.stopDemo();
      this.stopBubbleTrack();
      this.teardownMix();
      [this.camTrack, this.micTrack].forEach((t) => t && t.stop());
      this.camTrack = null;
      this.micTrack = null;
      this.videoTrack = null;
      this.audioTrack = null;
      this.source = null;
      for (const t of this.outStream.getTracks()) this.outStream.removeTrack(t);
      this.attachPreview();
      emit('studio');
    },
    async goLive(title, category) {
      if (!this.hasMedia()) throw new Error('Turn on your camera or share your screen first.');
      await state.ready;
      // Mark live before the request: viewer-joined events can arrive before the response.
      this.live = true;
      this.startedAt = Date.now();
      this.earned = 0;
      this.viewers = 0;
      let r;
      try {
        r = await api('/streams/start', { method: 'POST', body: { clientId: state.clientId, title, category } });
        this.startedAt = r.live.startedAt;
        this.title = r.live.title;
        this.category = r.live.category;
        this.viewers = r.live.viewers;
      } catch (e) {
        this.live = false;
        this.closeAllPeers();
        throw e;
      }
      this.startThumbs();
      emit('studio');
      renderLivePill();
      const away = r && r.offlineSupport;
      if (away && away.count) {
        toast(`💛 While you were offline, ${plural(away.count, 'donation')} came in — ${money(away.net)} for you. Their messages are in your chat.`, 'success');
      }
    },
    async update(title, category) {
      const r = await api('/streams/update', { method: 'POST', body: { title, category } });
      this.title = r.live.title;
      this.category = r.live.category;
      emit('studio');
    },
    async end() {
      if (!this.live) return;
      this.live = false;
      this.stopThumbs();
      this.closeAllPeers();
      emit('studio');
      renderLivePill();
      try {
        await api('/streams/stop', { method: 'POST' });
      } catch (e) {
        toast(e.message, 'error');
      }
    },
    reset(message) {
      if (!this.live) return;
      this.live = false;
      this.stopThumbs();
      this.closeAllPeers();
      emit('studio');
      renderLivePill();
      if (message) toast(message, 'error');
    },
    closePeer(peerId) {
      const p = this.peers.get(peerId);
      if (p) {
        p.pc.close();
        this.peers.delete(peerId);
      }
    },
    closeAllPeers() {
      for (const id of [...this.peers.keys()]) this.closePeer(id);
    },
    async onViewerJoined(peerId) {
      if (!this.live) return;
      this.closePeer(peerId);
      const p = createPeer(peerId);
      const { pc } = p;
      p.videoSender = pc.addTransceiver(this.videoTrack || 'video', {
        direction: 'sendonly',
        streams: [this.outStream],
        sendEncodings: [{ maxBitrate: state.me && state.me.pro ? 4000000 : 1500000 }],
      }).sender;
      p.audioSender = pc.addTransceiver(this.audioTrack || 'audio', { direction: 'sendonly', streams: [this.outStream] }).sender;
      const bubble = this.source === 'screen' ? this.bubbleTrack : null;
      p.bubbleSender = pc.addTransceiver(bubble || 'video', {
        direction: 'sendonly',
        streams: [this.bubbleStream],
        sendEncodings: [{ maxBitrate: 350000 }],
      }).sender;
      p.dc = pc.createDataChannel('studio');
      p.dc.onopen = () => this.sendState(p);
      pc.onconnectionstatechange = () => {
        if ((pc.connectionState === 'failed' || pc.connectionState === 'closed') && this.peers.get(peerId) === p) this.closePeer(peerId);
      };
      this.peers.set(peerId, p);
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal(peerId, { type: 'offer', sdp: pc.localDescription.sdp, bubble: this.bubbleStream.id });
      } catch (e) {
        console.error('Could not create offer', e);
        this.closePeer(peerId);
      }
    },
    sendState(p) {
      if (!p.dc || p.dc.readyState !== 'open') return;
      try {
        p.dc.send(JSON.stringify({ bubble: !!(this.source === 'screen' && this.bubbleTrack) }));
      } catch { /* channel closing */ }
    },
    async onAnswer(from, sdp) {
      const p = this.peers.get(from);
      if (!p) return;
      try {
        await p.setRemote({ type: 'answer', sdp });
      } catch (e) {
        console.warn('Bad answer from viewer', e);
        this.closePeer(from);
      }
    },
    startThumbs() {
      this.stopThumbs();
      setTimeout(() => this.captureThumb(), 3000);
      this.thumbTimer = setInterval(() => this.captureThumb(), 20000);
    },
    stopThumbs() {
      clearInterval(this.thumbTimer);
      this.thumbTimer = null;
    },
    captureThumb() {
      if (!this.live) return;
      const v = this.previewEl && this.previewEl.videoWidth ? this.previewEl : this.thumbVideo;
      if (!v || !v.videoWidth) return;
      const c = document.createElement('canvas');
      c.width = 320;
      c.height = 180;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, c.width, c.height);
      const r = Math.min(c.width / v.videoWidth, c.height / v.videoHeight);
      const w = v.videoWidth * r;
      const h = v.videoHeight * r;
      ctx.drawImage(v, (c.width - w) / 2, (c.height - h) / 2, w, h);
      api('/streams/thumbnail', { method: 'POST', body: { image: c.toDataURL('image/jpeg', 0.7) } }).catch(() => {});
    },
  };

  // Route incoming signals to the right side.
  on('signal', ({ from, data }) => {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'answer') studio.onAnswer(from, data.sdp);
    else if (data.type === 'offer') viewer.onOffer(from, data.sdp, data.bubble);
    else if (data.type === 'candidate') {
      const p = studio.peers.get(from);
      if (p) p.addCandidate(data.candidate);
      else viewer.onCandidate(from, data.candidate);
    }
  });
  on('viewer-joined', ({ peerId }) => studio.onViewerJoined(peerId));
  on('viewer-left', ({ peerId }) => studio.closePeer(peerId));
  on('broadcast-replaced', () => studio.reset('You went live from another tab or device, so this one stopped broadcasting.'));
  on('offline', (d) => {
    if (studio.live && state.me && d.streamer === state.me.username) studio.reset('Your stream has ended.');
  });
  on('viewers', (d) => {
    if (studio.live && state.me && d.streamer === state.me.username) {
      studio.viewers = d.viewers;
      emit('studio-stats');
    }
  });
  on('alert', (d) => {
    if (!studio.live || !state.me || d.streamer !== state.me.username) return;
    const a = d.alert;
    const gross = a.kind === 'donation' ? a.amount : tierPrice(a.tier);
    studio.earned += gross - feeOf(gross);
    emit('studio-stats');
  });
  on('notify', (d) => {
    if (d.kind === 'live') toast(`${d.streamer.displayName} is live: ${d.title}`, 'info', { href: `#/c/${d.streamer.username}`, label: 'Watch' });
  });

  window.addEventListener('beforeunload', (e) => {
    if (studio.live) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // =========================================================================
  // UI primitives: toasts, modals, header
  // =========================================================================
  function toast(message, type = 'info', action) {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `<span>${esc(message)}</span>${action ? `<a class="btn btn-small" href="${esc(action.href)}">${esc(action.label)}</a>` : ''}`;
    $('#toasts').appendChild(el);
    const remove = () => el.remove();
    el.addEventListener('click', remove);
    setTimeout(remove, action ? 8000 : 4500);
  }

  function openModal(html, { onClose } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><button type="button" class="modal-close" aria-label="Close">×</button><div class="modal-body">${html}</div></div>`;
    $('#modal-root').appendChild(wrap);
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    function close() {
      if (!wrap.isConnected) return;
      wrap.remove();
      document.removeEventListener('keydown', onKey);
      if (onClose) onClose();
    }
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('mousedown', (e) => {
      if (e.target === wrap) close();
    });
    $('.modal-close', wrap).addEventListener('click', close);
    const body = $('.modal-body', wrap);
    const focusable = $('input, textarea, select', body);
    if (focusable) focusable.focus();
    return { body, close };
  }
  function closeAllModals() {
    $$('.modal-close', $('#modal-root')).forEach((b) => b.click());
  }

  function setBusy(form, busy) {
    $$('button, input, textarea, select', form).forEach((el) => { el.disabled = busy; });
  }
  function showFormError(form, message) {
    const el = $('.form-error', form);
    if (el) {
      el.textContent = message || '';
      el.hidden = !message;
    } else if (message) {
      toast(message, 'error');
    }
  }

  function renderAccount() {
    const el = $('#account');
    if (!state.me) {
      el.innerHTML = `<button class="btn btn-ghost" data-auth="login">Log in</button><button class="btn btn-primary" data-auth="register">Sign up</button>`;
      $$('[data-auth]', el).forEach((b) => b.addEventListener('click', () => authModal(b.dataset.auth)));
      return;
    }
    const me = state.me;
    el.innerHTML = `
      <button class="account-btn" id="account-btn" aria-haspopup="true" aria-expanded="false">${avatar(me)}<span class="account-name">${esc(me.displayName)}</span></button>
      <div class="menu" id="account-menu" hidden>
        <a href="#/c/${esc(me.username)}">Your channel</a>
        <a href="live.html">Go live</a>
        <a href="#/dashboard">Creator dashboard</a>
        <a href="premium.html">👑 Hive Pro${me.pro ? ' ✓' : ''}</a>
        <a href="#/support">My support</a>
        <a href="#/settings">Settings</a>
        <button type="button" id="logout-btn">Log out</button>
      </div>`;
    const btn = $('#account-btn');
    const menu = $('#account-menu');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
      btn.setAttribute('aria-expanded', String(!menu.hidden));
    });
    menu.addEventListener('click', () => { menu.hidden = true; });
    $('#logout-btn').addEventListener('click', logout);
  }
  document.addEventListener('click', () => {
    const menu = $('#account-menu');
    if (menu) menu.hidden = true;
  });

  let pillTimer = null;
  function renderLivePill() {
    const el = $('#live-pill');
    const onStudio = state.path === '/live';
    if (!studio.live || onStudio) {
      el.innerHTML = '';
      clearInterval(pillTimer);
      pillTimer = null;
      return;
    }
    const draw = () => {
      el.innerHTML = `<a class="live-pill" href="live.html"><span class="dot"></span>LIVE ${duration(Date.now() - studio.startedAt)} · ${plural(studio.viewers, 'viewer')}</a>`;
    };
    draw();
    if (!pillTimer) pillTimer = setInterval(draw, 1000);
  }

  // =========================================================================
  // Auth
  // =========================================================================
  function authModal(mode = 'login') {
    let m = null;
    let succeeded = false;
    const draw = () => {
      const isLogin = mode === 'login';
      const html = `
        <h2>${isLogin ? 'Welcome back' : 'Create your account'}</h2>
        <p class="muted">${isLogin ? 'Log in to chat, follow and support streamers.' : 'One account to watch, stream and support. It takes 20 seconds.'}</p>
        <form class="form" id="auth-form" novalidate>
          <label>Username<input name="username" autocomplete="username" required minlength="3" maxlength="20" pattern="[A-Za-z0-9_]{3,20}" autocapitalize="none" spellcheck="false"></label>
          ${isLogin ? '' : '<label>Display name <span class="muted">(optional)</span><input name="displayName" maxlength="30" autocomplete="nickname"></label>'}
          <label>Password<input name="password" type="password" required minlength="${isLogin ? 1 : 8}" autocomplete="${isLogin ? 'current-password' : 'new-password'}"></label>
          ${isLogin ? '' : '<p class="hint">At least 8 characters. Username: 3–20 letters, numbers or underscores.</p>'}
          <p class="form-error" hidden></p>
          <button class="btn btn-primary btn-block" type="submit">${isLogin ? 'Log in' : 'Create account'}</button>
        </form>
        <p class="switch">${isLogin ? 'New to StreamHive?' : 'Already have an account?'} <button type="button" class="link" id="auth-switch">${isLogin ? 'Create an account' : 'Log in'}</button></p>`;
      if (!m) {
        m = openModal(html, {
          onClose: () => {
            if (!succeeded) state.pendingAction = null;
          },
        });
      } else {
        m.body.innerHTML = html;
      }
      const form = $('#auth-form', m.body);
      $('input', form).focus();
      $('#auth-switch', m.body).addEventListener('click', () => {
        mode = isLogin ? 'register' : 'login';
        draw();
      });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const body = Object.fromEntries(fd.entries());
        showFormError(form, '');
        setBusy(form, true);
        try {
          const r = await api(isLogin ? '/auth/login' : '/auth/register', { method: 'POST', body });
          succeeded = true;
          m.close();
          await onLoggedIn(r);
          toast(isLogin ? `Welcome back, ${r.user.displayName}!` : `Welcome to StreamHive, ${r.user.displayName}!`, 'success');
        } catch (err) {
          setBusy(form, false);
          showFormError(form, err.message);
        }
      });
    };
    draw();
  }

  async function onLoggedIn(r) {
    setToken(r.token);
    state.me = r.user;
    connectEvents();
    renderAccount();
    router();
  }

  // Ask to log in, then continue the action (follow / subscribe / donate) once the page re-renders.
  function loginFor(action) {
    state.pendingAction = action;
    authModal('login');
  }

  async function logout() {
    if (studio.live) {
      if (!window.confirm('You are live. Log out and end your stream?')) return;
      await studio.end();
    }
    studio.stopMedia();
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    setToken(null);
    state.me = null;
    leaveRoom();
    connectEvents();
    renderAccount();
    if (location.hash === '#/' || location.hash === '') router();
    else location.hash = '#/';
    toast('You are logged out.');
  }

  function loginWall(title, text) {
    app.innerHTML = `
      <section class="empty-page">
        <h1>${esc(title)}</h1>
        <p class="muted">${esc(text)}</p>
        <div class="row center"><button class="btn btn-primary" id="wall-register">Create account</button><button class="btn" id="wall-login">Log in</button></div>
      </section>`;
    $('#wall-register').addEventListener('click', () => authModal('register'));
    $('#wall-login').addEventListener('click', () => authModal('login'));
  }

  // =========================================================================
  // Shared components
  // =========================================================================
  function streamCard(s) {
    const u = s.streamer;
    const thumb = s.thumbnail
      ? `<img src="${esc(s.thumbnail)}" alt="" loading="lazy">`
      : `<div class="thumb-ph" style="--c:${esc(u.color)}">${avatar(u, 'avatar-lg')}</div>`;
    return `
      <a class="stream-card" href="#/c/${esc(u.username)}">
        <div class="thumb">${thumb}<span class="live-badge">LIVE</span><span class="thumb-viewers">${plural(s.viewers, 'viewer')}</span></div>
        <div class="stream-meta">${avatar(u)}<div class="stream-text">
          <div class="stream-title" title="${esc(s.title)}">${esc(s.title)}</div>
          <div class="muted small">${esc(u.displayName)}</div>
          <span class="tag">${esc(s.category)}</span>
        </div></div>
      </a>`;
  }

  function channelRow({ user, live }) {
    return `
      <a class="channel-row" href="#/c/${esc(user.username)}">
        ${avatar(user, 'avatar-md')}
        <div class="grow">
          <div class="strong">${esc(user.displayName)} <span class="muted small">@${esc(user.username)}</span></div>
          <div class="muted small">${live ? `${esc(live.title)} · ${esc(live.category)}` : 'Offline'}</div>
        </div>
        ${live ? `<span class="live-badge">LIVE</span><span class="muted small">${plural(live.viewers, 'viewer')}</span>` : ''}
      </a>`;
  }

  function showAlert(layer, alert) {
    if (!layer) return;
    const el = document.createElement('div');
    el.className = `stream-alert alert-${alert.kind}`;
    el.innerHTML = alert.kind === 'donation'
      ? `<div class="alert-title">💛 ${esc(alert.user.displayName)} donated ${money(alert.amount)}</div>${alert.text ? `<div class="alert-text">${esc(alert.text)}</div>` : ''}`
      : `<div class="alert-title">⭐ ${esc(alert.user.displayName)} became a ${esc(tierName(alert.tier))} supporter!</div>`;
    layer.appendChild(el);
    setTimeout(() => el.remove(), 7000);
  }

  function mountChat(el, streamer) {
    el.innerHTML = `
      <div class="chat-head"><span>Live chat</span></div>
      <div class="chat-list" role="log" aria-live="polite"></div>
      <div class="chat-foot"></div>`;
    const list = $('.chat-list', el);
    const foot = $('.chat-foot', el);

    if (state.me) {
      foot.innerHTML = `<form class="chat-form"><input name="text" maxlength="300" placeholder="Say something nice…" autocomplete="off" aria-label="Chat message"><button class="btn btn-primary" type="submit">Send</button></form>`;
      const form = $('form', foot);
      const input = $('input', form);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const value = input.value.trim();
        if (!value) return;
        input.disabled = true;
        try {
          await api('/chat', { method: 'POST', body: { streamer, text: value } });
          input.value = '';
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          input.disabled = false;
          input.focus();
        }
      });
    } else {
      foot.innerHTML = '<button class="btn btn-block" type="button">Log in to chat</button>';
      $('button', foot).addEventListener('click', () => authModal('login'));
    }

    function html(m) {
      const u = m.user;
      const name = `<a class="msg-name" href="#/c/${esc(u.username)}" style="color:${esc(u.color)}">${esc(u.displayName)}</a>`;
      const badges = `${u.isStreamer ? '<span class="badge badge-streamer">Streamer</span>' : ''}${proBadge(u)}${tierBadge(u.tier)}`;
      if (m.kind === 'donation') {
        return `<div class="msg msg-donation">💛 ${badges}${name} donated <strong>${money(m.amount)}</strong>${m.offline ? ' <span class="offline-tag">while offline</span>' : ''}${m.text ? `<div class="msg-text">${esc(m.text)}</div>` : ''}</div>`;
      }
      if (m.kind === 'subscription') {
        return `<div class="msg msg-sub">⭐ ${name} became a <strong>${esc(tierName(m.tier))}</strong> supporter!</div>`;
      }
      return `<div class="msg ${u.tier ? `msg-${esc(u.tier)}` : ''}">${badges}${name}<span class="msg-sep">:</span> <span class="msg-text">${esc(m.text)}</span></div>`;
    }
    const seen = new Set();
    function add(m) {
      if (seen.has(m.id)) return;
      seen.add(m.id);
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      list.insertAdjacentHTML('beforeend', html(m));
      while (list.children.length > 200) list.firstElementChild.remove();
      if (nearBottom) list.scrollTop = list.scrollHeight;
    }
    function load(messages) {
      if (!messages.length && !list.children.length) {
        list.innerHTML = '<div class="chat-empty muted">No messages yet. Say hi!</div>';
      }
      messages.forEach(add);
      list.scrollTop = list.scrollHeight;
    }
    const off = on('chat', (d) => {
      if (d.streamer !== streamer) return;
      const empty = $('.chat-empty', list);
      if (empty) empty.remove();
      add(d.message);
    });
    return { load, destroy: off };
  }

  // =========================================================================
  // Payments: donate & subscribe
  // =========================================================================
  const DEMO_NOTE = '<p class="demo-note">Demo payments: no real money is charged. In production this step is handled by a licensed payment provider.</p>';

  function donateModal(channel, onDone, opts = {}) {
    const offline = !!opts.offline;
    const { min, max } = state.config.donation;
    const presets = [200, 500, 1000, 2000];
    const rate = rateFor(channel);
    const feePct = Math.round(rate * 100);
    const m = openModal(`
      <h2>Donate to ${esc(channel.displayName)}</h2>
      ${offline ? `<div class="offline-note">🌙 <span><strong>${esc(channel.displayName)} is offline right now.</strong> You can still donate — your message lands in their dashboard, and they get a thank-you shout-out in chat when they go live again.</span></div>` : ''}
      <form class="form" id="donate-form" novalidate>
        <div class="amounts">${presets.map((c, i) => `<button type="button" class="amount ${i === 1 ? 'active' : ''}" data-cents="${c}">${money(c)}</button>`).join('')}</div>
        <label>Or enter an amount (€)<input name="custom" inputmode="decimal" placeholder="e.g. 3.50" autocomplete="off"></label>
        <label>Message <span class="muted">(optional, shown on stream)</span><textarea name="message" maxlength="200" rows="2" placeholder="Love the stream!"></textarea></label>
        <div class="breakdown" id="breakdown"></div>
        <p class="form-error" hidden></p>
        <button class="btn btn-primary btn-block" type="submit" id="donate-submit">Donate</button>
        ${DEMO_NOTE}
      </form>`);
    const form = $('#donate-form', m.body);
    const custom = $('[name=custom]', form);
    let preset = presets[1];

    const amount = () => {
      const raw = custom.value.trim().replace(',', '.');
      if (!raw) return preset;
      if (!/^\d+(\.\d{1,2})?$/.test(raw)) return NaN;
      return Math.round(Number(raw) * 100);
    };
    const update = () => {
      const a = amount();
      const valid = Number.isInteger(a) && a >= min && a <= max;
      $('#breakdown', form).innerHTML = valid
        ? `<div><span>You pay</span><span>${money(a)}</span></div>
           <div><span>Platform fee (${feePct}%)</span><span>−${money(feeOf(a, rate))}</span></div>
           <div class="strong"><span>${esc(channel.displayName)} receives</span><span>${money(a - feeOf(a, rate))}</span></div>`
        : `<div class="muted">Enter an amount between ${money(min)} and ${money(max)}.</div>`;
      $('#donate-submit', form).textContent = valid ? `Donate ${money(a)}` : 'Donate';
      $('#donate-submit', form).disabled = !valid;
    };
    $$('.amount', form).forEach((b) => b.addEventListener('click', () => {
      $$('.amount', form).forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      preset = Number(b.dataset.cents);
      custom.value = '';
      update();
    }));
    custom.addEventListener('input', () => {
      $$('.amount', form).forEach((x) => x.classList.toggle('active', !custom.value.trim() && Number(x.dataset.cents) === preset));
      update();
    });
    update();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const a = amount();
      showFormError(form, '');
      setBusy(form, true);
      try {
        const r = await api('/donations', { method: 'POST', body: { streamer: channel.username, amount: a, message: $('[name=message]', form).value } });
        m.body.innerHTML = `
          <div class="success">
            <div class="success-icon">💛</div>
            <h2>Thank you!</h2>
            <p>You donated <strong>${money(r.payment.amount)}</strong> to ${esc(channel.displayName)}. They receive ${money(r.payment.net)}.</p>
            ${r.payment.offline ? `<p class="muted small">🌙 ${esc(channel.displayName)} is offline, so they'll see your donation and message when they're back.</p>` : ''}
            <p class="muted small">Receipt ${esc(r.payment.id)} · ${fmtDate(r.payment.createdAt)}</p>
            <button class="btn btn-primary" type="button" id="done">${r.payment.offline ? 'Back to the channel' : 'Back to the stream'}</button>
          </div>`;
        $('#done', m.body).addEventListener('click', m.close);
        if (onDone) onDone();
      } catch (err) {
        setBusy(form, false);
        update();
        showFormError(form, err.message);
      }
    });
  }

  function subscribeModal(channel, sub, onDone) {
    const tiers = state.config.tiers;
    const active = sub && sub.active;
    const rate = rateFor(channel);
    const feePct = Math.round(rate * 100);
    let chosen = active ? sub.nextTier || sub.tier : 'silver';

    const status = () => {
      if (!active) return '';
      if (sub.status === 'cancelled') return `<div class="notice">Your ${esc(sub.tierName)} support is cancelled and ends on <strong>${fmtDate(sub.renewsAt)}</strong>. Resume any time — you won't be charged until then.</div>`;
      return `<div class="notice">You're a <strong>${esc(sub.tierName)}</strong> supporter. Renews on ${fmtDate(sub.renewsAt)}${sub.nextTier ? `, switching to ${esc(sub.nextTierName)}` : ''}.</div>`;
    };

    const m = openModal(`
      <h2>Support ${esc(channel.displayName)} every month</h2>
      <p class="muted">Regular support helps streamers plan ahead. Cancel any time; you keep your perks until the end of the paid month.</p>
      ${status()}
      <form class="form" id="sub-form">
        <div class="tiers">${tiers.map((t) => `
          <label class="tier-card tier-${esc(t.id)}">
            <input type="radio" name="tier" value="${esc(t.id)}" ${t.id === chosen ? 'checked' : ''}>
            <span class="tier-name">${esc(t.name)}</span>
            <span class="tier-price">${money(t.price)}<span class="muted small"> / month</span></span>
            <ul>${t.perks.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
            <span class="muted small">${esc(channel.displayName)} receives ${money(t.price - feeOf(t.price, rate))} (after ${feePct}% fee)</span>
          </label>`).join('')}</div>
        <p class="form-error" hidden></p>
        <button class="btn btn-primary btn-block" type="submit" id="sub-submit"></button>
        ${active && sub.status === 'active' ? '<button class="btn btn-ghost btn-block" type="button" id="sub-cancel">Cancel subscription</button>' : ''}
        ${DEMO_NOTE}
      </form>`);
    const form = $('#sub-form', m.body);
    const submit = $('#sub-submit', form);
    const label = () => {
      const t = tiers.find((x) => x.id === chosen);
      if (!active) return `Subscribe for ${money(t.price)} / month`;
      if (sub.status === 'cancelled') return chosen === sub.tier ? `Resume ${t.name}` : `Resume and switch to ${t.name} on ${fmtDate(sub.renewsAt)}`;
      if (chosen === sub.tier) return sub.nextTier ? `Stay on ${t.name}` : `You're on ${t.name}`;
      return `Switch to ${t.name} on ${fmtDate(sub.renewsAt)}`;
    };
    const update = () => {
      submit.textContent = label();
      submit.disabled = !!(active && sub.status === 'active' && chosen === sub.tier && !sub.nextTier);
    };
    $$('[name=tier]', form).forEach((r) => r.addEventListener('change', () => { chosen = r.value; update(); }));
    update();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      showFormError(form, '');
      setBusy(form, true);
      try {
        const r = await api('/subscriptions', { method: 'POST', body: { streamer: channel.username, tier: chosen } });
        m.body.innerHTML = `
          <div class="success">
            <div class="success-icon">⭐</div>
            <h2>${r.charged ? 'Thank you for your support!' : 'Subscription updated'}</h2>
            <p>${r.charged
              ? `You're now a <strong>${esc(r.subscription.tierName)}</strong> supporter of ${esc(channel.displayName)}. You paid ${money(r.charged.amount)}; next payment on ${fmtDate(r.subscription.renewsAt)}.`
              : `Your ${esc(r.subscription.tierName)} support is active${r.subscription.nextTierName ? ` and switches to ${esc(r.subscription.nextTierName)} on ${fmtDate(r.subscription.renewsAt)}` : ''}. Nothing was charged today.`}</p>
            <button class="btn btn-primary" type="button" id="done">Done</button>
          </div>`;
        $('#done', m.body).addEventListener('click', m.close);
        if (onDone) onDone();
      } catch (err) {
        setBusy(form, false);
        update();
        showFormError(form, err.message);
      }
    });
    const cancelBtn = $('#sub-cancel', form);
    if (cancelBtn) {
      cancelBtn.addEventListener('click', async () => {
        if (!window.confirm(`Cancel your ${sub.tierName} support? You keep your perks until ${fmtDate(sub.renewsAt)}.`)) return;
        setBusy(form, true);
        try {
          await cancelSubscription(channel.username);
          m.close();
          toast('Subscription cancelled. Thanks for supporting!');
          if (onDone) onDone();
        } catch (err) {
          setBusy(form, false);
          update();
          showFormError(form, err.message);
        }
      });
    }
  }

  function cancelSubscription(username) {
    return api(`/subscriptions/${encodeURIComponent(username)}`, { method: 'DELETE' });
  }

  // =========================================================================
  // Pages
  // =========================================================================
  function channelCard({ user, live, followers }) {
    return `
      <a class="channel-card ${live ? 'is-live' : ''}" href="#/c/${esc(user.username)}">
        <div class="channel-card-top">${avatar(user, 'avatar-xl')}${live ? '<span class="live-badge">LIVE</span>' : ''}</div>
        <div class="strong ellipsis">${esc(user.displayName)} ${proBadge(user)}</div>
        <div class="muted small">@${esc(user.username)} · ${plural(followers, 'follower')}</div>
        <p class="muted small clamp">${live ? `🔴 ${esc(live.title)}` : user.bio ? esc(user.bio) : 'New on StreamHive'}</p>
      </a>`;
  }

  function emptyLive(category) {
    return `
      <div class="empty-live">
        <div class="hex">🐝</div>
        <div>
          <h3>The hive is quiet${category ? ` in ${esc(category)}` : ''} right now</h3>
          <p class="muted">Nobody is live at the moment. Be the first — it takes less than a minute — or follow channels below to get notified when they go live.</p>
          <div class="row"><a class="btn btn-primary" href="live.html">● Go live</a>${state.me ? '<a class="btn" href="following.html">Your following</a>' : ''}</div>
        </div>
      </div>`;
  }

  const CAT_ICONS = {
    'Just Chatting': '💬', Gaming: '🎮', Music: '🎧', 'Art & Creative': '🎨', Cooking: '🍳',
    Fitness: '🏋️', Education: '📚', Tech: '💻', Outdoors: '🏕️', Other: '✨',
  };
  const CAT_HUES = {
    'Just Chatting': 340, Gaming: 210, Music: 300, 'Art & Creative': 270, Cooking: 25,
    Fitness: 140, Education: 185, Tech: 230, Outdoors: 100, Other: 45,
  };

  // =========================================================================
  // Browse — a "TV guide": featured stream, category tiles, live grid, channel rail
  // =========================================================================
  async function pageBrowse(ctx) {
    const cats = state.config.categories;
    app.innerHTML = `
      <div class="browse">
        <section class="featured" id="featured"><div class="loading">Loading what's live…</div></section>

        <section class="section">
          <div class="section-head"><h2>Browse by category</h2><span class="muted small">Tap a category to filter the live streams</span></div>
          <div class="cat-tiles" id="cat-tiles">
            ${cats.map((c) => `
              <button class="cat-tile" type="button" data-cat="${esc(c)}" style="--h:${CAT_HUES[c] || 45}">
                <span class="cat-ico">${CAT_ICONS[c] || '✨'}</span>
                <span class="cat-name">${esc(c)}</span>
                <span class="cat-count" data-count="${esc(c)}">0 live</span>
              </button>`).join('')}
          </div>
        </section>

        <section class="section" id="live-now">
          <div class="section-head">
            <h2 class="h-live"><span class="live-dot"></span>Live now <span class="count-pill" id="live-count"></span></h2>
            <div class="row">
              <button class="chip active" type="button" id="cat-clear" hidden>✕ <span id="cat-label"></span></button>
              <input type="search" id="search" placeholder="Search channels…" aria-label="Search channels" autocomplete="off">
            </div>
          </div>
          <div id="search-results"></div>
          <div class="grid" id="live-grid"><div class="loading">Loading streams…</div></div>
        </section>

        <section class="section">
          <div class="section-head"><h2>Rising channels</h2><span class="muted small">Live first, then the most followed creators</span></div>
          <div class="rail" id="discover"><div class="loading">Loading channels…</div></div>
        </section>

        ${state.me ? '' : `
        <section class="promo-band">
          <div><h2>Got something to share?</h2><p class="muted">Go live from your phone in seconds — no OBS, no powerful PC. Viewers can support you right from your stream.</p></div>
          <a class="btn btn-primary btn-lg" href="live.html">Start streaming</a>
        </section>`}
      </div>`;

    const grid = $('#live-grid');
    let category = '';
    let all = [];

    function renderFeatured() {
      const el = $('#featured');
      if (!all.length) {
        el.innerHTML = emptyLive('');
        return;
      }
      const [top, ...rest] = all;
      el.innerHTML = `
        <a class="featured-main" href="#/c/${esc(top.streamer.username)}">
          <img src="${esc(top.thumbnail || '')}" alt="">
          <div class="featured-shade"></div>
          <div class="featured-top"><span class="live-badge">LIVE</span><span class="thumb-viewers">👁 ${plural(top.viewers, 'viewer')}</span><span class="featured-tag">⭐ Featured</span></div>
          <div class="featured-info">
            <div class="row">${avatar(top.streamer, 'avatar-md')}<div><div class="strong">${esc(top.streamer.displayName)}</div><div class="small muted-light">${esc(top.category)} · live for ${duration(Date.now() - top.startedAt)}</div></div></div>
            <h2>${esc(top.title)}</h2>
            <span class="btn btn-primary">▶ Watch now</span>
          </div>
        </a>
        <div class="featured-side">
          <h3>Also live</h3>
          ${rest.slice(0, 4).map((s) => `
            <a class="mini-stream" href="#/c/${esc(s.streamer.username)}">
              <div class="mini-thumb"><img src="${esc(s.thumbnail || '')}" alt=""><span class="live-badge">LIVE</span></div>
              <div class="grow"><div class="strong ellipsis">${esc(s.streamer.displayName)}</div><div class="small muted ellipsis">${esc(s.title)}</div><div class="small muted">👁 ${s.viewers} · ${esc(s.category)}</div></div>
            </a>`).join('') || '<p class="muted small">More streams will show up here.</p>'}
          <a class="btn btn-block" href="#live-now" data-scroll="live-now">See all live streams</a>
        </div>`;
    }
    function renderCounts() {
      const counts = {};
      for (const s of all) counts[s.category] = (counts[s.category] || 0) + 1;
      $$('[data-count]').forEach((el) => {
        const n = counts[el.dataset.count] || 0;
        el.textContent = n ? `${n} live` : 'Nobody live';
        el.closest('.cat-tile').classList.toggle('has-live', n > 0);
      });
    }
    function renderGrid() {
      const list = category ? all.filter((s) => s.category === category) : all;
      $('#live-count').textContent = list.length ? String(list.length) : '';
      grid.innerHTML = list.length ? list.map(streamCard).join('') : emptyLive(category);
      $('#cat-clear').hidden = !category;
      $('#cat-label').textContent = category;
      $$('.cat-tile').forEach((t) => t.classList.toggle('active', t.dataset.cat === category));
    }
    async function load() {
      try {
        const r = await api('/streams');
        if (!ctx.alive()) return;
        all = r.streams;
        renderFeatured();
        renderCounts();
        renderGrid();
      } catch (e) {
        if (ctx.alive()) grid.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      }
    }
    async function loadDiscover() {
      try {
        const r = await api('/channels');
        if (!ctx.alive()) return;
        $('#discover').innerHTML = r.channels.length
          ? r.channels.map(channelCard).join('')
          : '<div class="empty">No channels yet. <a class="accent" href="live.html">Create the very first one!</a></div>';
      } catch (e) {
        if (ctx.alive()) $('#discover').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      }
    }

    $$('.cat-tile').forEach((t) => t.addEventListener('click', () => {
      category = category === t.dataset.cat ? '' : t.dataset.cat;
      renderGrid();
      $('#live-now').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
    $('#cat-clear').addEventListener('click', () => {
      category = '';
      renderGrid();
    });

    const results = $('#search-results');
    let searchTimer = null;
    $('#search').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      const q = e.target.value.trim();
      if (!q) {
        results.innerHTML = '';
        return;
      }
      searchTimer = setTimeout(async () => {
        try {
          const r = await api(`/search?q=${encodeURIComponent(q)}`);
          if (!ctx.alive()) return;
          results.innerHTML = `<div class="card list">${r.channels.length ? r.channels.map(channelRow).join('') : '<div class="muted pad">No channels found.</div>'}</div>`;
        } catch { /* ignore */ }
      }, 250);
    });

    await Promise.all([load(), loadDiscover()]);
    const t = setInterval(load, 15000);
    ctx.cleanup(() => {
      clearInterval(t);
      clearTimeout(searchTimer);
    });
  }

  // =========================================================================
  // Following — "Your hive": a grid of your favourite streamers
  // =========================================================================
  function mutedBells() {
    try { return new Set(JSON.parse(storage.get('sh_muted_bells') || '[]')); } catch { return new Set(); }
  }
  function saveMutedBells(set) {
    storage.set('sh_muted_bells', JSON.stringify([...set]));
  }

  function favCard(c, muted) {
    const u = c.user;
    const live = c.live;
    const cat = (live && live.category) || c.category || '';
    const icon = c.emoji || CAT_ICONS[cat] || '🐝';
    const hue = c.hue != null ? c.hue : CAT_HUES[cat] || 45;
    const bellOn = !muted.has(u.username);
    const status = live
      ? `<span class="fav-live-text">🔴 ${esc(live.title)}</span>`
      : c.lastLiveAt ? `Last live ${ago(c.lastLiveAt)}` : 'Offline right now';
    return `
      <article class="fav-card ${live ? 'is-live' : ''}" style="--h:${hue}" data-name="${esc(`${u.displayName} ${u.username}`.toLowerCase())}">
        <a class="fav-cover" href="#/c/${esc(u.username)}" tabindex="-1" aria-hidden="true">
          ${live && live.thumbnail ? `<img src="${esc(live.thumbnail)}" alt="">` : `<span class="fav-icon">${icon}</span>`}
          ${live ? `<span class="live-badge">LIVE</span><span class="fav-viewers">👁 ${live.viewers}</span>` : ''}
        </a>
        <div class="fav-body">
          <a class="fav-avatar" href="#/c/${esc(u.username)}">${avatar(u, 'avatar-lg')}</a>
          <a class="fav-name strong" href="#/c/${esc(u.username)}">${esc(u.displayName)} ${proBadge(u)}</a>
          <div class="muted small">@${esc(u.username)}${c.followers != null ? ` · ${plural(c.followers, 'follower')}` : ''}</div>
          <p class="fav-status small">${status}</p>
          <div class="fav-meta">${cat ? `<span class="tag">${CAT_ICONS[cat] || ''} ${esc(cat)}</span>` : ''}${c.schedule ? `<span class="muted small">📅 ${esc(c.schedule)}</span>` : ''}</div>
          <div class="fav-actions">
            <a class="btn btn-small ${live ? 'btn-primary' : ''} grow" href="#/c/${esc(u.username)}">${live ? '▶ Watch' : 'View channel'}</a>
            <button class="icon-toggle donate-toggle" type="button" data-donate="${esc(u.username)}" title="Donate to ${esc(u.displayName)}${live ? '' : ' (even while offline)'}" aria-label="Donate to ${esc(u.displayName)}">💛</button>
            <button class="icon-toggle ${bellOn ? 'on' : ''}" type="button" data-bell="${esc(u.username)}" aria-pressed="${bellOn}" title="${bellOn ? 'Live notifications on' : 'Live notifications off'}">${bellOn ? '🔔' : '🔕'}</button>
            <button class="icon-toggle" type="button" data-unfollow="${esc(u.username)}" title="Unfollow ${esc(u.displayName)}" aria-label="Unfollow ${esc(u.displayName)}">✕</button>
          </div>
        </div>
      </article>`;
  }

  async function pageFollowing(ctx) {
    if (!state.me) return pageFollowingGuest(ctx);
    app.innerHTML = `
      <section class="hive-head">
        <div class="honeycomb" aria-hidden="true"></div>
        <div class="hive-title">
          <span class="eyebrow">🐝 Your hive</span>
          <h1>Following</h1>
          <p class="muted">Your favourite streamers in one place. Live channels come first, and you get a notification when someone goes live.</p>
        </div>
        <div class="hive-stats">
          <div><strong id="st-following">–</strong><span>following</span></div>
          <div><strong id="st-live" class="live-num">–</strong><span>live now</span></div>
          <div><strong id="st-bells">–</strong><span>alerts on</span></div>
        </div>
      </section>
      <div class="fav-toolbar">
        <div class="seg" role="tablist" aria-label="Filter">
          <button type="button" class="active" data-filter="all">All</button>
          <button type="button" data-filter="live">● Live now</button>
          <button type="button" data-filter="offline">Offline</button>
        </div>
        <input type="search" id="fav-search" placeholder="Find in your hive…" aria-label="Find a channel you follow" autocomplete="off">
      </div>
      <div class="fav-grid" id="fav-grid"><div class="loading">Loading your hive…</div></div>
      <section class="section" id="suggest-section" hidden>
        <div class="section-head"><h2>Grow your hive</h2><a class="btn" href="browse.html">Browse all</a></div>
        <div class="rail" id="suggest"></div>
      </section>`;

    let channels = [];
    let filter = 'all';
    let muted = mutedBells();

    function render() {
      const q = $('#fav-search').value.trim().toLowerCase();
      const list = channels.filter((c) => (filter === 'live' ? c.live : filter === 'offline' ? !c.live : true))
        .filter((c) => !q || `${c.user.displayName} ${c.user.username}`.toLowerCase().includes(q));
      $('#st-following').textContent = String(channels.length);
      $('#st-live').textContent = String(channels.filter((c) => c.live).length);
      $('#st-bells').textContent = String(channels.filter((c) => !muted.has(c.user.username)).length);
      const grid = $('#fav-grid');
      if (!channels.length) {
        grid.innerHTML = `<div class="empty-live"><div class="hex">🌼</div><div><h3>Your hive is still empty</h3><p class="muted">Open a channel and press ♡ Follow — your favourite streamers will show up here as cards.</p><div class="row"><a class="btn btn-primary" href="browse.html">Find streamers</a></div></div></div>`;
        return;
      }
      grid.innerHTML = list.length
        ? list.map((c) => favCard(c, muted)).join('')
        : `<div class="empty">${filter === 'live' ? 'None of your channels are live right now — we\'ll notify you.' : 'No channels match.'}</div>`;
    }

    async function load() {
      try {
        const r = await api('/me/following');
        if (!ctx.alive()) return;
        channels = r.channels;
        render();
      } catch (e) {
        if (ctx.alive()) $('#fav-grid').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      }
    }
    async function loadSuggestions() {
      try {
        const r = await api('/channels');
        if (!ctx.alive()) return;
        const list = r.channels.filter((c) => !c.following).slice(0, 10);
        $('#suggest').innerHTML = list.map(channelCard).join('');
        $('#suggest-section').hidden = !list.length;
      } catch { /* optional */ }
    }

    $$('.seg button').forEach((b) => b.addEventListener('click', () => {
      filter = b.dataset.filter;
      $$('.seg button').forEach((x) => x.classList.toggle('active', x === b));
      render();
    }));
    $('#fav-search').addEventListener('input', render);
    $('#fav-grid').addEventListener('click', async (e) => {
      const don = e.target.closest('[data-donate]');
      if (don) {
        const c = channels.find((x) => x.user.username === don.dataset.donate);
        if (c) donateModal(c.user, null, { offline: !c.live });
        return;
      }
      const bell = e.target.closest('[data-bell]');
      if (bell) {
        const name = bell.dataset.bell;
        if (muted.has(name)) muted.delete(name);
        else muted.add(name);
        saveMutedBells(muted);
        render();
        toast(muted.has(name) ? 'Live notifications turned off for this channel.' : 'You\'ll be notified when this channel goes live.');
        return;
      }
      const un = e.target.closest('[data-unfollow]');
      if (un) {
        const name = un.dataset.unfollow;
        try {
          await api(`/follows/${encodeURIComponent(name)}`, { method: 'DELETE' });
          channels = channels.filter((c) => c.user.username !== name);
          render();
          loadSuggestions();
          toast('Unfollowed.');
        } catch (err) {
          toast(err.message, 'error');
        }
      }
    });

    await Promise.all([load(), loadSuggestions()]);
    const t = setInterval(load, 20000);
    ctx.cleanup(() => clearInterval(t));
  }

  // =========================================================================
  // Landing page
  // =========================================================================
  async function pageLanding(ctx) {
    const pct = feePct();
    const keep = 100 - pct;
    const ex = 500;
    const mockThumb = window.StreamHiveMock ? window.StreamHiveMock.thumb : () => '';
    const cats = state.config.categories;
    const marquee = cats.map((c) => `<span>${CAT_ICONS[c] || '✨'} ${esc(c)}</span>`).join('');
    app.innerHTML = `
      <div class="landing">
        <section class="l-hero">
          <div class="honeycomb" aria-hidden="true"></div>
          <div class="l-hero-text">
            <span class="eyebrow">🐝 One platform for streams, donations and supporters</span>
            <h1>Go live in seconds.<br><span class="grad">Get supported in one place.</span></h1>
            <p class="lead">StreamHive lets anyone stream straight from a phone or a basic computer — no OBS, no powerful PC, no setup. Your viewers watch, chat, donate and support you every month without ever leaving your stream.</p>
            <div class="row">
              <a class="btn btn-primary btn-lg btn-glow" href="live.html">Start streaming — it's free</a>
              <a class="btn btn-lg btn-glass" href="browse.html">▶ Watch streams</a>
            </div>
            <ul class="l-checks">
              <li>No software to install</li>
              <li>Works on any phone</li>
              <li>${pct}% fee, only when you earn</li>
            </ul>
          </div>
          <div class="l-hero-visual" aria-hidden="true">
            <div class="glow-orb"></div>
            <div class="browser">
              <div class="browser-bar"><i></i><i></i><i></i><span class="browser-url">🔒 streamhive.app/c/jadebeats</span></div>
              <div class="browser-body">
                <div class="bb-main">
                  <div class="bb-video">
                    <img src="${esc(mockThumb(320, '🎧'))}" alt="">
                    <span class="live-badge">LIVE</span><span class="mock-viewers">👁 128</span>
                    <div class="mock-alert"><strong>💛 Lena donated €5.00</strong><span>Love this stream!</span></div>
                  </div>
                  <div class="bb-info">
                    <span class="avatar avatar-md m1">J</span>
                    <div class="grow"><strong>Late-night lo-fi &amp; chill chat</strong><small>Jade · Music · 1,240 followers</small></div>
                    <span class="bb-btn">♡</span><span class="bb-btn">⭐</span><span class="bb-btn bb-donate">💛 Donate</span>
                  </div>
                </div>
                <div class="bb-chat">
                  <div class="bb-chat-head">Live chat</div>
                  <div><b class="c1">sam</b> this is so smooth 🔥</div>
                  <div><span class="badge tier-gold">Gold</span><b class="c2">mia</b> hi from my phone!</div>
                  <div class="mock-sub">⭐ noah became a Silver supporter!</div>
                  <div><span class="badge badge-streamer">Streamer</span><b class="c3">jade</b> thank you all 💛</div>
                  <div><b class="c1">finn</b> greetings from Ghent 👋</div>
                </div>
              </div>
            </div>
            <div class="phone phone-small">
              <div class="phone-notch"></div>
              <div class="ps-video"><span class="live-badge">LIVE</span><span class="ps-cam">🤳</span><span class="ps-earned">€23.40</span></div>
              <div class="ps-controls"><span>📷</span><span>🔄</span><span>🎙️</span></div>
              <div class="ps-end">End stream</div>
            </div>
            <div class="float-chip chip-a"><span>💛</span><div><strong>+€5.00</strong><small>donation from Lena</small></div></div>
            <div class="float-chip chip-b"><span>⭐</span><div><strong>New supporter</strong><small>Silver · €4.99 / month</small></div></div>
          </div>
        </section>

        <section class="marquee" aria-label="Categories on StreamHive">
          <div class="marquee-track">${marquee}${marquee}</div>
        </section>

        <section class="l-stats" aria-label="StreamHive in numbers">
          <div><strong>0</strong><span>apps to install</span></div>
          <div><strong>3</strong><span>steps to go live</span></div>
          <div><strong>${keep}%</strong><span>of every euro goes to the streamer</span></div>
          <div><strong>1</strong><span>page for stream, chat and support</span></div>
        </section>

        <section class="l-section">
          <span class="kicker">The problem</span>
          <h2 class="l-title">Starting a stream shouldn't feel like a tech project</h2>
          <p class="l-sub">Today, beginners install and configure broadcasting software, need a strong computer, and then glue together separate donation services, chat tools and community pages. StreamHive puts everything in one place.</p>
          <div class="l-compare">
            <div class="compare-card">
              <h3>😩 The usual way</h3>
              <ul class="l-list bad">
                <li>Install and configure OBS: scenes, audio, video and stream keys</li>
                <li>A powerful PC to encode the video</li>
                <li>External donation services — viewers have to leave the stream</li>
                <li>Chat, donations and community spread over different sites</li>
                <li>Mostly one-time tips, no predictable income</li>
              </ul>
            </div>
            <div class="vs" aria-hidden="true">VS</div>
            <div class="compare-card l-highlight">
              <h3>🐝 With StreamHive</h3>
              <ul class="l-list good">
                <li>Press <strong>Go live</strong> in your browser — that's it</li>
                <li>Your phone or any basic laptop is enough</li>
                <li>Donations built in, right next to the stream</li>
                <li>Stream, chat, supporters and community on one page</li>
                <li>Monthly supporters for regular, predictable income</li>
              </ul>
            </div>
          </div>
        </section>

        <section class="l-section l-band">
          <span class="kicker">Our idea</span>
          <h2 class="l-title">How the hive works</h2>
          <p class="l-sub">Every channel on StreamHive is its own little ecosystem.</p>
          <div class="l-hive">
            <div class="hex-card"><div class="hex big">⬢</div><span class="hex-label">Hive</span><h3>Your stream</h3><p class="muted">The place where everything happens: video, chat, alerts and your community.</p></div>
            <div class="hex-card"><div class="hex big">🐝</div><span class="hex-label">Bees</span><h3>Your viewers</h3><p class="muted">They buzz in, chat, follow you and bring their friends along.</p></div>
            <div class="hex-card"><div class="hex big">🍯</div><span class="hex-label">Honey</span><h3>Donations</h3><p class="muted">A quick "thank you" in two taps, shown live on your stream.</p></div>
            <div class="hex-card"><div class="hex big">🌼</div><span class="hex-label">Flowers</span><h3>Regular support</h3><p class="muted">Monthly supporters who keep your hive growing.</p></div>
          </div>
        </section>

        <section class="l-section">
          <span class="kicker">Built for both sides</span>
          <h2 class="l-title">One place for streamers and their fans</h2>
          <div class="side-tabs" role="tablist">
            <button type="button" class="active" data-side="streamers" role="tab" aria-selected="true">🎥 For streamers</button>
            <button type="button" data-side="viewers" role="tab" aria-selected="false">🐝 For viewers</button>
          </div>
          <div class="side-panel" data-panel="streamers">
            <div>
              <ol class="l-steps timeline">
                <li><strong>Create a free account</strong><span>Just a username and a password — 20 seconds.</span></li>
                <li><strong>Choose camera or screen</strong><span>Use your phone's camera, a webcam, or share your screen to stream a game.</span></li>
                <li><strong>Press Go live</strong><span>Your followers are notified. Share your link and watch the support come in.</span></li>
              </ol>
              <a class="btn btn-primary" href="live.html">Start streaming</a>
            </div>
            <ul class="side-features">
              <li><span class="hex-ico">📱</span><div><strong>Browser studio</strong><small>Flip cameras, mute, share your screen with your mic mixed in.</small></div></li>
              <li><span class="hex-ico">💛</span><div><strong>Alerts on stream</strong><small>Donations and new supporters pop up live, with their message.</small></div></li>
              <li><span class="hex-ico">📊</span><div><strong>Creator dashboard</strong><small>Earnings, top supporters and your expected monthly income.</small></div></li>
              <li><span class="hex-ico">🔗</span><div><strong>Share anywhere</strong><small>One link for TikTok, YouTube, Discord, X or a group chat.</small></div></li>
            </ul>
          </div>
          <div class="side-panel" data-panel="viewers" hidden>
            <div>
              <ol class="l-steps timeline">
                <li><strong>Find a stream</strong><span>Browse who's live by category, or open a link a streamer shared.</span></li>
                <li><strong>Watch and chat</strong><span>No app, no download — it plays right in your browser, on any device.</span></li>
                <li><strong>Support in two taps</strong><span>Donate once, or become a monthly supporter — without leaving the stream.</span></li>
              </ol>
              <a class="btn btn-primary" href="browse.html">Browse streams</a>
            </div>
            <ul class="side-features">
              <li><span class="hex-ico">🔔</span><div><strong>Never miss a stream</strong><small>Follow channels and get a notification when they go live.</small></div></li>
              <li><span class="hex-ico">⭐</span><div><strong>Supporter perks</strong><small>Bronze, Silver and Gold badges and a spot on the supporter wall.</small></div></li>
              <li><span class="hex-ico">🔎</span><div><strong>See where your money goes</strong><small>The exact split is shown before you pay, with receipts.</small></div></li>
              <li><span class="hex-ico">💬</span><div><strong>One community page</strong><small>Chat, community posts and supporters, all on the channel.</small></div></li>
            </ul>
          </div>
        </section>

        <section class="calc-section">
          <div class="calc-text">
            <span class="kicker left">Earnings calculator</span>
            <h2 class="l-title left">What could your hive earn?</h2>
            <p class="l-sub left">Move the sliders to estimate your monthly income from supporters and donations. The ${pct}% fee is already taken off.</p>
            <div class="calc-controls">
              <label>Monthly supporters <output id="o-subs">25</output><input type="range" id="r-subs" min="0" max="300" value="25"></label>
              <label>Average tier
                <select id="r-tier">${state.config.tiers.map((t) => `<option value="${t.price}" ${t.id === 'silver' ? 'selected' : ''}>${esc(t.name)} — ${money(t.price)}</option>`).join('')}</select>
              </label>
              <label>Donations per month <output id="o-dons">40</output><input type="range" id="r-dons" min="0" max="500" value="40"></label>
              <label>Average donation <output id="o-avg">€5</output><input type="range" id="r-avg" min="1" max="20" value="5"></label>
            </div>
          </div>
          <div class="calc-result">
            <span class="muted">Estimated monthly income</span>
            <strong id="calc-total">€0</strong>
            <div class="breakdown" id="calc-break"></div>
            <p class="muted small">An estimate for illustration — real income depends on your audience.</p>
          </div>
        </section>

        <section class="l-section" id="l-live-section" hidden>
          <div class="section-head"><h2 class="l-title left h-live"><span class="live-dot"></span>Live on StreamHive right now</h2><a class="btn" href="browse.html">See all</a></div>
          <div class="grid" id="l-live"></div>
        </section>

        <section class="l-fees">
          <div>
            <span class="kicker left">Pricing</span>
            <h2 class="l-title left">A fair, transparent fee</h2>
            <p class="l-sub left">Streaming and watching are free. StreamHive only takes a <strong>${pct}% commission</strong> on donations and supporter payments — lower than typical external donation services, with payment processing included.</p>
            <div class="split" role="img" aria-label="${keep}% to the streamer, ${pct}% to StreamHive">
              <div class="split-streamer" style="flex:${keep}">${keep}% to the streamer</div>
              <div class="split-fee" style="flex:${pct}">${pct}%</div>
            </div>
            <a class="btn" href="#/pricing">See pricing</a>
          </div>
          <div class="receipt">
            <div class="receipt-head"><span>🧾 Example</span><span class="muted small">${money(ex)} donation</span></div>
            <div class="breakdown l-breakdown">
              <div><span>Viewer pays</span><span>${money(ex)}</span></div>
              <div><span>StreamHive fee (${pct}%)</span><span>−${money(feeOf(ex))}</span></div>
              <div class="strong"><span>Streamer receives</span><span class="accent">${money(ex - feeOf(ex))}</span></div>
            </div>
            <p class="muted small">Shown to every viewer before they pay.</p>
          </div>
        </section>

        <section class="l-section">
          <span class="kicker">FAQ</span>
          <h2 class="l-title">Questions</h2>
          ${faq([
            ['Do I need OBS or a gaming PC?', '<p>No. StreamHive runs in your browser. Your phone or a basic laptop is enough to go live.</p>'],
            ['Can I stream games?', '<p>Yes. On a computer, choose <strong>Share screen</strong> in the studio to stream a game window or your whole screen, with your microphone mixed in. Phones can stream with their camera.</p>'],
            ['How much does StreamHive cost?', `<p>Streaming and watching are free. We take ${pct}% of donations and supporter payments, payment processing included. <a class="accent" href="#/pricing">See pricing</a>.</p>`],
            ['Can supporters cancel their monthly support?', '<p>Yes, at any time from <strong>My support</strong>. They keep their perks until the end of the month they paid for, and are never charged again after cancelling.</p>'],
            ['Is this the final product?', '<p>This is a working prototype. Payments are simulated: no real money is charged. At launch, payments will be handled by a licensed payment provider.</p>'],
          ])}
          <p class="center"><a class="accent" href="#/help">More answers in the help center →</a></p>
        </section>

        <section class="l-cta">
          <div class="honeycomb" aria-hidden="true"></div>
          <div class="cta-bee" aria-hidden="true">🐝</div>
          <h2>Your hive is waiting.</h2>
          <p>Go live in under a minute — from the device in your pocket.</p>
          <div class="row center"><a class="btn btn-primary btn-lg btn-glow" href="live.html">Start streaming</a><a class="btn btn-lg btn-glass" href="browse.html">Watch streams</a></div>
        </section>
      </div>`;

    // For streamers / for viewers tabs
    $$('.side-tabs button').forEach((b) => b.addEventListener('click', () => {
      $$('.side-tabs button').forEach((x) => {
        x.classList.toggle('active', x === b);
        x.setAttribute('aria-selected', String(x === b));
      });
      $$('.side-panel').forEach((p) => { p.hidden = p.dataset.panel !== b.dataset.side; });
    }));

    // Earnings calculator
    const calc = () => {
      const subs = Number($('#r-subs').value);
      const price = Number($('#r-tier').value);
      const dons = Number($('#r-dons').value);
      const avg = Number($('#r-avg').value) * 100;
      const subNet = subs * (price - feeOf(price));
      const donNet = dons * (avg - feeOf(avg));
      $('#o-subs').textContent = String(subs);
      $('#o-dons').textContent = String(dons);
      $('#o-avg').textContent = money(avg).replace(/[.,]00(?=\D*$)/, '');
      $('#calc-total').textContent = money(subNet + donNet);
      $('#calc-break').innerHTML = `
        <div><span>${subs} supporters × ${money(price)}</span><span>${money(subNet)}</span></div>
        <div><span>${dons} donations × ${money(avg)}</span><span>${money(donNet)}</span></div>
        <div class="strong"><span>You receive (after ${pct}% fee)</span><span class="accent">${money(subNet + donNet)}</span></div>`;
    };
    ['#r-subs', '#r-tier', '#r-dons', '#r-avg'].forEach((s) => $(s).addEventListener('input', calc));
    calc();

    try {
      const r = await api('/streams');
      if (!ctx.alive() || !r.streams.length) return;
      $('#l-live').innerHTML = r.streams.slice(0, 4).map(streamCard).join('');
      $('#l-live-section').hidden = false;
    } catch { /* live strip is optional */ }
  }

  function guestButtons() {
    $('#g-register').addEventListener('click', () => authModal('register'));
    $('#g-login').addEventListener('click', () => authModal('login'));
  }

  async function pageFollowingGuest(ctx) {
    app.innerHTML = `
      <section class="guest-hero">
        <div class="guest-text">
          <span class="eyebrow">Following</span>
          <h1>Never miss a stream from the creators you love</h1>
          <p class="lead">Follow channels to keep them together in one place. Live channels are always on top, and you get a notification the moment they go live.</p>
          <ul class="l-list good">
            <li>All your favourite streamers on one page</li>
            <li>Instant "now live" notifications</li>
            <li>Free — you only need an account</li>
          </ul>
          <div class="row"><button class="btn btn-primary btn-lg" id="g-register" type="button">Create free account</button><button class="btn btn-lg" id="g-login" type="button">Log in</button></div>
        </div>
        <div class="guest-visual" aria-hidden="true">
          <div class="mock-panel">
            <div class="mock-toast">🔔 <strong>Jade</strong> is live: Late-night lo-fi &amp; chat</div>
            <div class="mock-row"><span class="avatar avatar-md m1">J</span><div class="grow"><strong>Jade</strong><small>Late-night lo-fi &amp; chat · Music</small></div><span class="live-badge">LIVE</span></div>
            <div class="mock-row"><span class="avatar avatar-md m2">K</span><div class="grow"><strong>Kai plays</strong><small>Ranked grind to diamond · Gaming</small></div><span class="live-badge">LIVE</span></div>
            <div class="mock-row dim"><span class="avatar avatar-md m3">S</span><div class="grow"><strong>Sara cooks</strong><small>Offline · last live yesterday</small></div></div>
            <div class="mock-row dim"><span class="avatar avatar-md m4">M</span><div class="grow"><strong>Milo draws</strong><small>Offline</small></div></div>
          </div>
        </div>
      </section>
      <section class="section" id="g-discover-section" hidden>
        <div class="section-head"><h2>Channels you could follow</h2><a class="btn" href="browse.html">Browse all</a></div>
        <div class="channel-grid" id="g-discover"></div>
      </section>`;
    guestButtons();
    try {
      const r = await api('/channels');
      if (!ctx.alive() || !r.channels.length) return;
      $('#g-discover').innerHTML = r.channels.slice(0, 8).map(channelCard).join('');
      $('#g-discover-section').hidden = false;
    } catch { /* optional */ }
  }

  function pageStudioGuest() {
    const keep = 100 - feePct();
    app.innerHTML = `
      <section class="guest-hero">
        <div class="guest-text">
          <span class="eyebrow">Go live</span>
          <h1>Your studio is right here in the browser</h1>
          <p class="lead">No OBS, no downloads, no powerful PC. Create a free account and go live from this page — on your phone or your computer — in under a minute.</p>
          <ol class="l-steps">
            <li><strong>Create a free account</strong><span>A username and a password, that's all.</span></li>
            <li><strong>Pick camera or screen</strong><span>Phone camera, webcam, or share your screen to stream a game.</span></li>
            <li><strong>Press Go live</strong><span>Your followers get notified and can support you right away.</span></li>
          </ol>
          <div class="row"><button class="btn btn-primary btn-lg" id="g-register" type="button">Create free account</button><button class="btn btn-lg" id="g-login" type="button">Log in</button></div>
          <p class="muted small">Viewers support you with donations and monthly support — you keep ${keep}% of every euro.</p>
          <p class="small"><a class="accent" href="presets.html">✨ Browse stream presets</a> — ready-made setups for chatting, gaming, music and more.</p>
        </div>
        <div class="guest-visual" aria-hidden="true">
          <div class="mock-studio">
            <div class="mock-studio-video">
              <span class="live-badge">LIVE</span><span class="mock-timer">12:48 · 👁 37</span>
              <div class="mock-face">🎨</div>
              <span class="mock-earned">Earned this stream: €23.40</span>
            </div>
            <div class="mock-controls"><span class="on">📷<small>Camera</small></span><span>🖥️<small>Screen</small></span><span>🔄<small>Flip</small></span><span>🎙️<small>Mic on</small></span></div>
            <div class="mock-field">Sketching fantasy maps — come hang out</div>
            <div class="mock-golive">End stream</div>
          </div>
        </div>
      </section>
      <section class="section">
        <div class="l-features three">
          <div class="feature"><div class="feature-ico hex-ico">📱</div><h3>Camera or screen</h3><p class="muted">Use your phone's front or back camera, a webcam, or share your screen with your microphone mixed in.</p></div>
          <div class="feature"><div class="feature-ico hex-ico">💛</div><h3>Alerts and chat</h3><p class="muted">Donations and new supporters pop up on your stream, and you can chat with viewers from the studio.</p></div>
          <div class="feature"><div class="feature-ico hex-ico">📊</div><h3>See what you earn</h3><p class="muted">Live earnings while streaming, and a dashboard with your supporters and monthly income.</p></div>
        </div>
      </section>`;
    guestButtons();
  }

  async function pageChannel(ctx, rawName) {
    const username = rawName.toLowerCase();
    app.innerHTML = '<div class="loading">Loading channel…</div>';
    let ch;
    try {
      ch = await api(`/channels/${encodeURIComponent(username)}`);
    } catch (e) {
      if (ctx.alive()) app.innerHTML = `<section class="empty-page"><h1>Channel not found</h1><p class="muted">${esc(e.message)}</p><a class="btn btn-primary" href="browse.html">Back to browse</a></section>`;
      return;
    }
    if (!ctx.alive()) return;

    app.innerHTML = `
      <div class="watch">
        <div class="watch-main">
          <div class="player" id="player">
            <video id="video" playsinline autoplay muted></video>
            <video id="cam-bubble" class="cam-bubble" playsinline autoplay muted hidden></video>
            <div class="player-overlay" id="overlay"></div>
            <div class="alert-layer" id="alerts"></div>
            <div class="player-bar" id="player-bar">
              <span class="live-badge" id="pb-live" hidden>LIVE</span>
              <span id="pb-viewers"></span>
              <span id="pb-uptime" class="muted"></span>
              <span class="grow"></span>
              <button class="icon-btn" id="pb-unmute" type="button" hidden>🔇 Tap to unmute</button>
              <button class="icon-btn" id="pb-full" type="button" aria-label="Full screen">⛶</button>
            </div>
          </div>
          <div id="channel-info"></div>
          <div class="tabs" role="tablist">
            <button class="tab active" data-tab="about">About</button>
            <button class="tab" data-tab="community">Community</button>
            <button class="tab" data-tab="supporters">Supporters</button>
          </div>
          <div id="tab-panel" class="tab-panel"></div>
        </div>
        <aside class="chat" id="chat"></aside>
      </div>`;

    const video = $('#video');
    const overlay = $('#overlay');
    const unmute = $('#pb-unmute');
    let liveNow = ch.live;
    let connected = false;
    let tab = 'about';
    let connectTimer = null;

    const isMine = () => !!(state.me && state.me.id === ch.user.id);

    function setOverlay(html) {
      overlay.innerHTML = html;
      overlay.hidden = !html;
    }
    function renderBar() {
      $('#pb-live').hidden = !liveNow;
      $('#pb-viewers').textContent = liveNow ? plural(liveNow.viewers, 'viewer') : '';
      $('#pb-uptime').textContent = liveNow ? duration(Date.now() - liveNow.startedAt) : '';
      unmute.hidden = !liveNow || !connected || !video.muted || (isMine() && studio.live) || !!state.mock;
    }
    function setPlayer() {
      clearTimeout(connectTimer);
      if (!liveNow) {
        connected = false;
        viewer.close();
        video.srcObject = null;
        setOverlay(`<div class="overlay-box">${avatar(ch.user, 'avatar-xl')}<p><strong>${esc(ch.user.displayName)} is offline.</strong></p><p class="muted">${isMine() ? 'Ready when you are.' : 'Follow to get notified when they go live — or support them now, even while they\'re offline.'}</p>${isMine() ? '<a class="btn btn-primary" href="live.html">Go live</a>' : '<button class="btn btn-primary" id="ov-donate" type="button">💛 Send a donation</button>'}</div>`);
        const ovDonate = $('#ov-donate');
        if (ovDonate) ovDonate.addEventListener('click', () => (state.me ? donateModal(ch.user, null, { offline: true }) : loginFor({ type: 'donate', username })));
      } else if (isMine() && studio.live) {
        connected = true;
        video.srcObject = studio.videoTrack ? new MediaStream([studio.videoTrack]) : null;
        video.play().catch(() => {});
        setOverlay('');
        toast('This is your own stream. Viewers see the same picture.');
      } else if (state.mock) {
        // Demo mode: an animated sample picture instead of a real video connection.
        connected = true;
        setOverlay(`<div class="demo-stream"><img src="${esc(liveNow.thumbnail || '')}" alt=""><span class="demo-label">Demo stream · sample content</span></div>`);
      } else if (!connected) {
        setOverlay('<div class="overlay-box"><div class="spinner"></div><p>Connecting to the stream…</p></div>');
        connectTimer = setTimeout(() => {
          if (!connected && liveNow) {
            setOverlay('<div class="overlay-box"><p>Still connecting…</p><p class="muted small">The streamer\'s connection may be slow or blocked by a network firewall.</p><button class="btn btn-primary" id="retry" type="button">Try again</button></div>');
            $('#retry').addEventListener('click', retry);
          }
        }, 15000);
      }
      renderBar();
    }
    function retry() {
      connected = false;
      viewer.close();
      setPlayer();
      joinRoom(username).catch((e) => toast(e.message, 'error'));
    }

    function renderInfo() {
      const l = liveNow;
      const sub = ch.subscription;
      const subLabel = sub && sub.active ? `${sub.tierName} supporter ✓` : 'Subscribe';
      const actions = isMine()
        ? `<a class="btn btn-primary" href="live.html">${studio.live ? 'Open studio' : 'Go live'}</a><a class="btn" href="#/dashboard">Dashboard</a>`
        : `<button class="btn ${ch.following ? '' : 'btn-outline'}" id="follow-btn" type="button">${ch.following ? '♥ Following' : '♡ Follow'}</button>
           <button class="btn ${sub && sub.active ? '' : 'btn-outline'}" id="sub-btn" type="button">⭐ ${esc(subLabel)}</button>
           <button class="btn btn-primary" id="donate-btn" type="button">💛 Donate</button>`;
      const share = '<button class="btn btn-ghost" id="share-btn" type="button" aria-label="Share channel">🔗 Share</button>';
      $('#channel-info').innerHTML = `
        <div class="channel-info">
          ${avatar(ch.user, 'avatar-lg')}
          <div class="grow">
            <h1 class="channel-title">${esc(l ? l.title : ch.user.displayName)}</h1>
            <div class="muted">
              <a href="#/c/${esc(ch.user.username)}" class="strong">${l ? esc(ch.user.displayName) : `@${esc(ch.user.username)}`}</a> ${proBadge(ch.user)}
              ${l ? ` · <span class="tag">${esc(l.category)}</span>` : ''}
              · ${plural(ch.followers, 'follower')} · ${plural(ch.supporters.length, 'supporter')}
            </div>
          </div>
          <div class="actions">${actions}${share}</div>
        </div>`;
      $('#share-btn').addEventListener('click', () => shareChannel(ch.user));
      if (isMine()) return;
      $('#follow-btn').addEventListener('click', () => (state.me ? toggleFollow() : loginFor({ type: 'follow', username })));
      $('#sub-btn').addEventListener('click', () => (state.me ? openSubscribe() : loginFor({ type: 'subscribe', username })));
      $('#donate-btn').addEventListener('click', () => (state.me ? donateModal(ch.user, null, { offline: !liveNow }) : loginFor({ type: 'donate', username })));
    }

    async function toggleFollow() {
      try {
        const r = ch.following
          ? await api(`/follows/${encodeURIComponent(username)}`, { method: 'DELETE' })
          : await api('/follows', { method: 'POST', body: { streamer: username } });
        if (!ctx.alive()) return;
        ch.following = r.following;
        ch.followers = r.followers;
        renderInfo();
        if (r.following) toast(`You'll be notified when ${ch.user.displayName} goes live.`, 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    async function openSubscribe() {
      await refresh(); // make sure the subscription status is current
      if (!ctx.alive() || isMine()) return;
      subscribeModal(ch.user, ch.subscription, refresh);
    }

    function renderTab() {
      $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
      const panel = $('#tab-panel');
      if (tab === 'about') {
        panel.innerHTML = `
          <div class="card pad">
            <h3>About ${esc(ch.user.displayName)}</h3>
            <p class="pre">${ch.user.bio ? esc(ch.user.bio) : '<span class="muted">No bio yet.</span>'}</p>
            <p class="muted small">Streaming on StreamHive since ${fmtDate(ch.user.createdAt)}.</p>
            ${isMine() ? '' : '<button class="link small report-link" id="report-btn" type="button">⚑ Report this channel</button>'}
          </div>`;
        const rep = $('#report-btn');
        if (rep) rep.addEventListener('click', () => reportModal(ch.user));
      } else if (tab === 'supporters') {
        panel.innerHTML = `
          <div class="card pad">
            <h3>Supporter wall</h3>
            ${ch.supporters.length
              ? `<div class="supporters">${ch.supporters.map((s) => `<a class="supporter" href="#/c/${esc(s.user.username)}">${avatar(s.user)}<span>${esc(s.user.displayName)}</span>${tierBadge(s.tier)}</a>`).join('')}</div>`
              : `<p class="muted">No monthly supporters yet.${isMine() ? '' : ' Be the first!'}</p>`}
          </div>`;
      } else {
        const canPost = !!state.me;
        panel.innerHTML = `
          <div class="card pad">
            <h3>Community</h3>
            ${canPost
              ? `<form class="post-form" id="post-form"><textarea name="text" maxlength="500" rows="2" placeholder="${isMine() ? 'Share an update with your community…' : `Write something to ${esc(ch.user.displayName)}'s community…`}" required></textarea><button class="btn btn-primary" type="submit">Post</button></form>`
              : '<p class="muted">Log in to join the conversation.</p>'}
            <div class="posts">${ch.posts.length ? ch.posts.map((p) => `
              <article class="post ${p.author.id === ch.user.id ? 'post-owner' : ''}">
                ${avatar(p.author)}
                <div class="grow">
                  <div><a class="strong" href="#/c/${esc(p.author.username)}">${esc(p.author.displayName)}</a>${p.author.id === ch.user.id ? ' <span class="badge badge-streamer">Streamer</span>' : ''} <span class="muted small">${ago(p.createdAt)}</span></div>
                  <p class="pre">${esc(p.text)}</p>
                </div>
                ${state.me && (state.me.id === p.author.id || isMine()) ? `<button class="icon-btn" data-del="${esc(p.id)}" type="button" aria-label="Delete post">✕</button>` : ''}
              </article>`).join('') : '<p class="muted">No posts yet.</p>'}</div>
          </div>`;
        const form = $('#post-form');
        if (form) {
          form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const textarea = $('textarea', form);
            const value = textarea.value.trim();
            if (!value) return;
            setBusy(form, true);
            try {
              await api('/posts', { method: 'POST', body: { streamer: username, text: value } });
              await refresh();
            } catch (err) {
              toast(err.message, 'error');
              setBusy(form, false);
            }
          });
        }
        $$('[data-del]', panel).forEach((b) => b.addEventListener('click', async () => {
          if (!window.confirm('Delete this post?')) return;
          try {
            await api(`/posts/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' });
            await refresh();
          } catch (err) {
            toast(err.message, 'error');
          }
        }));
      }
    }
    $$('.tab').forEach((t) => t.addEventListener('click', () => {
      tab = t.dataset.tab;
      renderTab();
    }));

    async function refresh() {
      try {
        const r = await api(`/channels/${encodeURIComponent(username)}`);
        if (!ctx.alive()) return;
        ch = r;
        renderInfo();
        renderTab();
      } catch { /* keep current view */ }
    }

    unmute.addEventListener('click', () => {
      video.muted = false;
      video.play().catch(() => {});
      renderBar();
    });
    $('#pb-full').addEventListener('click', () => {
      const player = $('#player');
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else if (player.requestFullscreen) player.requestFullscreen().catch(() => {});
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    });

    viewer.attach(video, {
      onTrack() {
        if (!liveNow) return;
        connected = true;
        clearTimeout(connectTimer);
        setOverlay('');
        renderBar();
      },
      onState(s) {
        if (s === 'connected') {
          connected = true;
          clearTimeout(connectTimer);
          setOverlay('');
        } else if ((s === 'failed' || s === 'disconnected') && liveNow) {
          connected = false;
          setOverlay('<div class="overlay-box"><p>Connection to the stream was interrupted.</p><button class="btn btn-primary" id="retry" type="button">Reconnect</button></div>');
          $('#retry').addEventListener('click', retry);
        }
        renderBar();
      },
    }, $('#cam-bubble'));

    const chat = mountChat($('#chat'), username);
    renderInfo();
    renderTab();
    setPlayer();

    const pending = state.pendingAction;
    if (pending && pending.username === username && state.me) {
      state.pendingAction = null;
      if (!isMine()) {
        if (pending.type === 'donate') donateModal(ch.user, null, { offline: !liveNow });
        else if (pending.type === 'subscribe') subscribeModal(ch.user, ch.subscription, refresh);
        else if (pending.type === 'follow' && !ch.following) toggleFollow();
      }
    }

    ctx.cleanup(on('live', (d) => {
      if (d.streamer.username !== username) return;
      const wasLive = !!liveNow;
      liveNow = d;
      if (!wasLive) {
        connected = false;
        setPlayer();
      }
      renderInfo();
      renderBar();
    }));
    ctx.cleanup(on('offline', (d) => {
      if (d.streamer !== username) return;
      liveNow = null;
      setPlayer();
      renderInfo();
    }));
    ctx.cleanup(on('viewers', (d) => {
      if (d.streamer !== username || !liveNow) return;
      liveNow.viewers = d.viewers;
      renderBar();
    }));
    ctx.cleanup(on('alert', (d) => {
      if (d.streamer !== username) return;
      showAlert($('#alerts'), d.alert);
      if (d.alert.kind === 'subscription') refresh();
    }));
    const tick = setInterval(renderBar, 1000);

    ctx.cleanup(() => {
      clearInterval(tick);
      clearTimeout(connectTimer);
      chat.destroy();
      viewer.detach();
      leaveRoom();
    });

    try {
      const room = await joinRoom(username);
      if (!ctx.alive()) return;
      chat.load(room.chat);
      const wasLive = !!liveNow;
      liveNow = room.live;
      if (wasLive !== !!liveNow) {
        setPlayer();
        renderInfo();
      }
      renderBar();
    } catch (e) {
      if (ctx.alive()) toast(e.message, 'error');
    }
  }

  async function pageStudio(ctx) {
    if (!state.me) return pageStudioGuest(ctx);
    const me = state.me;
    const cats = state.config.categories;
    const canScreen = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

    app.innerHTML = `
      <div class="watch studio">
        <div class="watch-main">
          <div class="player" id="player">
            <video id="preview" playsinline autoplay muted></video>
            <video id="preview-bubble" class="cam-bubble" playsinline autoplay muted hidden></video>
            <div class="player-overlay" id="overlay"></div>
            <div class="alert-layer" id="alerts"></div>
            <div class="player-bar">
              <span class="live-badge" id="st-live" hidden>LIVE</span>
              <span class="muted" id="st-offline">Preview — not live yet</span>
              <span class="source-pill" id="st-source" hidden></span>
              <span id="st-uptime"></span>
              <span id="st-viewers"></span>
              <span class="grow"></span>
              <span id="st-earned" class="earned"></span>
            </div>
          </div>
          <div id="preset-slot"></div>
          <div class="controls" id="controls">
            <button class="ctrl" type="button" data-act="camera">📷<span>Camera</span></button>
            ${canScreen ? '<button class="ctrl" type="button" data-act="screen">🖥️<span>Screen</span></button>' : ''}
            ${canScreen ? '<button class="ctrl" type="button" data-act="bubble" hidden>🙂<span>Cam bubble</span></button>' : ''}
            <button class="ctrl" type="button" data-act="flip" hidden>🔄<span>Flip</span></button>
            <button class="ctrl" type="button" data-act="mic">🎙️<span>Mic</span></button>
            <button class="ctrl" type="button" data-act="video">🎥<span>Video</span></button>
          </div>
          <div class="share-tip" id="share-tip" hidden>
            <strong>🖥️ You're sharing your screen.</strong>
            <span>Tips: share a single window or tab instead of your whole screen, and tick <em>Share audio</em> so viewers hear your game or music. Don't share this StreamHive tab itself — that creates an endless mirror. Turn on <strong>🙂 Cam bubble</strong> to show your face in the corner.</span>
          </div>
          ${state.mock ? `<div class="demo-live-note">🧪 <span><strong>Demo mode:</strong> you opened StreamHive as a file, so going live is simulated with sample viewers. To let real people watch your camera or screen — on any device — start the server with <code>npm start</code> and open <strong>http://localhost:3000/live.html</strong>.</span></div>` : ''}
          <form class="card pad form" id="live-form" novalidate>
            <div class="form-row">
              <label class="grow">Stream title<input name="title" maxlength="100" required placeholder="What are you streaming today?"></label>
              <label>Category<select name="category">${cats.map((c) => `<option>${esc(c)}</option>`).join('')}</select></label>
            </div>
            <p class="form-error" hidden></p>
            <div class="row" id="live-actions"></div>
          </form>
          <div class="card pad tips">
            <h3>Going live in 3 steps</h3>
            <ol>
              <li>Turn on your <strong>camera</strong>${canScreen ? ' or share your <strong>screen</strong> (great for games)' : ''}.</li>
              <li>Give your stream a title and pick a category.</li>
              <li>Press <strong>Go live</strong>. Your followers get notified instantly.</li>
            </ol>
            <p class="muted small">Viewers connect directly to your device, so a stable Wi-Fi connection gives the best quality. Donations and subscriptions show up as alerts on your stream and in your <a href="#/dashboard">dashboard</a>. Your channel: <a href="#/c/${esc(me.username)}">/c/${esc(me.username)}</a></p>
            <button class="btn" type="button" id="studio-share">🔗 Share your channel link</button>
            <p class="muted small quality-note">${me.pro ? '👑 Hive Pro: you stream in HD (up to 1080p).' : 'You stream in standard quality (up to 720p). <a class="accent" href="premium.html">Get HD with Hive Pro</a>'}</p>
          </div>
        </div>
        <aside class="chat" id="chat"></aside>
      </div>`;

    const preview = $('#preview');
    const overlay = $('#overlay');
    const form = $('#live-form');
    const titleInput = $('[name=title]', form);
    const catSelect = $('[name=category]', form);
    titleInput.value = studio.live ? studio.title : storage.get('sh_last_title') || '';
    catSelect.value = studio.live ? studio.category : storage.get('sh_last_category') || cats[0];
    if (!catSelect.value) catSelect.value = cats[0];

    studio.previewEl = preview;
    studio.previewBubbleEl = $('#preview-bubble');
    studio.attachPreview();

    // Stream preset chosen on the presets page
    let preset = presetById(storage.get('sh_preset'));
    if (preset && !studio.live) {
      titleInput.value = preset.title;
      catSelect.value = preset.category;
      if (!studio.hasMedia()) studio.facing = preset.facing;
      studio.setMicProfile(preset.mic);
    }
    function renderPresetSlot() {
      const slot = $('#preset-slot');
      if (!slot) return;
      if (!preset) {
        slot.innerHTML = '<a class="preset-link" href="presets.html">✨ Not sure how to set up? <strong>Browse stream presets</strong> →</a>';
        return;
      }
      const screenWanted = preset.source === 'screen';
      const startLabel = screenWanted && canScreen ? '🖥️ Share screen' : preset.facing === 'environment' ? '📷 Start back camera' : '🤳 Start camera';
      slot.innerHTML = `
        <div class="preset-banner" style="--h:${preset.hue}">
          <span class="preset-banner-emoji">${preset.emoji}</span>
          <div class="grow">
            <strong>Preset: ${esc(preset.name)}</strong>
            <small>${presetSource(preset)} · ${presetMic(preset)} · ${esc(preset.category)}${preset.hd && !me.pro ? ' · <a class="accent" href="premium.html">HD with Hive Pro</a>' : ''}${screenWanted && !canScreen ? ' · screen sharing needs a computer, so your camera is used' : ''}</small>
          </div>
          ${studio.hasMedia() ? '' : `<button class="btn btn-primary btn-small" type="button" id="preset-start">${startLabel}</button>`}
          <a class="btn btn-small btn-ghost" href="presets.html">Change</a>
          <button class="icon-toggle" type="button" id="preset-clear" title="Remove preset" aria-label="Remove preset">✕</button>
        </div>`;
      const start = $('#preset-start');
      if (start) start.addEventListener('click', () => run(() => (screenWanted && canScreen ? studio.useScreen() : studio.useCamera())));
      $('#preset-clear').addEventListener('click', () => {
        storage.set('sh_preset', null);
        preset = null;
        studio.setMicProfile('voice');
        renderPresetSlot();
      });
    }
    renderPresetSlot();

    async function run(fn) {
      try {
        await fn();
      } catch (e) {
        toast(e.message, 'error');
      }
    }

    function renderOverlay() {
      if (studio.hasMedia()) {
        if (!studio.videoTrack) overlay.innerHTML = '<div class="overlay-box"><p>🎙️ Audio only</p><p class="muted small">No camera found. Viewers will hear you.</p></div>';
        else if (!studio.videoOn) overlay.innerHTML = '<div class="overlay-box"><p>Video is paused</p><p class="muted small">Viewers see a black screen.</p></div>';
        else overlay.innerHTML = '';
      } else {
        overlay.innerHTML = `
          <div class="overlay-box">
            <p><strong>Choose what to stream</strong></p>
            <div class="row center">
              <button class="btn btn-primary" type="button" id="ov-camera">📷 Use camera</button>
              ${canScreen ? '<button class="btn" type="button" id="ov-screen">🖥️ Share screen</button>' : ''}
            </div>
            <p class="muted small">Your browser will ask for permission.</p>
          </div>`;
        $('#ov-camera').addEventListener('click', () => run(() => studio.useCamera()));
        const sc = $('#ov-screen');
        if (sc) sc.addEventListener('click', () => run(() => studio.useScreen()));
      }
      overlay.hidden = !overlay.innerHTML;
    }

    function renderControls() {
      $$('#controls .ctrl').forEach((b) => {
        const act = b.dataset.act;
        if (act === 'camera') b.classList.toggle('active', studio.source === 'camera');
        if (act === 'screen') {
          b.classList.toggle('active', studio.source === 'screen');
          $('span', b).textContent = studio.source === 'screen' ? 'Stop sharing' : 'Screen';
        }
        if (act === 'bubble') {
          b.hidden = studio.source !== 'screen';
          b.classList.toggle('active', studio.bubbleOn);
          $('span', b).textContent = studio.bubbleOn ? 'Bubble on' : 'Cam bubble';
        }
        if (act === 'flip') b.hidden = !(studio.source === 'camera' && studio.videoInputs > 1);
        if (act === 'mic') {
          b.classList.toggle('off', !studio.micOn);
          b.disabled = !studio.micTrack;
          $('span', b).textContent = !studio.micTrack ? 'No mic' : studio.micOn ? 'Mic on' : 'Muted';
        }
        if (act === 'video') {
          b.classList.toggle('off', !studio.videoOn);
          b.disabled = !studio.videoTrack;
          $('span', b).textContent = studio.videoOn ? 'Video on' : 'Video off';
        }
      });
      const actions = $('#live-actions');
      actions.innerHTML = studio.live
        ? '<button class="btn" type="submit">Update title</button><button class="btn btn-danger" type="button" id="end-btn">End stream</button>'
        : `<button class="btn btn-primary btn-lg" type="submit" ${studio.hasMedia() ? '' : 'disabled'}>● Go live</button>`;
      const end = $('#end-btn');
      if (end) {
        end.addEventListener('click', async () => {
          if (!window.confirm('End your stream?')) return;
          await studio.end();
          toast('Stream ended. Great job!', 'success');
        });
      }
      renderOverlay();
      renderStats();
    }

    function renderSource() {
      const pill = $('#st-source');
      if (pill) {
        pill.hidden = !studio.source;
        pill.textContent = studio.source === 'screen' ? `🖥️ Screen${studio.bubbleOn ? ' + camera' : ''}` : '📷 Camera';
      }
      const tip = $('#share-tip');
      if (tip) tip.hidden = studio.source !== 'screen';
    }
    function renderStats() {
      renderSource();
      $('#st-live').hidden = !studio.live;
      $('#st-offline').hidden = studio.live;
      $('#st-uptime').textContent = studio.live ? duration(Date.now() - studio.startedAt) : '';
      $('#st-viewers').textContent = studio.live ? `👁 ${plural(studio.viewers, 'viewer')}` : '';
      $('#st-earned').textContent = studio.live ? `Earned this stream: ${money(studio.earned)}` : '';
    }

    $('#controls').addEventListener('click', (e) => {
      const b = e.target.closest('.ctrl');
      if (!b || b.disabled) return;
      const act = b.dataset.act;
      if (act === 'camera') run(() => studio.useCamera());
      else if (act === 'screen') run(() => (studio.source === 'screen' ? studio.useCamera() : studio.useScreen()));
      else if (act === 'bubble') run(() => studio.toggleBubble());
      else if (act === 'flip') run(() => studio.flip());
      else if (act === 'mic') studio.toggleMic();
      else if (act === 'video') studio.toggleVideo();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = titleInput.value.trim();
      const category = catSelect.value;
      showFormError(form, '');
      if (!title) {
        showFormError(form, 'Give your stream a title so people know what it is about.');
        titleInput.focus();
        return;
      }
      storage.set('sh_last_title', title);
      storage.set('sh_last_category', category);
      setBusy(form, true);
      try {
        if (studio.live) {
          await studio.update(title, category);
          toast('Stream info updated.', 'success');
        } else {
          await studio.goLive(title, category);
          toast("You're live! Share your channel link with your audience.", 'success');
        }
      } catch (err) {
        showFormError(form, err.message);
      } finally {
        setBusy(form, false);
        renderControls();
      }
    });

    const chat = mountChat($('#chat'), me.username);
    $('#studio-share').addEventListener('click', () => shareChannel(me));
    renderControls();

    ctx.cleanup(on('studio', renderControls));
    ctx.cleanup(on('studio', renderPresetSlot));
    ctx.cleanup(on('studio-stats', renderStats));
    ctx.cleanup(on('alert', (d) => {
      if (d.streamer === me.username) showAlert($('#alerts'), d.alert);
    }));
    const tick = setInterval(renderStats, 1000);
    ctx.cleanup(() => {
      clearInterval(tick);
      chat.destroy();
      if (studio.previewEl === preview) studio.previewEl = null;
      studio.previewBubbleEl = null;
      if (!studio.live) {
        studio.stopMedia();
        leaveRoom();
      }
    });

    try {
      const room = await joinRoom(me.username);
      if (ctx.alive()) chat.load(room.chat);
    } catch (e) {
      if (ctx.alive()) toast(e.message, 'error');
    }
  }

  async function pageDashboard(ctx) {
    if (!state.me) return loginWall('Creator dashboard', 'Log in to see your earnings and supporters.');
    app.innerHTML = '<div class="loading">Loading dashboard…</div>';
    let d;
    try {
      d = await api('/me/dashboard');
    } catch (e) {
      if (ctx.alive()) app.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      return;
    }
    if (!ctx.alive()) return;
    const t = d.totals;
    const feePct = Math.round((d.feeRate || state.config.platformFee) * 100);
    const isProNow = !!(d.premium && d.premium.active);
    const an = d.analytics;
    const week = an ? [1, 2, 3, 4, 5, 6, 0].map((i) => [['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][i], an.byDay[i]]) : [];
    const maxDay = Math.max(1, ...week.map(([, v]) => v));
    const proSection = isProNow && an ? `
        <div class="card pad pro-analytics">
          <div class="section-head"><h3>👑 Pro analytics</h3><span class="muted small">Your fee: ${feePct}%</span></div>
          <div class="stats">
            <div class="stat"><span class="stat-label">Average donation</span><span class="stat-value">${money(an.averageDonation)}</span><span class="muted small">${plural(an.donationCount, 'donation')}</span></div>
            <div class="stat"><span class="stat-label">Unique supporters</span><span class="stat-value">${an.uniqueSupporters}</span></div>
            <div class="stat"><span class="stat-label">Best day to stream</span><span class="stat-value">${esc(an.bestDay || '—')}</span><span class="muted small">most support received</span></div>
          </div>
          <div class="day-bars" aria-label="Support per weekday">${week.map(([day, v]) => `<div class="day-bar"><span class="bar" style="height:${Math.max(4, Math.round((v / maxDay) * 100))}%" title="${day}: ${money(v)}"></span><small>${day}</small></div>`).join('')}</div>
        </div>` : `
        <div class="pro-upsell">
          <div><strong>👑 Unlock Pro analytics, HD streaming and a ${Math.round(state.config.pro.fee * 100)}% fee</strong><p class="muted small">Hive Pro is ${money(state.config.pro.price)} per month. Cancel anytime.</p></div>
          <a class="btn btn-primary" href="premium.html">See Hive Pro</a>
        </div>`;
    app.innerHTML = `
      <section class="section">
        <div class="section-head">
          <h1>Creator dashboard</h1>
          <a class="btn btn-primary" href="live.html">${d.live ? 'Open studio (live)' : 'Go live'}</a>
        </div>
        <div class="stats">
          <div class="stat"><span class="stat-label">Total earned (net)</span><span class="stat-value">${money(t.net)}</span><span class="muted small">${money(t.gross)} gross · ${money(t.fees)} fees (${feePct}%)</span></div>
          <div class="stat"><span class="stat-label">This month (net)</span><span class="stat-value">${money(t.thisMonthNet)}</span></div>
          <div class="stat"><span class="stat-label">Expected monthly from supporters</span><span class="stat-value">${money(t.expectedMonthlyNet)}</span><span class="muted small">${plural(t.activeSubscribers, 'active supporter')}</span></div>
          <div class="stat"><span class="stat-label">Followers</span><span class="stat-value">${t.followers}</span></div>
        </div>
        ${proSection}
        <div class="two-col">
          <div class="card">
            <h3 class="pad-x">Recent support</h3>
            ${d.recent.length ? `<div class="table">${d.recent.map((p) => `
              <div class="tr">
                ${avatar(p.user || { displayName: '?', color: '#555' })}
                <div class="grow">
                  <div><strong>${esc(p.user ? p.user.displayName : 'Deleted user')}</strong> ${p.type === 'donation' ? 'donated' : p.renewal ? 'renewed' : 'subscribed'} ${p.tier ? tierBadge(p.tier) : ''}${p.offline ? ' <span class="offline-tag">while offline</span>' : ''}</div>
                  ${p.message ? `<div class="muted small">“${esc(p.message)}”</div>` : ''}
                  <div class="muted small">${ago(p.createdAt)}</div>
                </div>
                <div class="right"><div class="strong">+${money(p.net)}</div><div class="muted small">${money(p.amount)} − ${money(p.fee)}</div></div>
              </div>`).join('')}</div>` : '<p class="muted pad">No support yet. Go live and share your channel link to get your first supporters.</p>'}
          </div>
          <div class="stack">
            <div class="card">
              <h3 class="pad-x">Top supporters</h3>
              ${d.topSupporters.length ? `<div class="table">${d.topSupporters.map((s, i) => `
                <a class="tr" href="#/c/${esc(s.user.username)}"><span class="rank">${i + 1}</span>${avatar(s.user)}<span class="grow">${esc(s.user.displayName)} ${tierBadge(s.tier)}</span><strong>${money(s.total)}</strong></a>`).join('')}</div>` : '<p class="muted pad">Your top supporters will appear here.</p>'}
            </div>
            <div class="card">
              <h3 class="pad-x">Past streams</h3>
              ${d.streams.length ? `<div class="table">${d.streams.map((s) => `
                <div class="tr"><div class="grow"><div class="strong">${esc(s.title)}</div><div class="muted small">${esc(s.category)} · ${fmtDate(s.startedAt)} · ${duration(s.endedAt - s.startedAt)}</div></div><span class="muted small">peak ${plural(s.peakViewers, 'viewer')}</span></div>`).join('')}</div>` : '<p class="muted pad">No streams yet.</p>'}
            </div>
          </div>
        </div>
      </section>`;
  }

  async function pageSupport(ctx) {
    if (!state.me) return loginWall('My support', 'Log in to manage your subscriptions and see your donation history.');
    app.innerHTML = '<div class="loading">Loading…</div>';
    let d;
    try {
      d = await api('/me/support');
    } catch (e) {
      if (ctx.alive()) app.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      return;
    }
    if (!ctx.alive()) return;
    app.innerHTML = `
      <section class="section">
        <h1>My support</h1>
        <div class="stats">
          <div class="stat"><span class="stat-label">Total given</span><span class="stat-value">${money(d.totals.given)}</span></div>
          <div class="stat"><span class="stat-label">Monthly commitment</span><span class="stat-value">${money(d.totals.monthly)}</span></div>
        </div>
        <div class="card">
          <h3 class="pad-x">Subscriptions</h3>
          ${d.subscriptions.length ? `<div class="table">${d.subscriptions.map((s) => `
            <div class="tr">
              ${avatar(s.streamer)}
              <div class="grow">
                <div><a class="strong" href="#/c/${esc(s.streamer.username)}">${esc(s.streamer.displayName)}</a> ${tierBadge(s.tier)}</div>
                <div class="muted small">${money(s.price)} / month · ${s.status === 'cancelled' ? `ends ${fmtDate(s.renewsAt)}` : `renews ${fmtDate(s.renewsAt)}${s.nextTierName ? ` as ${esc(s.nextTierName)}` : ''}`}</div>
              </div>
              ${s.status === 'active'
                ? `<button class="btn btn-small" type="button" data-cancel="${esc(s.streamer.username)}">Cancel</button>`
                : `<a class="btn btn-small btn-outline" href="#/c/${esc(s.streamer.username)}">Resume</a>`}
            </div>`).join('')}</div>` : '<p class="muted pad">You don\'t support anyone monthly yet. Find a streamer you love and press ⭐ Subscribe.</p>'}
        </div>
        <div class="card">
          <h3 class="pad-x">Payment history</h3>
          ${d.payments.length ? `<div class="table">${d.payments.map((p) => `
            <div class="tr">
              <div class="grow">
                <div>${p.type === 'donation' ? 'Donation' : p.renewal ? 'Subscription renewal' : 'Subscription'} to <strong>${esc(p.user ? p.user.displayName : 'Deleted user')}</strong> ${p.tier ? tierBadge(p.tier) : ''}</div>
                <div class="muted small">${fmtDate(p.createdAt)} · receipt ${esc(p.id)} · streamer received ${money(p.net)}</div>
              </div>
              <strong>${money(p.amount)}</strong>
            </div>`).join('')}</div>` : '<p class="muted pad">No payments yet.</p>'}
        </div>
        ${DEMO_NOTE}
      </section>`;
    $$('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
      if (!window.confirm('Cancel this subscription? You keep your perks until the end of the paid month.')) return;
      try {
        await cancelSubscription(b.dataset.cancel);
        toast('Subscription cancelled.');
        router();
      } catch (e) {
        toast(e.message, 'error');
      }
    }));
  }

  async function pageSettings() {
    if (!state.me) return loginWall('Settings', 'Log in to edit your profile.');
    const me = state.me;
    app.innerHTML = `
      <section class="section narrow">
        <h1>Settings</h1>
        <form class="card pad form" id="settings-form">
          <label>Username<input value="${esc(me.username)}" disabled></label>
          <label>Display name<input name="displayName" maxlength="30" required value="${esc(me.displayName)}"></label>
          <label>Bio<textarea name="bio" maxlength="300" rows="4" placeholder="Tell viewers what you stream and when.">${esc(me.bio)}</textarea></label>
          <p class="form-error" hidden></p>
          <button class="btn btn-primary" type="submit">Save</button>
        </form>
        <form class="card pad form danger-zone" id="delete-form" novalidate>
          <h3>Delete account</h3>
          <p class="muted small">This permanently deletes your profile, channel, follows and community posts, and stops your monthly support. Payment records are kept without your profile details, as required by accounting law. This cannot be undone.</p>
          <label>Confirm with your password<input name="password" type="password" autocomplete="current-password"></label>
          <p class="form-error" hidden></p>
          <button class="btn btn-danger" type="submit">Delete my account</button>
        </form>
      </section>`;
    const del = $('#delete-form');
    del.addEventListener('submit', async (e) => {
      e.preventDefault();
      showFormError(del, '');
      if (!window.confirm('Delete your StreamHive account permanently?')) return;
      if (studio.live) await studio.end();
      setBusy(del, true);
      try {
        await api('/me', { method: 'DELETE', body: { password: $('[name=password]', del).value } });
        studio.stopMedia();
        setToken(null);
        state.me = null;
        leaveRoom();
        connectEvents();
        renderAccount();
        location.hash = '#/';
        toast('Your account was deleted. Thanks for being part of the hive.');
      } catch (err) {
        setBusy(del, false);
        showFormError(del, err.message);
      }
    });
    const form = $('#settings-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      showFormError(form, '');
      setBusy(form, true);
      try {
        const r = await api('/me', { method: 'PUT', body: { displayName: $('[name=displayName]', form).value, bio: $('[name=bio]', form).value } });
        state.me = r.user;
        renderAccount();
        toast('Profile saved.', 'success');
      } catch (err) {
        showFormError(form, err.message);
      } finally {
        setBusy(form, false);
        $('input', form).disabled = true;
      }
    });
  }

  // =========================================================================
  // Sharing, contact forms
  // =========================================================================
  const feePct = () => Math.round(state.config.platformFee * 100);

  async function shareChannel(user) {
    const url = `${location.origin}${location.pathname}#/c/${user.username}`;
    const title = `${user.displayName} on StreamHive`;
    if (navigator.share) {
      try {
        await navigator.share({ title, text: `Watch ${user.displayName} on StreamHive`, url });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('Channel link copied. Paste it on TikTok, YouTube, Discord or X.', 'success');
    } catch {
      window.prompt('Copy your channel link:', url);
    }
  }

  const CONTACT_KINDS = {
    support: 'I need help',
    feedback: 'Feedback or an idea',
    report: 'Report a problem with a stream',
    advertise: 'Advertising and sponsorship',
  };

  function contactFormHtml({ kinds, placeholder = 'How can we help?', emailOptional = false, submitLabel = 'Send message' }) {
    return `
      <form class="form contact-form" novalidate>
        ${kinds.length > 1
          ? `<label>Topic<select name="kind">${kinds.map((k) => `<option value="${k}">${esc(CONTACT_KINDS[k])}</option>`).join('')}</select></label>`
          : `<input type="hidden" name="kind" value="${kinds[0]}">`}
        ${state.me ? '' : `<label>Your email${emailOptional ? ' <span class="muted">(optional)</span>' : ''}<input name="email" type="email" maxlength="200" autocomplete="email" placeholder="you@example.com"></label>`}
        <label>Message<textarea name="message" rows="5" maxlength="2000" placeholder="${esc(placeholder)}"></textarea></label>
        <p class="form-error" hidden></p>
        <button class="btn btn-primary" type="submit">${esc(submitLabel)}</button>
      </form>`;
  }

  function bindContactForm(form, { channel, onSent } = {}) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(form).entries());
      if (channel) body.channel = channel;
      showFormError(form, '');
      setBusy(form, true);
      try {
        await api('/feedback', { method: 'POST', body });
        const done = document.createElement('div');
        done.className = 'success';
        done.innerHTML = '<div class="success-icon">🐝</div><h3>Thanks, your message was sent!</h3><p class="muted">Our team reads every message. If you left an email address, we reply within two working days.</p>';
        form.replaceWith(done);
        if (onSent) onSent(done);
      } catch (err) {
        setBusy(form, false);
        showFormError(form, err.message);
      }
    });
  }

  function reportModal(channel) {
    const m = openModal(`
      <h2>Report ${esc(channel.displayName)}'s stream</h2>
      <p class="muted">Tell us what's wrong. Reports are confidential: the streamer won't see who sent them. Our moderators review every report against the <a class="accent" href="#/guidelines">community guidelines</a>.</p>
      ${contactFormHtml({ kinds: ['report'], placeholder: 'What happened, and roughly when?', emailOptional: true, submitLabel: 'Send report' })}`);
    bindContactForm($('form', m.body), { channel: channel.username });
  }

  // Smooth in-page scrolling without touching the hash router.
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-scroll]');
    if (!el) return;
    e.preventDefault();
    const target = document.getElementById(el.dataset.scroll);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // Footer "Contact us": open the help page and jump to the contact form.
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-scroll-after]');
    if (!el) return;
    const id = el.dataset.scrollAfter;
    if (location.hash === el.getAttribute('href')) {
      e.preventDefault();
      const t = document.getElementById(id);
      if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      state.scrollAfter = id;
    }
  });
  function scrollAfterRender() {
    if (!state.scrollAfter) return;
    const t = document.getElementById(state.scrollAfter);
    state.scrollAfter = null;
    if (t) t.scrollIntoView({ block: 'start' });
  }

  function faq(items) {
    return `<div class="faq">${items.map(([q, a]) => `<details><summary>${esc(q)}</summary><div class="faq-a">${a}</div></details>`).join('')}</div>`;
  }

  function docPage(title, intro, sections, { updated = true } = {}) {
    return `
      <article class="doc">
        <header class="doc-head">
          <h1>${esc(title)}</h1>
          ${intro ? `<p class="lead">${intro}</p>` : ''}
          ${updated ? '<p class="draft-note">Prototype draft — to be reviewed by a legal professional before StreamHive launches publicly.</p>' : ''}
        </header>
        ${sections.length > 2 ? `<nav class="toc" aria-label="On this page">${sections.map(([id, h]) => `<button type="button" class="link" data-scroll="${id}">${esc(h)}</button>`).join('')}</nav>` : ''}
        ${sections.map(([id, h, body]) => `<section id="${id}" class="doc-section"><h2>${esc(h)}</h2>${body}</section>`).join('')}
      </article>`;
  }

  // =========================================================================
  // Landing page
  // =========================================================================
  function pageIndex(ctx) {
    return state.me ? pageBrowse(ctx) : pageLanding(ctx);
  }

  // =========================================================================
  // Pricing
  // =========================================================================
  function pagePricing() {
    const pct = feePct();
    const tiers = state.config.tiers;
    app.innerHTML = `
      <section class="section">
        <div class="page-head">
          <h1>Simple, fair pricing</h1>
          <p class="lead">Free to stream. Free to watch. We only earn when streamers earn.</p>
        </div>

        <div class="plans">
          <div class="plan">
            <h3>Streamers</h3>
            <div class="plan-price">Free<span class="muted small"> to stream</span></div>
            <ul class="l-list good">
              <li>Go live from phone or browser</li>
              <li>Built-in donations and monthly supporters</li>
              <li>Chat, community wall and supporter wall</li>
              <li>Creator dashboard</li>
            </ul>
            <p class="plan-note">${pct}% commission on money you receive, payment processing included.</p>
            <a class="btn btn-primary btn-block" href="live.html">Start streaming</a>
          </div>
          <div class="plan">
            <h3>Viewers</h3>
            <div class="plan-price">Free<span class="muted small"> to watch</span></div>
            <ul class="l-list good">
              <li>Watch every stream, on any device</li>
              <li>Chat, follow and get live notifications</li>
              <li>Donate and support monthly in two taps</li>
              <li>Sponsored messages may appear</li>
            </ul>
            <p class="plan-note">Donations and supporter tiers are always optional.</p>
            <a class="btn btn-block" href="browse.html">Browse streams</a>
          </div>
          <div class="plan plan-pro">
            <span class="soon-badge">👑 For streamers</span>
            <h3>Hive Pro</h3>
            <div class="plan-price">${money(state.config.pro.price)}<span class="muted small"> / month</span></div>
            <ul class="l-list good">
              <li>HD streaming up to 1080p</li>
              <li>Only ${Math.round(state.config.pro.fee * 100)}% fee instead of ${pct}%</li>
              <li>PRO badge and boosted discovery</li>
              <li>Advanced analytics and priority support</li>
              <li>No ads</li>
            </ul>
            <p class="plan-note">Viewer Premium (ad-free watching) is coming soon. <button class="link small" type="button" id="premium-interest">Notify me</button></p>
            <a class="btn btn-primary btn-block" href="premium.html">See Hive Pro</a>
          </div>
        </div>

        <div class="two-col">
          <div class="card pad">
            <h2>Fee calculator</h2>
            <p class="muted">See exactly how much of a donation or supporter payment reaches the streamer.</p>
            <label class="form calc-label">Amount (€)<input id="calc" inputmode="decimal" value="10.00" autocomplete="off"></label>
            <div class="breakdown" id="calc-out"></div>
          </div>
          <div class="card pad">
            <h2>Monthly supporter tiers</h2>
            <div class="table compact">${tiers.map((t) => `
              <div class="tr">${tierBadge(t.id)}<span class="grow">${money(t.price)} / month</span><span class="muted small">streamer receives</span><strong>${money(t.price - feeOf(t.price))}</strong></div>`).join('')}</div>
            <p class="muted small">Supporters can cancel any time and keep their perks until the end of the paid month. Changing tier takes effect at the next renewal, so nobody is charged twice.</p>
          </div>
        </div>

        <h2 class="l-title">Pricing questions</h2>
        ${faq([
          ['Are there hidden fees?', `<p>No. The ${pct}% commission includes payment processing. The amount shown as "streamer receives" is what the streamer gets.</p>`],
          ['Why is there a commission at all?', '<p>It pays for the platform, payment processing, moderation and support — so streaming and watching can stay free for everyone.</p>'],
          ['What are the minimum and maximum donations?', `<p>Donations can be between ${money(state.config.donation.min)} and ${money(state.config.donation.max)}.</p>`],
          ['When do streamers get paid out?', '<p>In this prototype payments are simulated. At launch, payouts go to the streamer\'s bank account through our licensed payment partner.</p>'],
        ])}
        ${DEMO_NOTE}
      </section>`;

    const input = $('#calc');
    const out = $('#calc-out');
    const update = () => {
      const raw = input.value.trim().replace(',', '.');
      const cents = /^\d+(\.\d{1,2})?$/.test(raw) ? Math.round(Number(raw) * 100) : NaN;
      out.innerHTML = Number.isFinite(cents) && cents > 0
        ? `<div><span>Viewer pays</span><span>${money(cents)}</span></div>
           <div><span>StreamHive fee (${pct}%)</span><span>−${money(feeOf(cents))}</span></div>
           <div class="strong"><span>Streamer receives</span><span>${money(cents - feeOf(cents))}</span></div>`
        : '<div class="muted">Enter an amount, for example 5 or 7.50.</div>';
    };
    input.addEventListener('input', update);
    update();

    $('#premium-interest').addEventListener('click', () => {
      const m = openModal(`
        <h2>Premium is coming</h2>
        <p class="muted">Leave a message and we'll let you know when Viewer Premium and Streamer Premium launch. Tell us which one you're interested in!</p>
        ${contactFormHtml({ kinds: ['feedback'], placeholder: "I'm interested in Viewer Premium / Streamer Premium because…", submitLabel: 'Notify me' })}`);
      bindContactForm($('form', m.body));
    });
  }

  // =========================================================================
  // Help center
  // =========================================================================
  function pageHelp() {
    const pct = feePct();
    const sections = [
      ['start', 'Getting started', `
        <p>Create a free account with <strong>Sign up</strong> in the top bar. You only need a username and a password. With one account you can watch, chat, follow, support and stream.</p>
        <p>To find streams, open <a class="accent" href="browse.html">Browse</a> and filter by category, or search for a channel by name.</p>`],
      ['live', 'Going live', `
        <ol>
          <li>Open <a class="accent" href="live.html">Go live</a>.</li>
          <li>Tap <strong>Use camera</strong> (or <strong>Share screen</strong> on a computer). Your browser asks for permission — choose <em>Allow</em>.</li>
          <li>Add a title, pick a category and press <strong>Go live</strong>.</li>
        </ol>
        <p>While live you can flip between front and back camera, mute your microphone or pause your video. You can browse other pages without ending your stream — the red <strong>LIVE</strong> pill at the top brings you back to the studio. Press <strong>End stream</strong> when you're done.</p>
        <p><strong>Tip:</strong> share your channel link with the <strong>Share</strong> button so your audience on other social media can find you.</p>`],
      ['phone', 'Streaming from a phone', `
        <p>Open StreamHive in your phone's browser (Chrome, Safari, Samsung Internet or Firefox) and follow the steps above. No app is needed.</p>
        <ul>
          <li>Use Wi-Fi when you can. Viewers connect directly to your device, so a stable upload connection gives the best quality.</li>
          <li>Keep the StreamHive tab open and your screen on while you're live.</li>
          <li>Hold your phone horizontally for a wide picture.</li>
        </ul>`],
      ['screen', 'Streaming games and your screen', `
        <p>On a computer, choose <strong>Share screen</strong> in the studio. You can share a window, a browser tab or your whole screen. Your microphone is mixed in automatically, and if your browser offers it, you can also share the sound of the tab or system.</p>
        <p>If you stop sharing from the browser's own controls, StreamHive switches back to your camera so your stream keeps going.</p>`],
      ['support', 'Donations and monthly support', `
        <p><strong>Donations</strong> are one-time payments with an optional message that appears on stream. <strong>Monthly support</strong> (Bronze, Silver or Gold) renews every 30 days and gives supporters a chat badge and a place on the supporter wall.</p>
        <p>StreamHive keeps ${pct}% of each payment; the rest goes to the streamer. You see the exact split before you pay. You can find all your payments and receipts in <a class="accent" href="#/support">My support</a>.</p>
        <p><strong>Cancelling:</strong> go to <a class="accent" href="#/support">My support</a> and press <strong>Cancel</strong>. You keep your perks until the end of the month you paid for and won't be charged again. You can resume at any time without paying twice.</p>`],
      ['trouble', 'Troubleshooting', `
        <dl class="trouble">
          <dt>The stream keeps saying "Connecting…"</dt>
          <dd>Press <strong>Try again</strong>. If it still doesn't load, the streamer's connection may be slow, or your network (for example a school or office network) may block live video.</dd>
          <dt>I can see the stream but can't hear anything</dt>
          <dd>Browsers start videos muted. Tap <strong>🔇 Tap to unmute</strong> on the player.</dd>
          <dt>My camera or microphone doesn't work</dt>
          <dd>Check that you allowed access in your browser's site settings, and close other apps that might be using the camera (video calls, for example).</dd>
          <dt>Screen sharing isn't available</dt>
          <dd>Phones and tablets don't allow screen sharing from the browser. Use your camera, or stream from a computer.</dd>
        </dl>`],
      ['account', 'Your account and privacy', `
        <p>Change your display name and bio in <a class="accent" href="#/settings">Settings</a>. You can also delete your account there. Read how we handle your data in the <a class="accent" href="#/privacy">privacy policy</a>.</p>`],
      ['contact', 'Contact us', `
        <p>Can't find your answer, have an idea, or want to report something? Send us a message here, or use the full <a class="accent" href="contact.html">contact page</a>.</p>
        ${contactFormHtml({ kinds: ['support', 'feedback', 'report'] })}`],
    ];
    app.innerHTML = docPage('Help center', 'Everything you need to start streaming, watching and supporting on StreamHive.', sections, { updated: false });
    bindContactForm($('.contact-form'));
    scrollAfterRender();
  }

  // =========================================================================
  // Community guidelines
  // =========================================================================
  function pageGuidelines() {
    const sections = [
      ['spirit', 'The spirit of the hive', '<p>StreamHive is a place to share what you love and support the people who make it. Treat others the way you want to be treated in your own hive. These rules apply to streams, chat, community posts, profiles and donation messages.</p>'],
      ['respect', 'Be respectful', `<ul>
        <li>No harassment, bullying, threats or encouraging others to target someone.</li>
        <li>No hate speech or discrimination based on origin, religion, gender, sexual orientation, disability, age or any other characteristic.</li>
        <li>Disagree with ideas, not people.</li></ul>`],
      ['safe', 'Keep it safe and legal', `<ul>
        <li>No sexual content or nudity. Content that sexualises minors is never allowed and is reported to the authorities.</li>
        <li>No graphic violence, self-harm content, or dangerous challenges.</li>
        <li>Nothing illegal: no drugs sales, weapons trade, gambling promotion or piracy.</li>
        <li>Only stream content you have the right to share (music, films and games with streaming rights).</li></ul>`],
      ['money', 'Honest money', `<ul>
        <li>Never pressure or trick viewers into donating, and don't promise rewards you won't deliver.</li>
        <li>No fake giveaways, scams or impersonation of other streamers or brands.</li>
        <li>Fraudulent payments lead to account suspension and refunds to the payer.</li></ul>`],
      ['privacy', 'Respect privacy', '<ul><li>Don\'t share other people\'s personal information (addresses, phone numbers, private photos).</li><li>Ask permission before filming people who are not part of your stream.</li></ul>'],
      ['age', 'Age', '<p>You must be at least 13 years old to use StreamHive. To send or receive money you must be 18, or have permission from a parent or guardian.</p>'],
      ['enforce', 'Reporting and enforcement', '<p>Use <strong>Report</strong> on any channel to tell us about a problem. Reports are confidential. Our moderators review them and may remove content, end a stream, or suspend or ban accounts depending on how serious the violation is and whether it happened before. If you think we made a mistake, contact us through the <a class="accent" href="#/help">help center</a>.</p>'],
    ];
    app.innerHTML = docPage('Community guidelines', 'How we keep StreamHive a safe and friendly place for streamers and viewers.', sections);
  }

  // =========================================================================
  // Advertise
  // =========================================================================
  function pageAdvertise() {
    app.innerHTML = `
      <section class="section">
        <div class="page-head">
          <span class="eyebrow">For brands and sponsors</span>
          <h1>Reach a growing community of new creators and their fans</h1>
          <p class="lead">StreamHive gives brands a direct line to engaged viewers and up-and-coming streamers — with formats that respect the viewer experience.</p>
        </div>
        <div class="l-features three">
          <div class="feature"><div class="feature-ico">📣</div><h3>Sponsored messages</h3><p class="muted">Short, clearly labelled messages shown to viewers on the free plan, matched to stream categories.</p></div>
          <div class="feature"><div class="feature-ico">🤝</div><h3>Streamer sponsorships</h3><p class="muted">Partner with individual streamers whose audience fits your brand, with transparent disclosure.</p></div>
          <div class="feature"><div class="feature-ico">🏆</div><h3>Category partnerships</h3><p class="muted">Present a category such as Gaming, Music or Cooking, or support community events and challenges.</p></div>
        </div>
        <div class="two-col">
          <div class="card pad">
            <h2>Our principles</h2>
            <ul class="l-list good">
              <li>Every ad and sponsorship is clearly labelled</li>
              <li>No ads interrupting a stream mid-way</li>
              <li>Brand safety through moderation and our community guidelines</li>
              <li>No selling of personal data — targeting is based on stream category</li>
            </ul>
          </div>
          <div class="card pad">
            <h2>Get in touch</h2>
            ${contactFormHtml({ kinds: ['advertise'], placeholder: 'Your company, what you would like to promote, and your timing.', submitLabel: 'Contact our partnerships team' })}
          </div>
        </div>
      </section>`;
    bindContactForm($('.contact-form'));
  }

  // =========================================================================
  // Legal
  // =========================================================================
  function pageTerms() {
    const pct = feePct();
    const sections = [
      ['who', '1. About these terms', '<p>These terms apply to your use of StreamHive, a platform to stream live video, watch streams and support streamers. By creating an account or using StreamHive you agree to these terms and to the <a class="accent" href="#/guidelines">community guidelines</a>.</p>'],
      ['account', '2. Your account', '<p>You must be at least 13 years old. You are responsible for your account and for keeping your password secret. One person may not use multiple accounts to get around a suspension.</p>'],
      ['content', '3. Your content', '<p>You keep the rights to what you stream and post. You give StreamHive permission to show your content to viewers on the platform while it is live or published. You must have the rights to everything you stream, including music and games.</p>'],
      ['payments', '4. Donations and monthly support', `<ul>
        <li>Donations are voluntary gifts to the streamer and are non-refundable, except in case of fraud or a technical error.</li>
        <li>Monthly support renews automatically every 30 days until cancelled. After cancelling, the benefits continue until the end of the paid period and no further payments are taken.</li>
        <li>StreamHive keeps a ${pct}% commission, which includes payment processing. The streamer receives the remainder.</li>
        <li>Payments are processed by a licensed payment provider. In the current prototype, payments are simulated.</li></ul>`],
      ['rules', '5. Acceptable use', '<p>You may not break the law, the community guidelines, or try to disrupt, hack or misuse StreamHive. We may remove content and suspend or close accounts that do.</p>'],
      ['service', '6. The service', '<p>We work hard to keep StreamHive available, but we cannot guarantee that it is always uninterrupted. Live video quality depends on the streamer\'s and viewer\'s internet connection. We may change or add features over time.</p>'],
      ['end', '7. Ending your account', '<p>You can delete your account at any time in Settings. We may suspend or close accounts that seriously or repeatedly break these terms.</p>'],
      ['law', '8. Applicable law', '<p>These terms are governed by Belgian law. Consumers keep any protection given to them by the law of their country of residence.</p>'],
    ];
    app.innerHTML = docPage('Terms of use', 'The rules for using StreamHive, written in plain language.', sections);
  }

  function pagePrivacy() {
    const sections = [
      ['what', 'What we collect', `<ul>
        <li><strong>Account:</strong> username, display name, bio and your password (stored only as a secure hash, never in plain text).</li>
        <li><strong>Activity:</strong> who you follow, your community posts, your subscriptions and payment records (amount, date, recipient).</li>
        <li><strong>Messages to us:</strong> support, feedback and report messages, and your email address if you give one.</li>
        <li><strong>Chat:</strong> recent chat messages are kept in memory to show the chat history, and are not stored permanently.</li></ul>`],
      ['video', 'Your video and audio', '<p>Live video travels directly from the streamer\'s device to each viewer (peer-to-peer). StreamHive does not record or store streams. Only a small preview image (thumbnail) is kept while you are live so viewers can find your stream. To set up the direct connection, devices exchange network addresses through a connection-helper (STUN) server.</p>'],
      ['why', 'Why we use it', '<ul><li>To run your account and show your channel.</li><li>To process donations and monthly support, and keep payment records we are legally required to keep.</li><li>To keep the platform safe: moderation, fraud prevention and handling reports.</li><li>To answer your messages.</li></ul>'],
      ['share', 'Who we share it with', '<p>We don\'t sell your personal data. We share it only with the payment provider (to process payments), hosting providers (to run the service), and authorities when the law requires it.</p>'],
      ['storage', 'Cookies and local storage', '<p>We don\'t use advertising or tracking cookies. Your browser stores your login session and your last stream title locally so you stay logged in.</p>'],
      ['keep', 'How long we keep it', '<p>Your account data is kept until you delete your account. Payment records are kept for the period required by accounting law, without your profile details.</p>'],
      ['rights', 'Your rights', '<p>Under the GDPR you can access, correct, export or delete your data, and object to how we use it. Delete your account in <a class="accent" href="#/settings">Settings</a>, or contact us through the <a class="accent" href="#/help">help center</a> for anything else. You can also file a complaint with the Belgian Data Protection Authority.</p>'],
    ];
    app.innerHTML = docPage('Privacy policy', 'What data StreamHive uses, why, and what your rights are.', sections);
  }

  // =========================================================================
  // About us
  // =========================================================================
  function pageAboutUs() {
    const pct = feePct();
    app.innerHTML = `
      <div class="about">
        <section class="about-hero">
          <div class="honeycomb" aria-hidden="true"></div>
          <div class="about-hero-text">
            <span class="eyebrow">🐝 About us</span>
            <h1>We built StreamHive because starting to stream was <span class="grad">way too hard</span>.</h1>
            <p class="lead">We are Team 2, a student team at Karel de Grote University of Applied Sciences in Antwerp. We saw people with something great to share give up on streaming before they ever went live — so we set out to make it as easy as pressing one button.</p>
            <div class="row"><a class="btn btn-primary btn-lg" href="live.html">Try going live</a><a class="btn btn-lg btn-glass" href="contact.html">Contact us</a></div>
          </div>
          <div class="hex-cluster" aria-hidden="true">
            <span class="hc hc1">🎥</span><span class="hc hc2">🐝</span><span class="hc hc3">💛</span>
            <span class="hc hc4">💬</span><span class="hc hc5">⭐</span><span class="hc hc6">🌼</span><span class="hc hc7">🍯</span>
          </div>
        </section>

        <section class="about-story">
          <div>
            <span class="kicker left">Our story</span>
            <h2 class="l-title left">It started with a simple question</h2>
          </div>
          <div class="story-text">
            <p>Live streaming has become one of the most popular ways to share games, skills and everyday life. But starting is much harder than it looks. When we — and people around us — tried it, we kept running into the same wall.</p>
            <p>First you install and configure broadcasting software like OBS: scenes, audio, video and stream keys. That needs a reasonably powerful computer and quite a bit of technical knowledge. And once you are finally live, donations, community and support all live on separate websites and apps.</p>
            <blockquote class="story-quote">“Why does sharing something you love need three apps, a gaming PC and a weekend of tutorials?”</blockquote>
            <p>Based on our own experience and that of acquaintances who started streaming, that setup is the part that discourages beginners the most. So that is exactly where we started.</p>
          </div>
        </section>

        <section class="l-section">
          <span class="kicker">The problem we saw</span>
          <h2 class="l-title">Three walls between people and their first stream</h2>
          <div class="pain-grid">
            <div class="pain-card"><div class="hex-ico">🧩</div><h3>Too technical</h3><p class="muted">Broadcasting software with scenes, encoders and stream keys is confusing for someone who just wants to go live and talk to their audience.</p></div>
            <div class="pain-card"><div class="hex-ico">💻</div><h3>Needs strong hardware</h3><p class="muted">Encoding video takes a reasonably powerful computer — something many beginners simply don't have.</p></div>
            <div class="pain-card"><div class="hex-ico">🔀</div><h3>Scattered tools</h3><p class="muted">Stream, chat, donations and community pages live on different sites. Streamers juggle tools; viewers have to leave the stream to support.</p></div>
          </div>
          <div class="impact">
            <strong>What happens if nobody fixes this?</strong>
            <p>Many people who have something to share never start streaming. Those who do spend their time on tools instead of content and depend on third-party services to receive support. Viewers keep switching between sites, and the community around a stream stays split instead of growing in one place.</p>
          </div>
        </section>

        <section class="l-section">
          <span class="kicker">Who we build for</span>
          <h2 class="l-title">Two sides of every hive</h2>
          <div class="who-grid">
            <div class="who-card">
              <div class="who-head"><span class="who-emoji">🎥</span><div><h3>Streamers</h3><span class="muted small">especially beginners</span></div></div>
              <p>They want to share content and build an audience — from the device they already have, without becoming technicians first. They also want regular, predictable support, not only one-time donations.</p>
              <ul class="l-list good"><li>Go live from a phone or basic computer</li><li>Stream, donations and supporters in one place</li><li>Predictable monthly income</li></ul>
            </div>
            <div class="who-card">
              <div class="who-head"><span class="who-emoji">🐝</span><div><h3>Viewers &amp; supporters</h3><span class="muted small">mostly on their phones</span></div></div>
              <p>They want to watch the streamers they like and support them — without leaving the stream for an external app or website, and with a simple way to support regularly instead of only once.</p>
              <ul class="l-list good"><li>Watch, chat and donate in one place</li><li>Follow favourites across one platform</li><li>Safe, simple and transparent payments</li></ul>
            </div>
          </div>
        </section>

        <section class="l-section">
          <span class="kicker">Our challenge</span>
          <h2 class="l-title">How might we…</h2>
          <div class="hmw-grid">
            <blockquote class="hmw">
              <span class="hmw-who">For streamers</span>
              <p>…simplify starting a stream and enable built-in donations and regular support for streamers (especially beginners), so that they can go live easily from a phone or a basic computer and be supported by their audience — focusing on their content instead of setting up software and connecting external services?</p>
              <footer>Taking into account limited hardware and technical experience, payment regulations, and keeping stream, donations and community in one place.</footer>
            </blockquote>
            <blockquote class="hmw">
              <span class="hmw-who">For viewers</span>
              <p>…enable watching and supporting streamers, so that viewers can watch streams, donate and support streamers regularly in one place — without switching between websites and external apps?</p>
              <footer>Taking into account different devices (mostly phones), safe payments, and donations that are simple and transparent.</footer>
            </blockquote>
          </div>
        </section>

        <section class="l-section l-band">
          <span class="kicker">What we believe</span>
          <h2 class="l-title">Our principles</h2>
          <div class="l-hive">
            <div class="hex-card"><div class="hex big">⚡</div><span class="hex-label">Simple</span><h3>Simple first</h3><p class="muted">Go live from the device you already have, in under a minute. No installs, no manuals.</p></div>
            <div class="hex-card"><div class="hex big">⬢</div><span class="hex-label">Together</span><h3>One hive</h3><p class="muted">Stream, chat, donations, supporters and community on one page — so your community grows in one place.</p></div>
            <div class="hex-card"><div class="hex big">⚖️</div><span class="hex-label">Fair</span><h3>Fair for creators</h3><p class="muted">A ${pct}% commission, below typical external donation services, with payment processing included.</p></div>
            <div class="hex-card"><div class="hex big">🛡️</div><span class="hex-label">Safe</span><h3>Safe &amp; transparent</h3><p class="muted">Licensed payment partner, the exact split shown before paying, and clear community guidelines.</p></div>
          </div>
        </section>

        <section class="l-section">
          <span class="kicker">Our journey</span>
          <h2 class="l-title">From problem to prototype</h2>
          <ol class="journey">
            <li class="done"><span class="j-dot">1</span><div><strong>Understand the problem</strong><small>November 2026 · Problem statement</small><p class="muted">We mapped our own experience and that of people who started streaming, identified the stakeholders and wrote our "How might we" questions.</p></div></li>
            <li class="done"><span class="j-dot">2</span><div><strong>Design the business</strong><small>Business Model Canvas</small><p class="muted">Customer segments, value propositions, channels and a revenue model: a small commission, sponsorships and an optional ad-free Premium.</p></div></li>
            <li class="now"><span class="j-dot">3</span><div><strong>Build the prototype</strong><small>We are here</small><p class="muted">This working web app: a browser studio, built-in donations, monthly supporters, live chat and a community wall.</p></div></li>
            <li><span class="j-dot">4</span><div><strong>Test and launch</strong><small>Next steps</small><p class="muted">Test with real beginner streamers, partner with a licensed payment provider, scale video for bigger audiences, and introduce Viewer and Streamer Premium.</p></div></li>
          </ol>
        </section>

        <section class="l-section">
          <span class="kicker">Business model</span>
          <h2 class="l-title">How StreamHive works as a business</h2>
          <div class="bm-grid">
            <div class="bm-card"><h3>💰 How we earn</h3><ul class="l-list"><li>A small commission on donations and monthly support (target 8–10%; ${pct}% today)</li><li>Clearly labelled sponsorships and brand partnerships</li><li>Optional Viewer Premium without ads, and later Streamer Premium</li></ul></div>
            <div class="bm-card"><h3>🤝 Who we work with</h3><ul class="l-list"><li>Licensed payment providers (cards, bank and mobile payments)</li><li>Cloud and video streaming infrastructure</li><li>Brands, sponsors and creator communities</li><li>Social media to share streams and invite viewers</li></ul></div>
            <div class="bm-card"><h3>📦 What it takes</h3><ul class="l-list"><li>Building and maintaining the platform</li><li>Streaming infrastructure that grows with usage</li><li>Payment processing, moderation and support</li><li>Marketing and community building</li></ul></div>
          </div>
        </section>

        <section class="l-cta">
          <div class="honeycomb" aria-hidden="true"></div>
          <div class="cta-bee" aria-hidden="true">🐝</div>
          <h2>Want to help us build the hive?</h2>
          <p>Tell us what you think, test the prototype with us, or just say hi.</p>
          <div class="row center"><a class="btn btn-primary btn-lg btn-glow" href="contact.html">Get in touch</a><a class="btn btn-lg btn-glass" href="browse.html">Explore streams</a></div>
        </section>
      </div>`;
  }

  // =========================================================================
  // Contact
  // =========================================================================
  const CONTACT_TOPICS = [
    ['support', '🛟', 'I need help'],
    ['feedback', '💡', 'Feedback or an idea'],
    ['report', '🛡️', 'Report a problem'],
    ['advertise', '🤝', 'Brands & sponsors'],
    ['school', '🎓', 'School or press'],
    ['other', '✉️', 'Something else'],
  ];
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function pageContact() {
    const me = state.me;
    app.innerHTML = `
      <div class="contact">
        <section class="contact-hero">
          <div class="honeycomb" aria-hidden="true"></div>
          <span class="eyebrow">✉️ Contact</span>
          <h1>Let's talk <span class="grad">buzz buzz</span> 🐝</h1>
          <p class="lead">Questions, feedback, a problem with a stream, or interested in working together? Send us a message — we read every one and reply within two working days.</p>
        </section>

        <div class="contact-grid">
          <aside class="contact-side">
            <a class="side-card" href="#/help"><span class="hex-ico">🛟</span><div><strong>Need help right now?</strong><small>Most answers are already in the help center.</small></div><span class="side-arrow">→</span></a>
            <div class="side-card"><span class="hex-ico">🛡️</span><div><strong>Report a stream</strong><small>Use ⚑ Report on the channel, or pick "Report a problem" here. Reports are confidential.</small></div></div>
            <a class="side-card" href="#/advertise"><span class="hex-ico">🤝</span><div><strong>Brands &amp; sponsors</strong><small>See how you can reach our community.</small></div><span class="side-arrow">→</span></a>
            <div class="side-card"><span class="hex-ico">🎓</span><div><strong>A student project</strong><small>StreamHive is made by Team 2 at Karel de Grote University of Applied Sciences, Antwerp.</small></div></div>
            <div class="response-time"><span class="live-dot"></span>We usually reply within <strong>2 working days</strong></div>
          </aside>

          <form class="contact-card form" id="contact-form" novalidate>
            <h2>Send us a message</h2>
            <div class="form-row">
              <label class="grow">Your name<input name="name" maxlength="80" autocomplete="name" value="${me ? esc(me.displayName) : ''}" placeholder="Your name"><span class="field-error" data-for="name"></span></label>
              <label class="grow">Email<input name="email" type="email" maxlength="200" autocomplete="email" placeholder="you@example.com"><span class="field-error" data-for="email"></span></label>
            </div>
            <fieldset class="topics">
              <legend>What is it about?</legend>
              ${CONTACT_TOPICS.map(([v, i, l], n) => `<label class="topic"><input type="radio" name="kind" value="${v}" ${n === 0 ? 'checked' : ''}><span>${i} ${esc(l)}</span></label>`).join('')}
            </fieldset>
            <label>Subject <span class="muted">(optional)</span><input name="subject" maxlength="120" placeholder="A short summary"></label>
            <label>Message<textarea name="message" rows="6" maxlength="2000" placeholder="Tell us what's on your mind…"></textarea><span class="char-count" id="char-count">0 / 2000</span><span class="field-error" data-for="message"></span></label>
            <p class="form-error" hidden></p>
            <div class="form-foot">
              <div class="consent">
                <label class="check"><input type="checkbox" name="consent"><span>You may use my details to reply. <a class="accent" href="#/privacy">Privacy policy</a></span></label>
                <span class="field-error" data-for="consent"></span>
              </div>
              <button class="btn btn-primary btn-lg" type="submit">Send message ✉️</button>
            </div>
          </form>
        </div>

        <section class="l-section">
          <h2 class="l-title">Before you write</h2>
          ${faq([
            ['I forgot my password. What now?', '<p>In this prototype you can simply create a new account. At launch you will be able to reset your password by email.</p>'],
            ['How do I report a stream?', '<p>Open the channel, go to the About tab and press <strong>⚑ Report this channel</strong>, or choose "Report a problem" in the form above. Reports are confidential.</p>'],
            ['Can my school or company use StreamHive?', '<p>We would love to hear about it. Choose "School or press" or "Brands &amp; sponsors" above and tell us what you have in mind.</p>'],
          ])}
        </section>
      </div>`;

    const form = $('#contact-form');
    const message = $('[name=message]', form);
    const count = $('#char-count');
    message.addEventListener('input', () => { count.textContent = `${message.value.length} / 2000`; });

    const setFieldError = (name, msg) => {
      const el = $(`.field-error[data-for="${name}"]`, form);
      if (el) el.textContent = msg || '';
      const input = $(`[name="${name}"]`, form);
      if (input) input.toggleAttribute('aria-invalid', !!msg);
    };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      const errors = {
        name: (data.name || '').trim().length < 2 ? 'Please tell us your name.' : '',
        email: !EMAIL_RE.test((data.email || '').trim()) ? 'Please enter a valid email address so we can reply.' : '',
        message: (data.message || '').trim().length < 10 ? 'Please write at least 10 characters.' : '',
        consent: data.consent ? '' : 'Please tick this so we may reply to you.',
      };
      Object.entries(errors).forEach(([k, v]) => setFieldError(k, v));
      const first = Object.keys(errors).find((k) => errors[k]);
      showFormError(form, '');
      if (first) {
        const input = $(`[name="${first}"]`, form);
        if (input) input.focus();
        return;
      }
      setBusy(form, true);
      try {
        await api('/feedback', {
          method: 'POST',
          body: { kind: data.kind, name: data.name.trim(), email: data.email.trim(), subject: (data.subject || '').trim(), message: data.message.trim() },
        });
        const topic = CONTACT_TOPICS.find(([v]) => v === data.kind);
        form.innerHTML = `
          <div class="success">
            <div class="success-icon">🐝</div>
            <h2>Thanks, ${esc(data.name.trim())}!</h2>
            <p>Your message about <strong>${esc(topic ? topic[2].toLowerCase() : 'your question')}</strong> is in the hive. We'll reply to <strong>${esc(data.email.trim())}</strong> within two working days.</p>
            <button class="btn" type="button" id="contact-again">Send another message</button>
          </div>`;
        $('#contact-again').addEventListener('click', () => router());
      } catch (err) {
        setBusy(form, false);
        showFormError(form, err.message);
      }
    });
  }

  // =========================================================================
  // Hive Pro — the streamer subscription (€19.99 / month)
  // =========================================================================
  const PRO_PERKS = [
    ['🎥', 'HD streaming', 'Stream in up to 1080p with a much higher bitrate, for a sharper picture and smoother games.', ''],
    ['💸', 'Lower fee', 'Pay a 6% fee instead of 8% on every donation and supporter payment. Viewers pay exactly the same.', ''],
    ['👑', 'PRO badge', 'A honey-gold PRO badge next to your name in chat, on your channel and in Browse.', ''],
    ['🚀', 'Boosted discovery', 'Pro channels are shown higher in Rising channels, so new viewers find you faster.', ''],
    ['📊', 'Advanced analytics', 'Average donation, unique supporters and your best day to stream, right in your dashboard.', ''],
    ['🛟', 'Priority support', 'Your messages to our team jump the queue, with answers within 24 hours.', ''],
    ['🚫', 'No ads', 'Watch and browse StreamHive without ads or sponsored messages — just streams.', ''],
    ['🎞️', 'Stream recordings', 'Keep your streams for 30 days and share the best moments as highlights.', 'Coming soon'],
    ['🎨', 'Custom alerts & emotes', 'Your own alert colours and sounds, plus custom chat emotes for your community.', 'Coming soon'],
  ];

  function proCheckout(onDone) {
    const P = state.config.pro;
    const next = Date.now() + 30 * 24 * 60 * 60 * 1000;
    let upgraded = false;
    const m = openModal(`
      <h2>👑 Upgrade to Hive Pro</h2>
      <p class="muted">HD streaming, a ${Math.round(P.fee * 100)}% fee, the PRO badge, boosted discovery, advanced analytics and no ads.</p>
      <div class="breakdown">
        <div><span>Hive Pro · monthly</span><span>${money(P.price)}</span></div>
        <div><span>First payment</span><span>today</span></div>
        <div class="strong"><span>Next payment</span><span>${fmtDate(next)}</span></div>
      </div>
      <p class="muted small">Cancel anytime on the Hive Pro page. You keep Pro until the end of the month you paid for, and you're never charged twice.</p>
      <p class="form-error" hidden></p>
      <button class="btn btn-primary btn-block btn-lg" type="button" id="pro-confirm">Pay ${money(P.price)} and upgrade</button>
      ${DEMO_NOTE}`, {
      // Refresh the page behind the modal once the welcome screen is closed.
      onClose: () => { if (upgraded && onDone) onDone(); },
    });
    $('#pro-confirm', m.body).addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const r = await api('/premium', { method: 'POST' });
        state.me = r.user;
        renderAccount();
        m.body.innerHTML = `
          <div class="success">
            <div class="success-icon">👑</div>
            <h2>Welcome to Hive Pro!</h2>
            <p>${r.charged ? `You paid ${money(r.charged.amount)}. ` : ''}Your PRO badge, HD streaming and ${Math.round(P.fee * 100)}% fee are active right away. Next payment on ${fmtDate(r.premium.renewsAt)}.</p>
            <div class="row center"><a class="btn btn-primary" href="live.html">Go live in HD</a><button class="btn" type="button" id="pro-done">Done</button></div>
          </div>`;
        upgraded = true;
        $('#pro-done', m.body).addEventListener('click', m.close);
      } catch (err) {
        e.target.disabled = false;
        const box = $('.form-error', m.body);
        box.textContent = err.message;
        box.hidden = false;
      }
    });
  }

  async function pagePremium(ctx) {
    const P = state.config.pro;
    const std = Math.round(state.config.platformFee * 100);
    const pro = Math.round(P.fee * 100);
    const breakEven = Math.ceil(P.price / (state.config.platformFee - P.fee));
    let info = { premium: null, payments: [] };
    if (state.me) {
      try { info = await api('/premium'); } catch { /* show the page anyway */ }
    }
    if (!ctx.alive()) return;
    const pm = info.premium && info.premium.active ? info.premium : null;

    const card = pm
      ? `<div class="pro-price-card is-pro">
          <span class="pro-crown">👑</span>
          <h2>You're on Hive Pro</h2>
          <p class="muted">${pm.status === 'cancelled'
            ? `Cancelled — your perks stay active until <strong>${fmtDate(pm.renewsAt)}</strong>. No further payments.`
            : `Renews on <strong>${fmtDate(pm.renewsAt)}</strong> for ${money(P.price)}.`}</p>
          <ul class="l-list good"><li>HD streaming is on</li><li>Your fee is ${pro}%</li><li>PRO badge visible</li><li>Pro analytics in your dashboard</li><li>Ad-free watching</li></ul>
          ${pm.status === 'cancelled'
            ? '<button class="btn btn-primary btn-block btn-lg" type="button" id="pro-resume">Resume Hive Pro</button>'
            : '<a class="btn btn-primary btn-block btn-lg" href="#/dashboard">Open Pro analytics</a><button class="btn btn-ghost btn-block" type="button" id="pro-cancel">Cancel Hive Pro</button>'}
        </div>`
      : `<div class="pro-price-card">
          <span class="pro-crown">👑</span>
          <h2>Hive Pro</h2>
          <div class="pro-price">${money(P.price)}<span> / month</span></div>
          <p class="muted small">For streamers · billed monthly · cancel anytime</p>
          <ul class="l-list good"><li>HD streaming up to 1080p</li><li>${pro}% fee instead of ${std}%</li><li>PRO badge &amp; boosted discovery</li><li>Advanced analytics</li><li>No ads</li></ul>
          <button class="btn btn-primary btn-block btn-lg btn-glow" type="button" id="pro-buy">Upgrade to Hive Pro</button>
          <p class="muted small center">Viewers never pay more — you simply keep more.</p>
        </div>`;

    app.innerHTML = `
      <div class="premium">
        <section class="pro-hero">
          <div class="honeycomb" aria-hidden="true"></div>
          <div class="pro-hero-text">
            <span class="eyebrow">👑 Hive Pro · for streamers</span>
            <h1>Stream sharper.<br><span class="grad">Keep more of your honey.</span></h1>
            <p class="lead">Hive Pro gives growing streamers HD streaming, a lower fee, a PRO badge, deeper insights and no ads — for ${money(P.price)} a month. Your viewers pay exactly the same; you simply keep more.</p>
            <ul class="l-checks"><li>Cancel anytime</li><li>Perks until the end of the paid month</li><li>Never charged twice</li></ul>
          </div>
          ${card}
        </section>

        <section class="l-section">
          <span class="kicker">What you get</span>
          <h2 class="l-title">Everything in Hive Pro</h2>
          <div class="perk-grid">
            ${PRO_PERKS.map(([i, t, d, soon]) => `
              <div class="perk ${soon ? 'is-soon' : ''}">
                ${soon ? `<span class="soon-badge">${esc(soon)}</span>` : ''}
                <div class="hex-ico">${i}</div>
                <h3>${esc(t)}</h3>
                <p class="muted">${esc(d)}</p>
              </div>`).join('')}
          </div>
        </section>

        <section class="l-section">
          <span class="kicker">Compare</span>
          <h2 class="l-title">Free vs Hive Pro</h2>
          <div class="compare-table" role="table" aria-label="Free compared with Hive Pro">
            <div class="ct-row ct-head" role="row"><span role="columnheader"></span><span role="columnheader">Free</span><span role="columnheader">👑 Hive Pro</span></div>
            ${[
              ['Go live from phone or browser', '✓', '✓'],
              ['Donations & monthly supporters', '✓', '✓'],
              ['Chat, community & supporter wall', '✓', '✓'],
              ['Stream quality', 'Up to 720p', 'Up to 1080p HD'],
              ['Fee on donations & support', `${std}%`, `${pro}%`],
              ['PRO badge', '—', '✓'],
              ['Boosted in Rising channels', '—', '✓'],
              ['Advanced analytics', '—', '✓'],
              ['Priority support', '—', '✓'],
              ['No ads', '—', '✓'],
              ['Stream recordings', '—', 'Coming soon'],
              ['Custom alerts & emotes', '—', 'Coming soon'],
              ['Price', 'Free', `${money(P.price)} / month`],
            ].map(([a, b, c]) => `<div class="ct-row" role="row"><span role="cell">${esc(a)}</span><span role="cell" class="${b === '—' ? 'ct-no' : ''}">${esc(b)}</span><span role="cell" class="ct-pro">${esc(c)}</span></div>`).join('')}
          </div>
        </section>

        <section class="calc-section">
          <div class="calc-text">
            <span class="kicker left">Does it pay off?</span>
            <h2 class="l-title left">Hive Pro pays for itself from ${money(breakEven)} a month</h2>
            <p class="l-sub left">The lower fee saves you ${std - pro}% of everything you receive. Move the slider to see what that means for you. Below the break-even point, you're paying for HD, the badge, analytics and visibility.</p>
            <div class="calc-controls one">
              <label>Monthly donations &amp; support <output id="pro-o">€500</output><input type="range" id="pro-r" min="0" max="3000" step="50" value="500"></label>
            </div>
          </div>
          <div class="calc-result">
            <span class="muted">Fee you save with Hive Pro</span>
            <strong id="pro-save">€0</strong>
            <div class="breakdown" id="pro-break"></div>
          </div>
        </section>

        ${info.payments && info.payments.length ? `
        <section class="section">
          <h2>Billing history</h2>
          <div class="card"><div class="table">${info.payments.map((p) => `
            <div class="tr"><div class="grow"><strong>Hive Pro${p.renewal ? ' renewal' : ''}</strong><div class="muted small">${fmtDate(p.createdAt)} · receipt ${esc(p.id)}</div></div><strong>${money(p.amount)}</strong></div>`).join('')}</div></div>
        </section>` : ''}

        <section class="l-section">
          <span class="kicker">FAQ</span>
          <h2 class="l-title">Hive Pro questions</h2>
          ${faq([
            ['Do my viewers pay more?', '<p>No. Viewers pay exactly the same. With Hive Pro, a bigger part of every donation and supporter payment goes to you.</p>'],
            ['Who gets the "no ads" perk?', '<p>You do: with Hive Pro you watch and browse StreamHive without ads or sponsored messages. Your viewers see what their own plan includes.</p>'],
            ['What happens when I cancel?', '<p>You keep all Pro perks until the end of the month you paid for. After that your channel switches back to the free plan — nothing is deleted.</p>'],
            ['When am I charged?', `<p>The first ${money(P.price)} is charged when you upgrade, then every 30 days until you cancel.</p>`],
            ['Do I need Hive Pro to earn money?', '<p>No. Donations, monthly supporters, chat and everything else stay free. Hive Pro is for streamers who want more quality, visibility and insights.</p>'],
            ['Is this a real payment?', '<p>Not in this prototype — payments are simulated. At launch they will be handled by a licensed payment provider.</p>'],
          ])}
        </section>

        ${pm ? '' : `
        <section class="l-cta">
          <div class="honeycomb" aria-hidden="true"></div>
          <div class="cta-bee" aria-hidden="true">👑</div>
          <h2>Ready to grow your hive?</h2>
          <p>Upgrade in two taps. Cancel anytime.</p>
          <div class="row center"><button class="btn btn-primary btn-lg btn-glow" type="button" id="pro-buy-2">Upgrade for ${money(P.price)} / month</button></div>
        </section>`}
      </div>`;

    // Break-even calculator
    const slider = $('#pro-r');
    const calc = () => {
      const earn = Number(slider.value) * 100;
      const saved = feeOf(earn) - Math.round(earn * P.fee);
      $('#pro-o').textContent = money(earn).replace(/[.,]00(?=\D*$)/, '');
      $('#pro-save').textContent = money(saved);
      const diff = saved - P.price;
      $('#pro-break').innerHTML = `
        <div><span>Fee at ${std}% (free)</span><span>${money(feeOf(earn))}</span></div>
        <div><span>Fee at ${pro}% (Hive Pro)</span><span>${money(Math.round(earn * P.fee))}</span></div>
        <div><span>Hive Pro price</span><span>−${money(P.price)}</span></div>
        <div class="strong"><span>${diff >= 0 ? 'You come out ahead by' : 'Pro costs you net'}</span><span class="${diff >= 0 ? 'accent' : ''}">${money(Math.abs(diff))}</span></div>`;
    };
    slider.addEventListener('input', calc);
    calc();

    const reload = () => router();
    const buy = () => (state.me ? proCheckout(reload) : loginFor({ type: 'pro', username: '' }));
    ['#pro-buy', '#pro-buy-2'].forEach((sel) => { const b = $(sel); if (b) b.addEventListener('click', buy); });
    const cancel = $('#pro-cancel');
    if (cancel) {
      cancel.addEventListener('click', async () => {
        if (!window.confirm(`Cancel Hive Pro? You keep your perks until ${fmtDate(pm.renewsAt)}.`)) return;
        try {
          const r = await api('/premium', { method: 'DELETE' });
          state.me = r.user;
          toast('Hive Pro cancelled. Your perks stay active until the end of this month.');
          reload();
        } catch (e) {
          toast(e.message, 'error');
        }
      });
    }
    const resume = $('#pro-resume');
    if (resume) {
      resume.addEventListener('click', async () => {
        try {
          const r = await api('/premium', { method: 'POST' });
          state.me = r.user;
          toast('Hive Pro resumed. Nothing was charged today.', 'success');
          reload();
        } catch (e) {
          toast(e.message, 'error');
        }
      });
    }

    const pending = state.pendingAction;
    if (pending && pending.type === 'pro' && state.me) {
      state.pendingAction = null;
      if (!pm) proCheckout(reload);
    }
  }

  // =========================================================================
  // Stream presets — ready-made studio setups
  // =========================================================================
  const PRESET_GROUPS = [
    ['all', '✨ All'], ['starter', '🌱 Starters'], ['gaming', '🎮 Gaming'], ['chatting', '💬 Just Chatting'],
    ['music', '🎵 Music'], ['creative', '🎨 Creative'], ['irl', '🏕️ IRL & lifestyle'], ['learning', '📚 Learning'],
  ];
  const PRESETS = [
    {
      id: 'first-stream', group: 'starter', emoji: '🌱', hue: 140, name: 'My first stream', level: 'Easiest',
      source: 'camera', facing: 'user', mic: 'voice', category: 'Just Chatting', device: 'Phone or laptop', hd: false,
      title: 'My first stream — come say hi! 👋',
      blurb: 'The simplest setup there is: front camera, a clear voice and a friendly title. Perfect for going live for the very first time.',
      tips: ['Face a window or a lamp so your face is well lit.', 'Pick a quiet room and close other apps.', 'Use Wi-Fi if you can.', 'Say hi to everyone who joins — even if it is just one person!'],
    },
    {
      id: 'phone-quick', group: 'starter', emoji: '📱', hue: 200, name: 'Phone-only quick start', level: 'Easiest',
      source: 'camera', facing: 'user', mic: 'voice', category: 'Just Chatting', device: 'Phone', hd: false,
      title: 'Live from my phone 📱',
      blurb: 'No computer needed. Lean your phone against something stable and start talking.',
      tips: ['Hold or place your phone horizontally for a wide picture.', 'Lean it against books or a cup so it stays steady.', 'Plug in your charger for longer streams.', 'Mobile data works, but Wi-Fi gives a smoother picture.'],
    },
    {
      id: 'cozy-chat', group: 'chatting', emoji: '💬', hue: 340, name: 'Cozy chat', level: 'Easy',
      source: 'camera', facing: 'user', mic: 'voice', category: 'Just Chatting', device: 'Phone or laptop', hd: false,
      title: 'Chill chat & Q&A — ask me anything ✨',
      blurb: 'A relaxed talk with your community. Voice-optimised mic so chat can hear you clearly.',
      tips: ['Read chat messages out loud before you answer them.', 'Have a topic ready for quiet moments.', 'Post your next stream time on your community wall.'],
    },
    {
      id: 'podcast', group: 'chatting', emoji: '🎙️', hue: 300, name: 'Talk show / podcast', level: 'Easy',
      source: 'camera', facing: 'user', mic: 'voice', category: 'Just Chatting', device: 'Laptop', hd: false,
      title: 'Live podcast: this week\'s topic 🎙️',
      blurb: 'A live show around one topic, with chat as your co-host.',
      tips: ['Keep your microphone close and steady.', 'Prepare three talking points.', 'Ask chat a question every few minutes to keep them involved.'],
    },
    {
      id: 'pc-gaming', group: 'gaming', emoji: '🎮', hue: 210, name: 'PC gaming', level: 'Easy',
      source: 'screen', facing: 'user', mic: 'voice', category: 'Gaming', device: 'Computer', hd: true,
      title: 'Ranked grind — come hang out 🎮',
      blurb: 'Share your game window with your voice mixed in. No OBS, no capture card.',
      tips: ['Share the game window instead of your whole screen.', 'Tick "share audio" in the browser so viewers hear the game.', 'Turn off notifications so they don\'t pop up on stream.', 'On a slower laptop, lower the game graphics a little.'],
    },
    {
      id: 'console', group: 'gaming', emoji: '🕹️', hue: 260, name: 'Console & handheld', level: 'Easy',
      source: 'camera', facing: 'environment', mic: 'voice', category: 'Gaming', device: 'Phone', hd: false,
      title: 'Retro night on the console 🕹️',
      blurb: 'Point your phone\'s back camera at the TV or handheld — the simplest way to stream console games.',
      tips: ['Point the back camera straight at the screen.', 'Dim the room lights to avoid reflections.', 'Put the phone on a stand so the picture stays still.'],
    },
    {
      id: 'live-music', group: 'music', emoji: '🎸', hue: 25, name: 'Live music', level: 'Medium',
      source: 'camera', facing: 'user', mic: 'music', category: 'Music', device: 'Phone or laptop', hd: true,
      title: 'Live acoustic session — requests welcome 🎶',
      blurb: 'The music mic profile turns off noise filters, so instruments and singing sound natural.',
      tips: ['Place your phone one to two metres away.', 'Tune your instrument before you go live.', 'Ask chat for requests and thank donations between songs.'],
    },
    {
      id: 'beat-making', group: 'music', emoji: '🎧', hue: 320, name: 'Beat making', level: 'Medium',
      source: 'screen', facing: 'user', mic: 'music', category: 'Music', device: 'Computer', hd: true,
      title: 'Making beats live — pick the vibe 🎧',
      blurb: 'Share your music software with its sound, and let chat shape the track.',
      tips: ['Share the window of your music software.', 'Tick "share audio" so viewers hear what you make.', 'Keep your speakers low to avoid echo.'],
    },
    {
      id: 'art', group: 'creative', emoji: '🎨', hue: 280, name: 'Art & drawing', level: 'Medium',
      source: 'camera', facing: 'environment', mic: 'voice', category: 'Art & Creative', device: 'Phone', hd: false,
      title: 'Drawing your requests ✏️',
      blurb: 'Back camera above your paper, so viewers watch every stroke.',
      tips: ['Mount your phone above the paper (a stack of books works).', 'Use steady light from the side to avoid shadows.', 'Show the finished piece at the end of the stream.'],
    },
    {
      id: 'cooking', group: 'irl', emoji: '🍳', hue: 30, name: 'Cooking', level: 'Easy',
      source: 'camera', facing: 'environment', mic: 'voice', category: 'Cooking', device: 'Phone', hd: false,
      title: 'Cooking along: tonight\'s recipe 🍳',
      blurb: 'Back camera on your counter or pan, voice mic to talk through each step.',
      tips: ['Post the ingredients on your community wall before the stream.', 'Keep your phone away from heat and water.', 'Show the finished dish up close.'],
    },
    {
      id: 'fitness', group: 'irl', emoji: '🏋️', hue: 150, name: 'Workout', level: 'Easy',
      source: 'camera', facing: 'user', mic: 'voice', category: 'Fitness', device: 'Phone', hd: false,
      title: '20-minute workout — join in! 💪',
      blurb: 'Front camera far enough away to show your whole body.',
      tips: ['Place the phone two to three metres away.', 'Make sure your whole body is in the frame.', 'Start with a warm-up and show easier versions of each exercise.'],
    },
    {
      id: 'outdoors', group: 'irl', emoji: '🏕️', hue: 100, name: 'Outdoors & IRL', level: 'Medium',
      source: 'camera', facing: 'environment', mic: 'voice', category: 'Outdoors', device: 'Phone', hd: false,
      title: 'Live from outside 🌄',
      blurb: 'Back camera to show the world around you, with noise filtering against wind.',
      tips: ['Check your mobile data before you start.', 'Bring a power bank.', 'Ask before filming people — see the community guidelines.'],
    },
    {
      id: 'study', group: 'learning', emoji: '📚', hue: 185, name: 'Study with me', level: 'Easiest',
      source: 'camera', facing: 'user', mic: 'voice', category: 'Education', device: 'Laptop', hd: false,
      title: 'Study with me — 50/10 pomodoro 📚',
      blurb: 'A calm, focused stream. Mute your mic during study blocks and chat in the breaks.',
      tips: ['Tell chat what you are studying and how long the blocks are.', 'Use the Mic button to mute during focus time.', 'Chat with viewers during the breaks.'],
    },
    {
      id: 'coding', group: 'learning', emoji: '💻', hue: 230, name: 'Coding & tech', level: 'Medium',
      source: 'screen', facing: 'user', mic: 'voice', category: 'Tech', device: 'Computer', hd: true,
      title: 'Building an app from scratch 💻',
      blurb: 'Share your editor and explain what you build. HD keeps small text readable.',
      tips: ['Make your editor font bigger so text is readable.', 'Never show passwords, keys or private messages on screen.', 'Explain what you are doing as you type.'],
    },
  ];
  const presetById = (pid) => PRESETS.find((p) => p.id === pid) || null;
  const presetSource = (p) => (p.source === 'screen' ? '🖥️ Screen share' : p.facing === 'environment' ? '📷 Back camera' : '🤳 Front camera');
  const presetMic = (p) => (p.mic === 'music' ? '🎵 Music mic' : '🎙️ Voice mic');
  const groupLabel = (g) => (PRESET_GROUPS.find(([k]) => k === g) || ['', ''])[1];

  function usePreset(pid) {
    storage.set('sh_preset', pid);
    const p = presetById(pid);
    toast(`Preset "${p ? p.name : ''}" is ready in your studio.`, 'success');
    // While live, stay in this document so the broadcast keeps running.
    if (studio.live) location.hash = '#/live';
    else location.href = 'live.html';
  }

  function presetCard(p) {
    return `
      <article class="preset-card" style="--h:${p.hue}" data-group="${p.group}" data-text="${esc(`${p.name} ${p.category} ${p.blurb}`.toLowerCase())}">
        <div class="preset-cover">
          <span class="preset-emoji">${p.emoji}</span>
          <span class="preset-level">${esc(p.level)}</span>
          ${p.hd ? '<span class="badge badge-pro preset-hd" title="HD with Hive Pro">HD · PRO</span>' : ''}
        </div>
        <div class="preset-body">
          <span class="preset-group">${esc(groupLabel(p.group))}</span>
          <h3>${esc(p.name)}</h3>
          <p class="muted small">${esc(p.blurb)}</p>
          <ul class="preset-specs">
            <li>${presetSource(p)}</li><li>${presetMic(p)}</li>
            <li>${CAT_ICONS[p.category] || '✨'} ${esc(p.category)}</li><li>📍 ${esc(p.device)}</li>
          </ul>
          <div class="preset-actions">
            <button class="btn btn-primary btn-small grow" type="button" data-use="${p.id}">Use preset</button>
            <button class="btn btn-small" type="button" data-details="${p.id}">Details</button>
          </div>
        </div>
      </article>`;
  }

  function presetDetails(p) {
    const m = openModal(`
      <div class="preset-modal-head" style="--h:${p.hue}"><span>${p.emoji}</span></div>
      <h2>${esc(p.name)}</h2>
      <p class="muted">${esc(p.blurb)}</p>
      <div class="breakdown">
        <div><span>Source</span><span>${presetSource(p)}</span></div>
        <div><span>Microphone</span><span>${presetMic(p)}</span></div>
        <div><span>Category</span><span>${esc(p.category)}</span></div>
        <div><span>Works best on</span><span>${esc(p.device)}</span></div>
        <div><span>Quality</span><span>${p.hd ? (state.me && state.me.pro ? 'HD 1080p 👑' : 'HD with Hive Pro, otherwise 720p') : 'Standard 720p'}</span></div>
      </div>
      <p class="small"><strong>Suggested title:</strong> “${esc(p.title)}”</p>
      <h3>Setup tips</h3>
      <ul class="l-list good">${p.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      <button class="btn btn-primary btn-block btn-lg" type="button" id="preset-use-modal">Use this preset</button>`);
    $('#preset-use-modal', m.body).addEventListener('click', () => {
      m.close();
      usePreset(p.id);
    });
  }

  function pagePresets() {
    const featured = presetById('first-stream');
    app.innerHTML = `
      <div class="presets">
        <section class="presets-hero">
          <div class="honeycomb" aria-hidden="true"></div>
          <div>
            <span class="eyebrow">✨ Stream presets</span>
            <h1>Start with a setup that <span class="grad">just works</span></h1>
            <p class="lead">Pick a preset for what you want to stream. We set up your camera or screen, microphone, category and title — you just press Go live.</p>
            <ul class="l-checks"><li>${PRESETS.length} ready-made setups</li><li>Free for everyone</li><li>Change anything afterwards</li></ul>
          </div>
          <div class="featured-preset" style="--h:${featured.hue}">
            <span class="featured-preset-tag">⭐ Best for beginners</span>
            <div class="featured-preset-emoji">${featured.emoji}</div>
            <h3>${esc(featured.name)}</h3>
            <p class="muted small">${esc(featured.blurb)}</p>
            <button class="btn btn-primary btn-block" type="button" data-use="${featured.id}">Use this preset</button>
          </div>
        </section>

        <div class="preset-toolbar">
          <div class="chips" id="preset-groups" role="tablist">
            ${PRESET_GROUPS.map(([k, l], i) => `<button class="chip ${i === 0 ? 'active' : ''}" type="button" data-group="${k}">${esc(l)}</button>`).join('')}
          </div>
          <input type="search" id="preset-search" placeholder="Search presets…" aria-label="Search presets" autocomplete="off">
        </div>
        <div class="preset-grid" id="preset-grid">${PRESETS.map(presetCard).join('')}</div>
        <div class="empty" id="preset-empty" hidden>No presets match. Try another word or category.</div>

        <section class="l-section">
          <span class="kicker">How presets work</span>
          <h2 class="l-title">Three taps to a great-looking stream</h2>
          <div class="pain-grid">
            <div class="pain-card"><div class="hex-ico">👆</div><h3>1. Pick a preset</h3><p class="muted">Choose what you want to stream: chatting, gaming, music, cooking and more.</p></div>
            <div class="pain-card"><div class="hex-ico">⚙️</div><h3>2. We set up the studio</h3><p class="muted">Camera or screen, the right microphone profile, a category and a suggested title.</p></div>
            <div class="pain-card"><div class="hex-ico">🔴</div><h3>3. Press Go live</h3><p class="muted">Tweak anything you like, then go live. Your followers are notified straight away.</p></div>
          </div>
        </section>

        <section class="promo-band">
          <div><h2>Missing a preset?</h2><p class="muted">Tell us what you stream and we'll build a setup for it.</p></div>
          <a class="btn btn-primary btn-lg" href="contact.html">Suggest a preset</a>
        </section>
      </div>`;

    let group = 'all';
    const filter = () => {
      const q = $('#preset-search').value.trim().toLowerCase();
      let shown = 0;
      $$('.preset-card').forEach((c) => {
        const ok = (group === 'all' || c.dataset.group === group) && (!q || c.dataset.text.includes(q));
        c.hidden = !ok;
        if (ok) shown += 1;
      });
      $('#preset-empty').hidden = shown > 0;
    };
    $$('#preset-groups .chip').forEach((b) => b.addEventListener('click', () => {
      group = b.dataset.group;
      $$('#preset-groups .chip').forEach((x) => x.classList.toggle('active', x === b));
      filter();
    }));
    $('#preset-search').addEventListener('input', filter);
    $('.presets').addEventListener('click', (e) => {
      const use = e.target.closest('[data-use]');
      if (use) return usePreset(use.dataset.use);
      const det = e.target.closest('[data-details]');
      if (det) presetDetails(presetById(det.dataset.details));
      return undefined;
    });
  }

  function pageNotFound() {
    app.innerHTML = '<section class="empty-page"><h1>Page not found</h1><a class="btn btn-primary" href="browse.html">Back to browse</a></section>';
  }

  // =========================================================================
  // Router
  // =========================================================================
  const ROUTES = [
    [/^\/?$/, pageIndex, 'home'],
    [/^\/about\/?$/, pageLanding, null],
    [/^\/browse\/?$/, pageBrowse, 'home'],
    [/^\/pricing\/?$/, pagePricing, 'pricing'],
    [/^\/help\/?$/, pageHelp, null],
    [/^\/guidelines\/?$/, pageGuidelines, null],
    [/^\/advertise\/?$/, pageAdvertise, null],
    [/^\/terms\/?$/, pageTerms, null],
    [/^\/privacy\/?$/, pagePrivacy, null],
    [/^\/about-us\/?$/, pageAboutUs, 'about-us'],
    [/^\/contact\/?$/, pageContact, 'contact'],
    [/^\/premium\/?$/, pagePremium, 'pricing'],
    [/^\/presets\/?$/, pagePresets, 'presets'],
    [/^\/following\/?$/, pageFollowing, 'following'],
    [/^\/c\/([A-Za-z0-9_]{3,20})\/?$/, pageChannel, null],
    [/^\/live\/?$/, pageStudio, 'live'],
    [/^\/dashboard\/?$/, pageDashboard, null],
    [/^\/support\/?$/, pageSupport, 'support'],
    [/^\/settings\/?$/, pageSettings, null],
  ];
  const PAGE_DEFAULTS = { browse: '/browse', following: '/following', live: '/live', about: '/about-us', contact: '/contact', premium: '/premium', presets: '/presets' };
  const FILE_ROUTES = { 'index.html': '#/', 'browse.html': '#/browse', 'following.html': '#/following', 'live.html': '#/live', 'about.html': '#/about-us', 'contact.html': '#/contact', 'premium.html': '#/premium', 'presets.html': '#/presets' };

  // While live, switching to another HTML page would reload the document and cut the stream.
  // Navigate inside the current document instead so the broadcast keeps running.
  document.addEventListener('click', (e) => {
    if (!studio.live || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const a = e.target.closest('a[href]');
    if (!a) return;
    const target = FILE_ROUTES[a.getAttribute('href')];
    if (!target) return;
    e.preventDefault();
    if (location.hash === target) router();
    else location.hash = target;
  });

  let routeSeq = 0;
  let cleanups = [];

  function router() {
    const hash = location.hash.replace(/^#/, '');
    for (const fn of cleanups.splice(0)) {
      try { fn(); } catch (e) { console.error(e); }
    }
    closeAllModals();
    const seq = ++routeSeq;
    const list = [];
    cleanups = list;
    const ctx = { alive: () => seq === routeSeq, cleanup: (fn) => list.push(fn) };
    // Each HTML file (browse.html, following.html, live.html) opens its own page; hash routes work on every file.
    const path = hash.startsWith('/') ? hash : PAGE_DEFAULTS[document.body.dataset.page] || '/';
    state.path = path;
    let page = pageNotFound;
    let args = [];
    let navKey = null;
    for (const [re, fn, key] of ROUTES) {
      const m = re.exec(path);
      if (m) {
        page = fn;
        args = m.slice(1);
        navKey = key;
        if (fn === pageIndex && !state.me) navKey = null; // the landing page is not "Browse"
        break;
      }
    }
    $$('#nav a').forEach((a) => {
      const on = a.dataset.nav === navKey;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    renderLivePill();
    window.scrollTo(0, 0);
    Promise.resolve()
      .then(() => page(ctx, ...args))
      .catch((e) => {
        console.error(e);
        if (ctx.alive()) app.innerHTML = `<section class="empty-page"><h1>Something went wrong</h1><p class="muted">${esc(e.message)}</p><a class="btn btn-primary" href="browse.html">Back to browse</a></section>`;
      });
  }

  // =========================================================================
  // Boot
  // =========================================================================
  // Demo mode: opened from the file system (or with ?demo), or the server can't be reached.
  // The pages then run on sample data from mock.js instead of the real API.
  function enableDemo() {
    state.mock = window.StreamHiveMock.create({ emit, isLive: () => studio.live });
    document.body.classList.add('demo');
  }

  // Light / dark theme switch (theme.js already applied the saved or system theme before paint).
  function setupThemeToggle() {
    const btn = $('#theme-toggle');
    const apply = (theme) => {
      document.documentElement.setAttribute('data-theme', theme);
      const meta = $('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', theme === 'light' ? '#fff8e5' : '#120d06');
      if (btn) {
        const label = theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
        btn.title = label;
        btn.setAttribute('aria-label', label);
        btn.setAttribute('aria-pressed', String(theme === 'light'));
      }
    };
    apply(document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
    if (btn) {
      btn.addEventListener('click', () => {
        const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        storage.set('sh_theme', next);
        apply(next);
      });
    }
  }

  async function init() {
    setupThemeToggle();
    const wantDemo = location.protocol === 'file:' || /[?&]demo\b/.test(location.search);
    if (wantDemo && window.StreamHiveMock) enableDemo();
    try {
      state.config = await api('/config');
    } catch (e) {
      if (!window.StreamHiveMock) {
        app.innerHTML = `<section class="empty-page"><h1>Can't reach StreamHive</h1><p class="muted">${esc(e.message)}</p><button class="btn btn-primary" id="retry-boot">Retry</button></section>`;
        $('#retry-boot').addEventListener('click', () => location.reload());
        return;
      }
      enableDemo();
      state.config = await api('/config');
    }
    if (state.token || state.mock) {
      try {
        const r = await api('/me');
        state.me = r.user;
        if (!r.user) setToken(null);
      } catch { /* offline: keep token for later */ }
    }
    connectEvents();
    renderAccount();
    window.addEventListener('hashchange', router);
    router();
  }

  init();
})();
