// Listening Room client
const $ = (id) => document.getElementById(id);
const room = (new URLSearchParams(location.search).get("room") || "main").toLowerCase().replace(/[^a-z0-9-]/g, "") || "main";
$("roomName").textContent = room;

const store = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
  del: (k) => localStorage.removeItem(k),
};

let userId = store.get("lr.userId");
if (!userId) { userId = crypto.randomUUID(); store.set("lr.userId", userId); }

let config = {};
let ws = null;
let state = { users: [], djs: [], current: null };
let myQueue = [];
let clockOffset = 0; // serverTime - localTime
let tunedIn = false;
let myVotes = {}; // trackId -> 1 | -1
const serverNow = () => Date.now() + clockOffset;

// ------------------------------------------------------------ helpers

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid);
  return e;
}

function color(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 55% 45%)`;
}

function avatar(user, cls = "") {
  const initials = (user?.name || "?").split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
  return el("div", { class: `avatar ${cls}`, style: `background:${color(user?.id || "x")}` }, initials);
}

function fmt(ms) {
  if (!ms || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function api(path) {
  return fetch(path, { headers: { "x-room-pass": store.get("lr.pass") || "" } }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
    return data;
  });
}

const userById = (id) => state.users.find((u) => u.id === id);

// ------------------------------------------------------------ entry + socket

async function boot() {
  config = await fetch("/api/config").then((r) => r.json());
  $("passRow").hidden = !config.passwordRequired;
  $("nameInput").value = store.get("lr.name") || "";
  $("gifBtn").hidden = !config.gifs;
  $("spotifyBtn").hidden = !config.spotifyClientId;

  await Spotify.handleRedirect();
  if (Spotify.loggedIn()) Spotify.init();

  if (store.get("lr.name") && (!config.passwordRequired || store.get("lr.pass"))) {
    $("entry").hidden = true;
    connect();
  }
}

$("entryForm").addEventListener("submit", (e) => {
  e.preventDefault();
  store.set("lr.name", $("nameInput").value.trim());
  if (config.passwordRequired) store.set("lr.pass", $("passInput").value);
  $("entry").hidden = true;
  connect();
});

let retry = 0;
function connect() {
  const qs = new URLSearchParams({ userId, name: store.get("lr.name"), pass: store.get("lr.pass") || "" });
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/${room}?${qs}`);
  ws.onopen = () => { retry = 0; $("conn").classList.add("on"); syncClock(); };
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = (e) => {
    $("conn").classList.remove("on");
    if (e.code === 1006 && retry > 2 && config.passwordRequired) {
      // Most likely a bad password
      store.del("lr.pass");
      $("entryError").textContent = "Couldn't connect. Check the room password.";
      $("entry").hidden = false;
      return;
    }
    setTimeout(connect, Math.min(10000, 1000 * 2 ** retry++));
  };
}

function send(msg) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
}

function syncClock() {
  // A few round trips; keep the one with the lowest latency.
  let best = Infinity;
  let n = 0;
  const handler = (m) => {
    const t1 = Date.now();
    const rtt = t1 - m.t0;
    if (rtt < best) { best = rtt; clockOffset = m.now - (m.t0 + rtt / 2); }
    if (++n < 5) send({ type: "time", t0: Date.now() });
  };
  timeHandler = handler;
  send({ type: "time", t0: Date.now() });
}
let timeHandler = null;
setInterval(() => ws?.readyState === 1 && syncClock(), 60_000);

function onMessage(m) {
  switch (m.type) {
    case "time": timeHandler?.(m); break;
    case "init":
      clockOffset = m.now - Date.now();
      $("messages").replaceChildren();
      m.chat.forEach(renderChat);
      break;
    case "chat": renderChat(m.msg); break;
    case "queue": myQueue = m.queue; renderQueue(); break;
    case "state":
      state = m;
      renderStage();
      Player.sync();
      break;
  }
}

// ------------------------------------------------------------ stage

function renderStage() {
  const cur = state.current;
  const seats = $("seats");
  seats.replaceChildren();
  for (let i = 0; i < 5; i++) {
    const id = state.djs[i];
    const u = id && userById(id);
    if (!u) { seats.append(el("div", { class: "seat" }, el("span", { class: "muted small" }, "open"))); continue; }
    seats.append(el("div", {
      class: `seat filled ${cur?.djId === id ? "playing" : ""} ${u.online ? "" : "offline"}`,
    }, avatar(u), el("div", { class: "nm" }, u.name + (id === userId ? " (you)" : "")),
       el("div", { class: "muted small" }, `★ ${u.score}`)));
  }

  const onStage = state.djs.includes(userId);
  $("stageBtn").textContent = onStage ? "Step down" : "Step up to DJ";
  $("stageBtn").disabled = !onStage && state.djs.length >= 5;

  const aud = $("audience");
  aud.replaceChildren(...state.users.filter((u) => u.online && !state.djs.includes(u.id))
    .map((u) => el("div", { class: "aud" }, avatar(u, "sm"), u.name)));
  if (!aud.children.length) aud.append(el("span", { class: "muted small" }, "Everyone's on stage"));

  if (cur) {
    const dj = userById(cur.djId);
    $("npArt").src = cur.track.art || "";
    $("npTitle").textContent = cur.track.title;
    $("npArtist").textContent = cur.track.artist;
    $("npDj").textContent = `${dj?.name || "Someone"} is DJing`;
    const votes = Object.values(cur.votes || {});
    $("awesomeCount").textContent = votes.filter((v) => v === 1).length;
    $("lameCount").textContent = votes.filter((v) => v === -1).length;
    const mine = cur.votes?.[userId] ?? myVotes[cur.track.id];
    $("awesome").className = `vote ${mine === 1 ? "mine-up" : ""}`;
    $("lame").className = `vote ${mine === -1 ? "mine-down" : ""}`;
    const isDj = cur.djId === userId;
    $("awesome").disabled = $("lame").disabled = isDj;
    $("skip").hidden = !isDj;
  } else {
    $("npArt").removeAttribute("src");
    $("npTitle").textContent = state.djs.length ? "Waiting for a DJ to queue a song" : "Step up to DJ to start the music";
    $("npArtist").textContent = "";
    $("npDj").textContent = "Nobody's playing";
    $("awesomeCount").textContent = $("lameCount").textContent = "0";
    $("awesome").className = $("lame").className = "vote";
    $("awesome").disabled = $("lame").disabled = true;
    $("skip").hidden = true;
  }
}

setInterval(() => {
  const cur = state.current;
  const pos = cur ? Math.max(0, serverNow() - cur.startedAt) : 0;
  const dur = cur?.track.durationMs || 0;
  $("npPos").textContent = fmt(Math.min(pos, dur || pos));
  $("npDur").textContent = fmt(dur);
  $("npBar").style.width = dur ? `${Math.min(100, (pos / dur) * 100)}%` : "0";
}, 500);

$("stageBtn").onclick = () => send({ type: state.djs.includes(userId) ? "stage_leave" : "stage_join" });
$("skip").onclick = () => send({ type: "skip" });
for (const [btn, v] of [["awesome", 1], ["lame", -1]]) {
  $(btn).onclick = () => {
    const cur = state.current;
    if (!cur) return;
    myVotes[cur.track.id] = v;
    send({ type: "vote", v, trackId: cur.track.id });
  };
}

// ------------------------------------------------------------ chat

const IMG_URL = /^https:\/\/\S+\.(gif|webp|png|jpe?g)(\?\S*)?$/i;

function renderChat(m) {
  const box = $("messages");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  let node;
  if (m.system) {
    node = el("div", { class: "msg system" }, m.text);
  } else {
    const u = { id: m.userId, name: m.name };
    const body = el("div", { class: "body" }, el("span", { class: "who", style: `color:${color(m.userId)}` }, m.name));
    const gif = m.gif || (IMG_URL.test(m.text || "") ? m.text : null);
    if (gif) {
      const img = el("img", { class: "gif", src: gif, alt: "gif", loading: "lazy" });
      img.onload = () => atBottom && (box.scrollTop = box.scrollHeight);
      body.append(img);
    } else {
      body.append(m.text);
    }
    node = el("div", { class: "msg" }, avatar(u, "sm"), body);
  }
  box.append(node);
  while (box.children.length > 150) box.firstChild.remove();
  if (atBottom) box.scrollTop = box.scrollHeight;
}

$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("chatInput").value.trim();
  if (!text) return;
  send({ type: "chat", text });
  $("chatInput").value = "";
});

$("gifBtn").onclick = () => {
  $("gifPanel").hidden = !$("gifPanel").hidden;
  if (!$("gifPanel").hidden) { $("gifSearch").focus(); loadGifs(""); }
};
let gifTimer;
$("gifSearch").addEventListener("input", () => {
  clearTimeout(gifTimer);
  gifTimer = setTimeout(() => loadGifs($("gifSearch").value), 350);
});
async function loadGifs(q) {
  try {
    const { results } = await api(`/api/gifs?q=${encodeURIComponent(q)}`);
    $("gifGrid").replaceChildren(...results.map((g) => el("img", {
      src: g.preview, loading: "lazy",
      onclick: () => { send({ type: "gif", url: g.url }); $("gifPanel").hidden = true; $("gifSearch").value = ""; },
    })));
  } catch (err) {
    $("gifGrid").replaceChildren(el("span", { class: "muted small" }, err.message));
  }
}

// ------------------------------------------------------------ search + queue

const YT_URL = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/|music\.youtube\.com\/watch\?(?:.*&)?v=)([\w-]{11})/;
let lastResults = [];

$("searchForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("searchInput").value.trim();
  if (!q) return;
  const status = $("searchStatus");
  status.textContent = "Searching…";
  try {
    const yt = YT_URL.exec(q);
    if (yt) {
      const v = await api(`/api/video?id=${yt[1]}`);
      if (!v.embeddable) throw new Error("That video doesn't allow embedding, so it can't be played here.");
      lastResults = [{ ...v, resolved: true }];
    } else {
      const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
      lastResults = data.results;
    }
    status.textContent = lastResults.length ? "" : "No results.";
    renderResults();
  } catch (err) {
    status.textContent = err.message;
  }
});

function srcTags(t) {
  return el("span", {},
    t.spotifyUri ? el("span", { class: "src sp" }, "SPOTIFY") : null,
    t.youtubeId ? el("span", { class: "src yt" }, "YOUTUBE") : null);
}

function renderResults() {
  $("results").replaceChildren(...lastResults.map((t, i) => el("div", { class: "item" },
    el("img", { src: t.art || "", alt: "" }),
    el("div", { class: "meta" },
      el("div", { class: "t", title: t.title }, t.title),
      el("div", { class: "a" }, `${t.artist} · ${fmt(t.durationMs)}`)),
    el("div", { class: "acts" },
      el("button", { title: "Add to top of queue", onclick: (e) => addTrack(i, true, e.target) }, "⤒"),
      el("button", { class: "primary", onclick: (e) => addTrack(i, false, e.target) }, "+ Queue")))));
}

async function addTrack(i, top, btn) {
  const t = { ...lastResults[i] };
  btn.disabled = true;
  const status = $("searchStatus");
  try {
    if (!t.youtubeId && config.youtube) {
      status.textContent = `Matching "${t.title}" on YouTube…`;
      const qs = new URLSearchParams({ artist: t.artist, title: t.title, durationMs: t.durationMs || 0 });
      const r = await api(`/api/resolve?${qs}`).catch(() => ({}));
      if (r.youtubeId) t.youtubeId = r.youtubeId;
    }
    if (!t.youtubeId && !t.spotifyUri) throw new Error(`Couldn't find a playable source for "${t.title}".`);
    send({ type: "queue_add", track: t, top });
    status.textContent = t.youtubeId ? `Queued "${t.title}".` :
      `Queued "${t.title}" (Spotify only — listeners without Spotify won't hear it).`;
  } catch (err) {
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

function renderQueue() {
  const box = $("queue");
  if (!myQueue.length) {
    box.replaceChildren(el("div", { class: "muted small" }, "Your queue is empty. Search above to add songs."));
    return;
  }
  box.replaceChildren(...myQueue.map((t, i) => el("div", { class: "item" },
    el("img", { src: t.art || "", alt: "" }),
    el("div", { class: "meta" },
      el("div", { class: "t", title: t.title }, `${i + 1}. ${t.title}`),
      el("div", { class: "a" }, srcTags(t), `${t.artist} · ${fmt(t.durationMs)}`)),
    el("div", { class: "acts" },
      el("button", { title: "Move to top", disabled: i === 0, onclick: () => send({ type: "queue_move", id: t.id, to: "top" }) }, "⤒"),
      el("button", { title: "Up", disabled: i === 0, onclick: () => send({ type: "queue_move", id: t.id, to: -1 }) }, "↑"),
      el("button", { title: "Down", disabled: i === myQueue.length - 1, onclick: () => send({ type: "queue_move", id: t.id, to: 1 }) }, "↓"),
      el("button", { title: "Remove", onclick: () => send({ type: "queue_remove", id: t.id }) }, "✕")))));
}
renderQueue();

// ------------------------------------------------------------ playback

$("tuneIn").onclick = async () => {
  tunedIn = !tunedIn;
  $("tuneIn").textContent = tunedIn ? "⏸ Tune out" : "▶ Tune in";
  $("tuneIn").classList.toggle("primary", !tunedIn);
  if (tunedIn) {
    await Spotify.activate();
    YT.ensure();
    Player.playingKey = null;
    Player.sync();
  } else {
    Player.stopAll();
  }
};

$("volume").addEventListener("input", () => {
  const v = Number($("volume").value);
  store.set("lr.volume", v);
  YT.setVolume(v);
  Spotify.setVolume(v);
});
$("volume").value = store.get("lr.volume") ?? 70;

const Player = {
  playingKey: null,
  source: null, // 'spotify' | 'youtube' | null

  sync() {
    const cur = state.current;
    if (!tunedIn) return;
    if (!cur) { this.stopAll(); this.playingKey = null; return; }
    const key = `${cur.track.id}@${cur.startedAt}`;
    if (key === this.playingKey) return;
    this.playingKey = key;
    this.start(cur, key);
  },

  async start(cur, key) {
    const wait = cur.startedAt - serverNow();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (this.playingKey !== key) return;
    const offset = () => Math.max(0, serverNow() - cur.startedAt);
    $("playNote").textContent = "";

    if (cur.track.spotifyUri && Spotify.ready()) {
      YT.stop();
      try {
        await Spotify.play(cur.track.spotifyUri, offset());
        this.setSource("spotify");
        return;
      } catch (err) {
        console.warn("Spotify play failed, falling back", err);
      }
    }
    Spotify.pause();
    if (cur.track.youtubeId) {
      YT.play(cur.track.youtubeId, offset() / 1000, cur.track);
      this.setSource("youtube");
      return;
    }
    this.setSource(null);
    $("playNote").textContent = "This song is Spotify-only. Connect Spotify Premium to hear it.";
  },

  setSource(src) {
    this.source = src;
    const b = $("sourceBadge");
    b.hidden = !src;
    b.className = `badge ${src || ""}`;
    b.textContent = src === "spotify" ? "Playing via Spotify" : src === "youtube" ? "Playing via YouTube" : "";
    $("ytHolder").classList.toggle("show", src === "youtube");
  },

  stopAll() {
    YT.stop();
    Spotify.pause();
    this.setSource(null);
  },

  // Keep everyone within ~2 seconds of the room clock.
  async checkDrift() {
    const cur = state.current;
    if (!tunedIn || !cur || !this.source) return;
    const expected = serverNow() - cur.startedAt;
    if (expected < 3000 || (cur.track.durationMs && expected > cur.track.durationMs - 3000)) return;
    const actual = this.source === "spotify" ? await Spotify.position() : YT.position();
    if (actual === null) return;
    if (Math.abs(actual - expected) > 2500) {
      if (this.source === "spotify") Spotify.seek(expected); else YT.seek(expected / 1000);
    }
  },
};
setInterval(() => Player.checkDrift(), 5000);

// ---- YouTube IFrame player
const YT = {
  player: null,
  readyPromise: null,
  currentTrack: null,

  ensure() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise((resolve) => {
      window.onYouTubeIframeAPIReady = () => {
        this.player = new window.YT.Player("ytPlayer", {
          width: 200, height: 200,
          playerVars: { controls: 0, disablekb: 1, modestbranding: 1, playsinline: 1, rel: 0 },
          events: {
            onReady: () => { this.player.setVolume(Number($("volume").value)); resolve(); },
            onError: (e) => {
              $("playNote").textContent = `YouTube couldn't play this one (error ${e.data}).`;
            },
            onStateChange: (e) => {
              const t = this.currentTrack;
              const cur = state.current;
              if (e.data === 1 && t && cur?.track.id === t.id && !cur.track.durationMs) {
                send({ type: "duration", trackId: t.id, durationMs: this.player.getDuration() * 1000 });
              }
            },
          },
        });
      };
      document.head.append(el("script", { src: "https://www.youtube.com/iframe_api" }));
    });
    return this.readyPromise;
  },

  async play(videoId, startSeconds, track) {
    await this.ensure();
    this.currentTrack = track;
    this.player.loadVideoById({ videoId, startSeconds });
  },
  stop() { try { this.player?.stopVideo(); } catch {} this.currentTrack = null; },
  position() { try { return this.player ? this.player.getCurrentTime() * 1000 : null; } catch { return null; } },
  seek(s) { try { this.player?.seekTo(s, true); } catch {} },
  setVolume(v) { try { this.player?.setVolume(v); } catch {} },
};

// ---- Spotify (PKCE login + Web Playback SDK)
const Spotify = {
  player: null,
  deviceId: null,
  scopes: "streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state",
  redirectUri: () => `${location.origin}/`,

  loggedIn: () => Boolean(store.get("lr.sp")),
  ready() { return Boolean(this.deviceId); },

  async login() {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    sessionStorage.setItem("lr.sp.verifier", verifier);
    sessionStorage.setItem("lr.sp.return", location.href);
    const qs = new URLSearchParams({
      client_id: config.spotifyClientId, response_type: "code", redirect_uri: this.redirectUri(),
      code_challenge_method: "S256", code_challenge: challenge, scope: this.scopes,
    });
    location.href = `https://accounts.spotify.com/authorize?${qs}`;
  },

  async handleRedirect() {
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const verifier = sessionStorage.getItem("lr.sp.verifier");
    if (!code || !verifier) return;
    sessionStorage.removeItem("lr.sp.verifier");
    const ret = sessionStorage.getItem("lr.sp.return") || "/";
    try {
      await this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: this.redirectUri(), code_verifier: verifier });
    } catch (err) {
      alert(`Spotify login failed: ${err.message}`);
    }
    history.replaceState(null, "", ret);
    location.reload();
    await new Promise(() => {}); // wait for reload
  },

  async tokenRequest(body) {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: config.spotifyClientId, ...body }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.error || res.status);
    const prev = store.get("lr.sp") || {};
    store.set("lr.sp", {
      access: data.access_token,
      refresh: data.refresh_token || prev.refresh,
      expires: Date.now() + data.expires_in * 1000,
    });
  },

  async token() {
    const t = store.get("lr.sp");
    if (!t) throw new Error("Not logged in");
    if (t.expires > Date.now() + 60_000) return t.access;
    try {
      await this.tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh });
    } catch (err) {
      this.logout();
      throw err;
    }
    return store.get("lr.sp").access;
  },

  logout() {
    store.del("lr.sp");
    this.deviceId = null;
    this.player?.disconnect();
    this.updateButton();
  },

  updateButton() {
    const b = $("spotifyBtn");
    if (!config.spotifyClientId) return;
    b.textContent = this.ready() ? "Spotify ✓ (log out)" : this.loggedIn() ? "Spotify connecting…" : "Connect Spotify";
  },

  init() {
    this.updateButton();
    window.onSpotifyWebPlaybackSDKReady = () => {
      this.player = new window.Spotify.Player({
        name: `Listening Room (${room})`,
        getOAuthToken: (cb) => this.token().then(cb).catch(() => {}),
        volume: Number($("volume").value) / 100,
      });
      this.player.addListener("ready", ({ device_id }) => {
        this.deviceId = device_id;
        this.updateButton();
        Player.playingKey = null;
        Player.sync();
      });
      this.player.addListener("not_ready", () => { this.deviceId = null; this.updateButton(); });
      this.player.addListener("account_error", () => {
        $("playNote").textContent = "Spotify playback needs Premium and your account on the app's allowlist. Using YouTube instead.";
        this.deviceId = null;
        this.updateButton();
      });
      this.player.addListener("authentication_error", () => this.logout());
      this.player.connect();
    };
    document.head.append(el("script", { src: "https://sdk.scdn.co/spotify-player.js" }));
  },

  async activate() { try { await this.player?.activateElement(); } catch {} },

  async play(uri, positionMs) {
    const res = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${this.deviceId}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${await this.token()}`, "content-type": "application/json" },
      body: JSON.stringify({ uris: [uri], position_ms: Math.round(positionMs) }),
    });
    if (!res.ok && res.status !== 202) throw new Error(`Spotify play failed (${res.status})`);
  },

  pause() { try { this.player?.pause(); } catch {} },
  async position() {
    try { const s = await this.player?.getCurrentState(); return s ? s.position : null; } catch { return null; }
  },
  seek(ms) { try { this.player?.seek(Math.round(ms)); } catch {} },
  setVolume(v) { try { this.player?.setVolume(v / 100); } catch {} },
};

$("spotifyBtn").onclick = () => (Spotify.ready() || Spotify.loggedIn() ? Spotify.logout() : Spotify.login());

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

boot();
