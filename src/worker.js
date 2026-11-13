import { DurableObject } from "cloudflare:workers";

const MAX_DJS = 5;
const MAX_QUEUE = 200;
const START_LEAD_MS = 1500; // gives every client time to load the track
const OFFLINE_GRACE_MS = 60_000; // DJs who disconnect keep their seat this long
const UNKNOWN_DURATION_MS = 10 * 60_000;

// ---------------------------------------------------------------- HTTP entry

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/config") {
      return json({
        spotifyClientId: env.SPOTIFY_CLIENT_ID || "",
        spotifySearch: Boolean(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET),
        youtube: Boolean(env.YOUTUBE_API_KEY),
        gifs: Boolean(env.GIPHY_API_KEY),
        passwordRequired: Boolean(env.ROOM_PASSWORD),
      });
    }

    if (url.pathname.startsWith("/ws/")) {
      if (!checkPass(env, url.searchParams.get("pass"))) return new Response("Bad password", { status: 401 });
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
      const room = decodeURIComponent(url.pathname.slice(4)).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40) || "main";
      return env.ROOM.get(env.ROOM.idFromName(room)).fetch(request);
    }

    if (url.pathname.startsWith("/api/")) {
      if (!checkPass(env, request.headers.get("x-room-pass"))) return json({ error: "Bad password" }, 401);
      try {
        switch (url.pathname) {
          case "/api/auth": return json({ ok: true }); // lets the client tell a wrong password from a dropped connection
          case "/api/search": return json(await search(env, url.searchParams.get("q") || ""));
          case "/api/resolve": return json(await cached(env, ctx, resolveKey(url.searchParams), () => resolveYouTube(env, url.searchParams)));
          case "/api/video": {
            const id = (url.searchParams.get("id") || "").slice(0, 20);
            return json(await cached(env, ctx, `video:${id}`, () => videoInfo(env, id)));
          }
          case "/api/gifs": return json(await gifs(env, url.searchParams.get("q") || ""));
        }
      } catch (err) {
        return json({ error: String(err.message || err) }, 502);
      }
      return json({ error: "Not found" }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function checkPass(env, given) {
  return !env.ROOM_PASSWORD || given === env.ROOM_PASSWORD;
}

// YouTube lookups are saved in a Durable Object so a song that has been queued
// before costs no YouTube quota. (Cloudflare's Cache API isn't guaranteed to
// work on *.workers.dev, which is why this doesn't use it.)
const MATCH_TTL_MS = 30 * 86400_000;
const NO_MATCH_TTL_MS = 86400_000; // try again tomorrow if nothing matched

async function cached(env, ctx, key, produce) {
  const store = env.MATCHES.get(env.MATCHES.idFromName("global"));
  const hit = await store.lookup(key).catch(() => null);
  if (hit) return hit;
  const data = await produce();
  ctx.waitUntil(store.remember(key, data, data.youtubeId ? MATCH_TTL_MS : NO_MATCH_TTL_MS).catch(() => {}));
  return data;
}

// Same song, same key: case and sub-second duration differences don't matter.
function resolveKey(params) {
  const norm = (k) => (params.get(k) || "").trim().toLowerCase().slice(0, 150);
  const seconds = Math.round(Number(params.get("durationMs") || 0) / 1000);
  return `resolve:${norm("artist")}|${norm("title")}|${seconds}`;
}

export class MatchCache extends DurableObject {
  async lookup(key) {
    const entry = await this.ctx.storage.get(key);
    if (!entry) return null;
    if (entry.expires < Date.now()) {
      await this.ctx.storage.delete(key);
      return null;
    }
    return entry.data;
  }

  async remember(key, data, ttlMs) {
    await this.ctx.storage.put(key, { data, expires: Date.now() + ttlMs });
  }
}

// ---------------------------------------------------------------- Search

let spotifyAppToken = null; // { token, expires }

async function getSpotifyAppToken(env) {
  if (spotifyAppToken && spotifyAppToken.expires > Date.now() + 60_000) return spotifyAppToken.token;
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: "Basic " + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`),
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Spotify token failed (${res.status})`);
  const data = await res.json();
  spotifyAppToken = { token: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return spotifyAppToken.token;
}

async function search(env, q) {
  q = q.trim().slice(0, 200);
  if (!q) return { results: [] };

  if (env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET) {
    const token = await getSpotifyAppToken(env);
    const res = await fetch(`https://api.spotify.com/v1/search?type=track&limit=10&q=${encodeURIComponent(q)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json();
      return {
        source: "spotify",
        results: (data.tracks?.items || []).map((t) => ({
          title: t.name,
          artist: (t.artists || []).map((a) => a.name).join(", "),
          album: t.album?.name || "",
          art: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || "",
          durationMs: t.duration_ms,
          spotifyUri: t.uri,
        })),
      };
    }
    // fall through to iTunes if Spotify search is unavailable
  }

  const res = await fetch(`https://itunes.apple.com/search?media=music&entity=song&limit=15&term=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(`Catalog search failed (${res.status})`);
  const data = await res.json();
  return {
    source: "itunes",
    results: (data.results || []).map((t) => ({
      title: t.trackName,
      artist: t.artistName,
      album: t.collectionName || "",
      art: (t.artworkUrl100 || "").replace("100x100", "300x300"),
      durationMs: t.trackTimeMillis || 0,
    })),
  };
}

// ---------------------------------------------------------------- YouTube

function isoDurationMs(iso) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || "");
  if (!m) return 0;
  const [, d, h, min, s] = m.map((x) => Number(x || 0));
  return (((d * 24 + h) * 60 + min) * 60 + s) * 1000;
}

async function ytFetch(env, path, params) {
  if (!env.YOUTUBE_API_KEY) throw new Error("YouTube API key not configured");
  const qs = new URLSearchParams({ ...params, key: env.YOUTUBE_API_KEY });
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${qs}`);
  if (!res.ok) throw new Error(`YouTube ${path} failed (${res.status})`);
  return res.json();
}

// Finds the YouTube upload that best matches a catalog track.
async function resolveYouTube(env, params) {
  const artist = (params.get("artist") || "").slice(0, 150);
  const title = (params.get("title") || "").slice(0, 150);
  const target = Number(params.get("durationMs") || 0);
  const searchData = await ytFetch(env, "search", {
    part: "snippet", type: "video", videoCategoryId: "10", maxResults: "8",
    q: `${artist} - ${title} audio`,
  });
  const ids = (searchData.items || []).map((i) => i.id.videoId).filter(Boolean);
  if (!ids.length) return { youtubeId: null };

  const details = await ytFetch(env, "videos", { part: "contentDetails,status,snippet", id: ids.join(",") });
  const candidates = (details.items || [])
    .filter((v) => v.status?.embeddable !== false)
    .map((v, rank) => {
      const durationMs = isoDurationMs(v.contentDetails?.duration);
      const channel = v.snippet?.channelTitle || "";
      const vtitle = (v.snippet?.title || "").toLowerCase();
      const diff = target ? Math.abs(durationMs - target) : 0;
      let score = rank; // earlier search results are better
      if (target) score += diff <= 3000 ? 0 : diff <= 8000 ? 4 : diff <= 20000 ? 10 : 40;
      if (/ - topic$/i.test(channel)) score -= 6;
      if (vtitle.includes("official audio")) score -= 3;
      if (/\b(live|cover|remix|karaoke|reaction|8d|slowed|sped up|nightcore)\b/.test(vtitle) &&
          !/\b(live|cover|remix)\b/.test(title.toLowerCase())) score += 15;
      return { youtubeId: v.id, durationMs, channel, title: v.snippet?.title, score };
    })
    .sort((a, b) => a.score - b.score);

  return candidates[0] || { youtubeId: null };
}

async function videoInfo(env, id) {
  if (!/^[\w-]{11}$/.test(id || "")) throw new Error("Bad video id");
  const data = await ytFetch(env, "videos", { part: "contentDetails,snippet,status", id });
  const v = data.items?.[0];
  if (!v) throw new Error("Video not found");
  return {
    title: v.snippet.title,
    artist: v.snippet.channelTitle.replace(/ - Topic$/, ""),
    album: "",
    art: v.snippet.thumbnails?.medium?.url || "",
    durationMs: isoDurationMs(v.contentDetails.duration),
    youtubeId: v.id,
    embeddable: v.status?.embeddable !== false,
  };
}

// ---------------------------------------------------------------- GIFs

async function gifs(env, q) {
  if (!env.GIPHY_API_KEY) return { results: [] };
  const endpoint = q.trim() ? "search" : "trending";
  const qs = new URLSearchParams({ api_key: env.GIPHY_API_KEY, q: q.slice(0, 100), limit: "24", rating: "pg-13" });
  const res = await fetch(`https://api.giphy.com/v1/gifs/${endpoint}?${qs}`);
  if (!res.ok) throw new Error(`GIF search failed (${res.status})`);
  const data = await res.json();
  return {
    results: (data.data || []).map((g) => ({
      url: g.images?.fixed_height?.url,
      preview: g.images?.fixed_height_small?.url || g.images?.fixed_height?.url,
    })).filter((g) => g.url),
  };
}

// ---------------------------------------------------------------- Room

const emptyState = () => ({ users: {}, djs: [], queues: {}, current: null, chat: [], scores: {} });

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.s = { ...emptyState(), ...((await ctx.storage.get("s")) || {}) };
    });
  }

  async save() {
    await this.ctx.storage.put("s", this.s);
  }

  onlineIds() {
    const ids = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a?.userId && !a.closed) ids.add(a.userId);
    }
    return ids;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const userId = (url.searchParams.get("userId") || "").slice(0, 64);
    const name = (url.searchParams.get("name") || "").trim().slice(0, 32);
    if (!/^[\w-]{8,64}$/.test(userId) || !name) return new Response("userId and name required", { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ userId });

    const isNew = !this.s.users[userId];
    this.s.users[userId] = { name, lastSeen: Date.now() };
    this.s.queues[userId] ||= [];
    this.s.scores[userId] ||= 0;
    if (isNew) this.system(`${name} joined the room`);
    await this.save();

    send(server, { type: "init", you: userId, chat: this.s.chat, now: Date.now() });
    send(server, { type: "queue", queue: this.s.queues[userId] });
    this.broadcastState();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { userId } = ws.deserializeAttachment() || {};
    const user = this.s.users[userId];
    if (!user) return;
    user.lastSeen = Date.now();
    const s = this.s;

    switch (msg.type) {
      case "time":
        send(ws, { type: "time", t0: msg.t0, now: Date.now() });
        return;

      case "chat": {
        const text = String(msg.text || "").trim().slice(0, 500);
        if (!text) return;
        this.pushChat({ userId, name: user.name, text });
        break;
      }

      case "gif": {
        const gif = String(msg.url || "");
        if (!/^https:\/\/media\d*\.giphy\.com\/\S+$/.test(gif)) return;
        this.pushChat({ userId, name: user.name, gif });
        break;
      }

      case "rename": {
        const name = String(msg.name || "").trim().slice(0, 32);
        if (name) user.name = name;
        break;
      }

      case "stage_join":
        if (s.djs.includes(userId) || s.djs.length >= MAX_DJS) return;
        s.djs.push(userId);
        this.system(`${user.name} stepped up to DJ`);
        if (!s.current) await this.startNext();
        break;

      case "stage_leave":
        if (!s.djs.includes(userId)) return;
        await this.removeDj(userId, `${user.name} stepped down`);
        break;

      case "queue_add": {
        const t = cleanTrack(msg.track);
        const q = s.queues[userId];
        if (!t || q.length >= MAX_QUEUE) return;
        msg.top ? q.unshift(t) : q.push(t);
        this.sendQueue(userId);
        if (!s.current && s.djs.includes(userId)) await this.startNext();
        break;
      }

      case "queue_remove": {
        const q = s.queues[userId];
        const i = q.findIndex((t) => t.id === msg.id);
        if (i < 0) return;
        q.splice(i, 1);
        this.sendQueue(userId);
        break;
      }

      case "queue_move": {
        const q = s.queues[userId];
        const i = q.findIndex((t) => t.id === msg.id);
        if (i < 0) return;
        const [t] = q.splice(i, 1);
        const to = msg.to === "top" ? 0 : msg.to === "bottom" ? q.length : Math.max(0, Math.min(q.length, i + Number(msg.to || 0)));
        q.splice(to, 0, t);
        this.sendQueue(userId);
        break;
      }

      case "vote": {
        const cur = s.current;
        if (!cur || cur.djId === userId || ![1, -1].includes(msg.v) || msg.trackId !== cur.track.id) return;
        cur.votes[userId] = msg.v;
        if (this.shouldVoteSkip()) {
          this.system(`"${cur.track.title}" was voted off`);
          await this.advance();
        }
        break;
      }

      case "skip":
        if (!s.current || s.current.djId !== userId) return;
        this.system(`${user.name} skipped their song`);
        await this.advance();
        break;

      case "duration": {
        // Fallback for tracks queued without a known length (e.g. pasted links)
        const cur = s.current;
        const d = Number(msg.durationMs);
        if (!cur || cur.track.id !== msg.trackId || cur.track.durationMs || !(d > 1000 && d < 4 * 3600_000)) return;
        cur.track.durationMs = Math.round(d);
        await this.ctx.storage.setAlarm(cur.startedAt + cur.track.durationMs);
        break;
      }

      default:
        return;
    }
    await this.save();
    this.broadcastState();
  }

  async webSocketClose(ws) {
    await this.handleLeave(ws);
  }

  async webSocketError(ws) {
    await this.handleLeave(ws);
  }

  async handleLeave(ws) {
    const a = ws.deserializeAttachment() || {};
    ws.serializeAttachment({ ...a, closed: true });
    try { ws.close(1000, "bye"); } catch {}
    if (a.userId && this.s.users[a.userId]) this.s.users[a.userId].lastSeen = Date.now();
    await this.save();
    this.broadcastState();
  }

  async alarm() {
    const cur = this.s.current;
    if (!cur) return;
    const endsAt = cur.startedAt + (cur.track.durationMs || UNKNOWN_DURATION_MS);
    if (Date.now() < endsAt - 500) {
      await this.ctx.storage.setAlarm(endsAt);
      return;
    }
    await this.advance();
    await this.save();
    this.broadcastState();
  }

  // ---- rotation

  async removeDj(userId, note) {
    const s = this.s;
    const wasPlaying = s.current?.djId === userId;
    s.djs = s.djs.filter((id) => id !== userId);
    if (note) this.system(note);
    if (wasPlaying) {
      this.finishCurrent();
      await this.startNext();
    }
  }

  finishCurrent() {
    const s = this.s;
    const cur = s.current;
    if (!cur) return;
    const awesome = Object.values(cur.votes).filter((v) => v === 1).length;
    s.scores[cur.djId] = (s.scores[cur.djId] || 0) + awesome;
    // Played songs go to the bottom of the DJ's queue, like Turntable did.
    const q = s.queues[cur.djId];
    if (q && q.length < MAX_QUEUE) {
      q.push(cur.track);
      this.sendQueue(cur.djId);
    }
    s.current = null;
  }

  // Current song is over: the DJ in the play seat rotates to the back.
  async advance() {
    const s = this.s;
    const djId = s.current?.djId;
    this.finishCurrent();
    if (djId && s.djs[0] === djId) s.djs.push(s.djs.shift());
    await this.startNext();
  }

  async startNext() {
    const s = this.s;
    const online = this.onlineIds();
    const now = Date.now();

    // Drop DJs who have been gone longer than the grace period.
    for (const id of [...s.djs]) {
      if (!online.has(id) && now - (s.users[id]?.lastSeen || 0) > OFFLINE_GRACE_MS) {
        s.djs = s.djs.filter((x) => x !== id);
        this.system(`${s.users[id]?.name || "A DJ"} left the stage (disconnected)`);
      }
    }

    // First DJ with something queued takes the play seat; empty queues rotate past.
    for (let i = 0; i < s.djs.length; i++) {
      const id = s.djs[0];
      const q = s.queues[id] || [];
      if (q.length) {
        const track = q.shift();
        s.current = { track, djId: id, startedAt: now + START_LEAD_MS, votes: {} };
        this.sendQueue(id);
        this.system(`${s.users[id].name} is playing "${track.title}" by ${track.artist}`);
        await this.ctx.storage.setAlarm(s.current.startedAt + (track.durationMs || UNKNOWN_DURATION_MS));
        return;
      }
      s.djs.push(s.djs.shift());
    }
    s.current = null;
    await this.ctx.storage.deleteAlarm();
  }

  shouldVoteSkip() {
    const cur = this.s.current;
    const listeners = [...this.onlineIds()].filter((id) => id !== cur.djId).length;
    const lame = Object.values(cur.votes).filter((v) => v === -1).length;
    return lame >= 2 && lame > listeners / 2;
  }

  // ---- messaging

  pushChat(entry) {
    this.s.chat.push({ id: crypto.randomUUID(), ts: Date.now(), ...entry });
    if (this.s.chat.length > 100) this.s.chat.splice(0, this.s.chat.length - 100);
    this.broadcast({ type: "chat", msg: this.s.chat.at(-1) });
  }

  system(text) {
    this.pushChat({ system: true, text });
  }

  sendQueue(userId) {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a?.userId === userId && !a.closed) send(ws, { type: "queue", queue: this.s.queues[userId] || [] });
    }
  }

  broadcastState() {
    const s = this.s;
    const online = this.onlineIds();
    const ids = new Set([...online, ...s.djs]);
    const users = [...ids].filter((id) => s.users[id]).map((id) => ({
      id,
      name: s.users[id].name,
      online: online.has(id),
      score: s.scores[id] || 0,
      queued: (s.queues[id] || []).length,
    }));
    this.broadcast({ type: "state", users, djs: s.djs, current: s.current, now: Date.now() });
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.deserializeAttachment()?.closed) continue;
      try { ws.send(data); } catch {}
    }
  }
}

function send(ws, msg) {
  try { ws.send(JSON.stringify(msg)); } catch {}
}

function cleanTrack(t) {
  if (!t || typeof t !== "object") return null;
  const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
  const track = {
    id: crypto.randomUUID(),
    title: str(t.title, 200),
    artist: str(t.artist, 200),
    album: str(t.album, 200),
    art: /^https:\/\//.test(t.art || "") ? str(t.art, 500) : "",
    durationMs: Number.isFinite(t.durationMs) && t.durationMs > 0 ? Math.round(t.durationMs) : 0,
    spotifyUri: /^spotify:track:[A-Za-z0-9]{22}$/.test(t.spotifyUri || "") ? t.spotifyUri : "",
    youtubeId: /^[\w-]{11}$/.test(t.youtubeId || "") ? t.youtubeId : "",
  };
  if (!track.title || (!track.spotifyUri && !track.youtubeId)) return null;
  return track;
}
