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

let config = { menu: {}, throwables: {}, looks: { skin: [], shirt: [], hat: [] }, floor: { x0: 4, x1: 96, y0: 60, y1: 96 } };
let ws = null;
let state = { users: [], djs: [], current: null };
let myQueue = [];
let playHistory = [];
let topDjs = [];
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
const me = () => userById(userId);

let toastTimer;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

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
  $("entryError").textContent = "";
  $("entry").hidden = true;
  retry = 0;
  connect();
});

let retry = 0;
function connect() {
  const qs = new URLSearchParams({ userId, name: store.get("lr.name"), pass: store.get("lr.pass") || "" });
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/${room}?${qs}`);
  ws.onopen = () => { retry = 0; $("conn").classList.add("on"); syncClock(); };
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = async () => {
    $("conn").classList.remove("on");
    // A dropped socket looks the same whether the password was wrong, the site
    // was redeployed, or the network blipped, so ask the server which it was.
    if (await passwordRejected()) {
      store.del("lr.pass");
      config.passwordRequired = true;
      $("passRow").hidden = false;
      $("entryError").textContent = "Wrong room password.";
      $("entry").hidden = false;
      return;
    }
    setTimeout(connect, Math.min(10000, 1000 * 2 ** retry++));
  };
}

// True only if the server answers and rejects the password. If the server
// can't be reached, keep retrying instead of asking for the password again.
async function passwordRejected() {
  try {
    const r = await fetch("/api/auth", { headers: { "x-room-pass": store.get("lr.pass") || "" } });
    return r.status === 401;
  } catch {
    return false;
  }
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
    case "init": {
      clockOffset = m.now - Date.now();
      $("messages").replaceChildren();
      m.chat.forEach((msg) => renderChat(msg, false));
      // Your look follows you between rooms.
      const look = store.get("lr.look");
      if (look) send({ type: "look", look });
      break;
    }
    case "chat": renderChat(m.msg, true); break;
    case "queue": myQueue = m.queue; renderQueue(); break;
    case "history": playHistory = m.history || []; topDjs = m.top || []; renderHistory(); renderTop(); break;
    case "notice": toast(m.text); break;
    case "move": {
      const u = userById(m.id);
      if (u) { u.x = m.x; u.y = m.y; }
      const a = avatarEls.get(m.id);
      if (a && !state.djs.includes(m.id)) placeAvatar(a, { x: m.x, y: m.y });
      break;
    }
    case "fx":
      if (m.kind === "throw") throwFx(m.from, m.to, m.item);
      break;
    case "state":
      state = m;
      renderStage();
      renderFloor();
      Player.sync();
      break;
  }
}

// ------------------------------------------------------------ stage

function renderStage() {
  const cur = state.current;
  const onStage = state.djs.includes(userId);
  $("stageBtn").textContent = onStage ? "Step down" : "Step up to DJ";
  $("stageBtn").disabled = !onStage && state.djs.length >= 5;
  $("coins").textContent = `🪙 ${me()?.coins ?? 0}`;

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
    $("awesome").disabled = $("lame").disabled = $("throwAtDj").disabled = isDj;
    $("skip").hidden = !isDj;
  } else {
    $("npArt").removeAttribute("src");
    $("npTitle").textContent = state.djs.length ? "Waiting for a DJ to queue a song" : "Step up to DJ to start the music";
    $("npArtist").textContent = "";
    $("npDj").textContent = "Nobody's playing";
    $("awesomeCount").textContent = $("lameCount").textContent = "0";
    $("awesome").className = $("lame").className = "vote";
    $("awesome").disabled = $("lame").disabled = $("throwAtDj").disabled = true;
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
$("throwAtDj").onclick = () => state.current && send({ type: "throw", item: "tomato", to: state.current.djId });
for (const [btn, v] of [["awesome", 1], ["lame", -1]]) {
  $(btn).onclick = () => {
    const cur = state.current;
    if (!cur) return;
    myVotes[cur.track.id] = v;
    send({ type: "vote", v, trackId: cur.track.id });
  };
}

// ------------------------------------------------------------ avatars

const HATS = {
  none: "",
  hair: '<path d="M8.6 25 a11.4 11.6 0 0 1 22.8 0 q-3-5.5-11.4-5 q-8.4-.5-11.4 5z" fill="#3b2a20"/>',
  cap: '<path d="M9 22 a11 10 0 0 1 22 0 z" fill="#e5484d"/><path d="M27 20.5 h8.5 a1.8 1.8 0 0 1 0 3.6 h-8.5 z" fill="#b8323a"/>',
  beanie: '<path d="M9 22 a11 11 0 0 1 22 0 z" fill="#3b82f6"/><rect x="8.5" y="20" width="23" height="4.5" rx="2.2" fill="#2563eb"/><circle cx="20" cy="10.5" r="2.8" fill="#f1f5f9"/>',
  headphones: '<path d="M8.5 24 a11.5 12 0 0 1 23 0" stroke="#1f2937" stroke-width="2.6" fill="none"/><rect x="5.5" y="21" width="5" height="9" rx="2.2" fill="#7c5cff"/><rect x="29.5" y="21" width="5" height="9" rx="2.2" fill="#7c5cff"/>',
  crown: '<path d="M12 16 L12 8 L16 12 L20 5 L24 12 L28 8 L28 16 Z" fill="#f5c542" stroke="#b8860b" stroke-width=".8" stroke-linejoin="round"/>',
  party: '<path d="M14 15 L20 1.5 L26 15 Z" fill="#ec4899"/><path d="M16.2 9.5 H23.8 M15 12.5 H25" stroke="#fde047" stroke-width="1.4"/><circle cx="20" cy="1.8" r="1.9" fill="#fde047"/>',
};
const isColor = (c) => /^#[0-9a-f]{6}$/i.test(c || "");

// A little person, drawn facing right. headOnly crops to the head for small icons.
function figureSvg(look, headOnly = false) {
  const skin = isColor(look?.skin) ? look.skin : "#e8b48f";
  const shirt = isColor(look?.shirt) ? look.shirt : "#7c5cff";
  const hat = HATS[look?.hat] ?? "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${headOnly ? "4 0 32 38" : "0 0 40 70"}" aria-hidden="true">
    <ellipse cx="20" cy="68" rx="11" ry="2" fill="#0006"/>
    <rect x="13" y="52" width="5" height="15" rx="2" fill="#2b2d42"/>
    <rect x="22" y="52" width="5" height="15" rx="2" fill="#2b2d42"/>
    <rect x="5" y="36" width="6" height="14" rx="3" fill="${shirt}"/>
    <rect x="29" y="36" width="6" height="14" rx="3" fill="${shirt}"/>
    <rect x="10" y="34" width="20" height="21" rx="6" fill="${shirt}"/>
    <circle cx="8" cy="51" r="3" fill="${skin}"/>
    <circle cx="32" cy="51" r="3" fill="${skin}"/>
    <circle cx="20" cy="24" r="11" fill="${skin}"/>
    <circle cx="18" cy="24" r="1.6" fill="#1b1b1b"/>
    <circle cx="26" cy="24" r="1.6" fill="#1b1b1b"/>
    <path d="M18 29 q4 3 8 0" stroke="#1b1b1b" stroke-width="1.4" fill="none" stroke-linecap="round"/>
    ${hat}
  </svg>`;
}

const DJ_SPOTS = [24, 34, 44, 54, 64]; // x positions behind the decks
const DJ_Y = 44;
const avatarEls = new Map(); // userId -> { el, fig, drink, name, x, y }

function spotFor(u) {
  const i = state.djs.indexOf(u.id);
  return i >= 0 ? { x: DJ_SPOTS[i], y: DJ_Y } : { x: u.x ?? 50, y: u.y ?? 80 };
}

function renderFloor() {
  const cur = state.current;
  $("floor").classList.toggle("music", Boolean(cur));
  const keep = new Set();
  for (const u of state.users) {
    if (!u.online && !state.djs.includes(u.id)) continue;
    keep.add(u.id);
    let a = avatarEls.get(u.id);
    if (!a) {
      a = makeAvatar(u.id);
      avatarEls.set(u.id, a);
      $("avatars").append(a.el);
    }
    updateAvatar(a, u, cur);
    placeAvatar(a, spotFor(u));
  }
  for (const [id, a] of avatarEls) {
    if (!keep.has(id)) { a.el.remove(); avatarEls.delete(id); }
  }
}
setInterval(renderFloor, 30_000); // lets finished drinks disappear

function makeAvatar(id) {
  const fig = el("div", { class: "fig" });
  const drink = el("span", { class: "drink" });
  const name = el("span", { class: "nm" });
  const node = el("button", {
    class: "av", type: "button",
    onclick: (e) => { e.stopPropagation(); openAvatarMenu(id); },
  }, fig, drink, name);
  return { id, el: node, fig, drink, name, x: null, y: null, lookKey: "" };
}

function updateAvatar(a, u, cur) {
  const key = JSON.stringify(u.look);
  if (key !== a.lookKey) { a.fig.innerHTML = figureSvg(u.look); a.lookKey = key; }
  a.name.textContent = u.name;
  a.el.setAttribute("aria-label", u.id === userId ? `${u.name} (you)` : u.name);
  const vote = cur?.votes?.[u.id];
  const cls = a.el.classList;
  cls.toggle("me", u.id === userId);
  cls.toggle("dj", state.djs.includes(u.id));
  cls.toggle("playing", cur?.djId === u.id);
  cls.toggle("offline", !u.online);
  cls.toggle("up", vote === 1);
  cls.toggle("down", vote === -1);
  const drink = u.drink && u.drink.until > serverNow() ? config.menu[u.drink.item] : null;
  a.drink.textContent = drink ? drink.icon : "";
  a.drink.title = drink ? drink.name : "";
}

// Walks an avatar to a spot (x, y are percentages of the floor).
function placeAvatar(a, { x, y }) {
  if (a.x === x && a.y === y) return;
  const first = a.x === null;
  const dist = first ? 0 : Math.hypot((x - a.x) * 1.6, y - a.y); // the floor is 16:10
  const ms = first ? 0 : Math.round(Math.min(3000, Math.max(250, dist * 28)));
  if (!first && x !== a.x) a.el.classList.toggle("left", x < a.x);
  a.el.style.setProperty("--d", `${ms}ms`);
  a.el.style.setProperty("--s", (0.8 + (0.3 * (y - 40)) / 56).toFixed(3)); // further back looks smaller
  a.el.style.left = `${x}%`;
  a.el.style.top = `${y}%`;
  a.el.style.zIndex = String(Math.round(y * 10));
  a.x = x;
  a.y = y;
  if (ms) {
    a.el.classList.add("walking");
    clearTimeout(a.walkTimer);
    a.walkTimer = setTimeout(() => a.el.classList.remove("walking"), ms);
  }
}

$("floor").addEventListener("click", (e) => {
  closeAvatarMenu();
  if (e.target.closest(".av, .pop")) return;
  if (e.target.closest("#barArea")) return openBar(userId);
  const r = $("floor").getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * 100;
  const y = ((e.clientY - r.top) / r.height) * 100;
  if (y < config.floor.y0 - 8) return; // that's the wall or the stage
  if (state.djs.includes(userId)) return toast("You're on stage. Step down to walk around.");
  send({ type: "move", x, y });
});

function openAvatarMenu(id) {
  const u = userById(id);
  const a = avatarEls.get(id);
  if (!u || !a) return;
  const items = id === userId
    ? [["🎨 Change my look", openLook], ["🍹 Get a drink", () => openBar(userId)]]
    : [
        ...Object.entries(config.throwables).map(([key, t]) => [`${t.icon} ${t.label} (🪙${t.price})`, () => send({ type: "throw", item: key, to: id })]),
        ["🍹 Buy them a drink", () => openBar(id)],
      ];
  const menu = $("avatarMenu");
  menu.replaceChildren(
    el("div", { class: "pop-title" }, id === userId ? `${u.name} (you)` : u.name),
    ...items.map(([label, fn]) => el("button", { type: "button", onclick: (e) => { e.stopPropagation(); closeAvatarMenu(); fn(); } }, label)),
  );
  const below = a.y < 60; // people on stage: open the menu under them
  menu.classList.toggle("below", below);
  menu.style.left = `${Math.min(84, Math.max(16, a.x))}%`;
  menu.style.top = `${below ? a.y + 6 : Math.max(30, a.y - 17)}%`;
  menu.hidden = false;
}

function closeAvatarMenu() { $("avatarMenu").hidden = true; }
document.addEventListener("keydown", (e) => e.key === "Escape" && closeAvatarMenu());
document.addEventListener("click", (e) => { if (!e.target.closest("#floor")) closeAvatarMenu(); });

// Something flies from one person to another in an arc.
function throwFx(fromId, toId, itemKey) {
  const from = avatarEls.get(fromId);
  const to = avatarEls.get(toId);
  const item = config.throwables[itemKey];
  if (!from || !to || !item) return;
  const p = el("div", { class: "projectile" }, item.icon);
  $("fx").append(p);
  const x1 = from.x, y1 = from.y - 10, x2 = to.x, y2 = to.y - 10;
  const start = performance.now();
  const dur = 750;
  const step = (now) => {
    const k = Math.min(1, (now - start) / dur);
    p.style.left = `${x1 + (x2 - x1) * k}%`;
    p.style.top = `${y1 + (y2 - y1) * k - 60 * k * (1 - k)}%`;
    p.style.transform = `translate(-50%, -50%) rotate(${k * 540}deg)`;
    if (k < 1) return requestAnimationFrame(step);
    p.remove();
    landFx(to, itemKey);
  };
  requestAnimationFrame(step);
}

function landFx(a, itemKey) {
  const mark = itemKey === "tomato" ? el("span", { class: "splat" }) : el("span", { class: "hearts" }, "💖");
  a.el.append(mark);
  if (itemKey === "tomato") {
    a.el.classList.add("hit");
    setTimeout(() => a.el.classList.remove("hit"), 800);
  }
  setTimeout(() => mark.remove(), 2700);
}

function showBubble(id, text) {
  const a = avatarEls.get(id);
  if (!a) return;
  a.el.querySelector(".bubble")?.remove();
  const b = el("span", { class: "bubble" }, text.length > 60 ? `${text.slice(0, 57)}…` : text);
  a.el.append(b);
  setTimeout(() => b.remove(), 5000);
}

// ------------------------------------------------------------ the bar

function openBar(target) {
  const online = state.users.filter((u) => u.online);
  const sel = $("barFor");
  sel.replaceChildren(
    el("option", { value: userId }, "Me"),
    ...online.filter((u) => u.id !== userId).map((u) => el("option", { value: u.id }, u.name)),
    el("option", { value: "all" }, `Everyone here (${online.length})`),
  );
  sel.value = [...sel.options].some((o) => o.value === target) ? target : userId;
  renderMenu();
  $("barDialog").showModal();
}

function renderMenu() {
  const to = $("barFor").value;
  const n = to === "all" ? state.users.filter((u) => u.online).length : 1;
  const coins = me()?.coins ?? 0;
  $("barCoins").textContent = coins;
  $("menu").replaceChildren(...Object.entries(config.menu).map(([key, d]) => {
    const cost = d.price * n;
    return el("button", {
      type: "button", class: "drink-btn", disabled: cost > coins,
      onclick: () => { send({ type: "buy", item: key, to }); $("barDialog").close(); },
    }, el("span", { class: "drink-icon" }, d.icon), el("span", { class: "drink-name" }, d.name), el("span", { class: "price" }, `🪙 ${cost}`));
  }));
}

$("barFor").onchange = renderMenu;
$("barBtn").onclick = () => openBar(userId);
$("barArea").addEventListener("keydown", (e) => e.key === "Enter" && openBar(userId));

// ------------------------------------------------------------ your look

let draftLook = null;

function openLook() {
  const fallback = { skin: config.looks.skin[0], shirt: config.looks.shirt[0], hat: "none" };
  draftLook = { ...(me()?.look || store.get("lr.look") || fallback) };
  renderLook();
  $("lookDialog").showModal();
}

function renderLook() {
  $("lookPreview").innerHTML = figureSvg(draftLook);
  const swatches = (kind) => config.looks[kind].map((c) => el("button", {
    type: "button", class: `swatch ${draftLook[kind] === c ? "on" : ""}`, style: `background:${c}`,
    "aria-label": `${kind} ${c}`, onclick: () => { draftLook[kind] = c; renderLook(); },
  }));
  $("skinOpts").replaceChildren(...swatches("skin"));
  $("shirtOpts").replaceChildren(...swatches("shirt"));
  $("hatOpts").replaceChildren(...config.looks.hat.map((h) => {
    const b = el("button", { type: "button", class: `hat-opt ${draftLook.hat === h ? "on" : ""}`, title: h, "aria-label": h, onclick: () => { draftLook.hat = h; renderLook(); } });
    b.innerHTML = figureSvg({ ...draftLook, hat: h }, true);
    return b;
  }));
}

$("lookBtn").onclick = openLook;
$("lookSave").onclick = () => {
  store.set("lr.look", draftLook);
  send({ type: "look", look: draftLook });
};

// ------------------------------------------------------------ chat

const IMG_URL = /^https:\/\/\S+\.(gif|webp|png|jpe?g)(\?\S*)?$/i;

function renderChat(m, live) {
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
    if (live) showBubble(m.userId, gif ? "🖼️" : m.text);
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

// ------------------------------------------------------------ tabs, history, top DJs

for (const tab of document.querySelectorAll(".tab")) {
  tab.onclick = () => {
    for (const t of document.querySelectorAll(".tab")) {
      t.classList.toggle("active", t === tab);
      $(t.dataset.tab).hidden = t !== tab;
    }
  };
}

function renderHistory() {
  const box = $("history");
  if (!playHistory.length) {
    box.replaceChildren(el("div", { class: "muted small" }, "Nothing has played yet."));
    return;
  }
  box.replaceChildren(...playHistory.map((h) => el("div", { class: "item" },
    el("img", { src: h.track.art || "", alt: "" }),
    el("div", { class: "meta" },
      el("div", { class: "t", title: h.track.title }, h.track.title),
      el("div", { class: "a" }, `${h.track.artist} · played by ${h.djName}`),
      el("div", { class: "a" }, `${new Date(h.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · 👍 ${h.awesome} · 👎 ${h.lame}`)),
    el("div", { class: "acts" },
      el("button", {
        title: "Add to my queue",
        onclick: (e) => { send({ type: "queue_add", track: h.track }); e.currentTarget.disabled = true; toast(`Added "${h.track.title}" to your queue.`); },
      }, "+ Queue")))));
}

function renderTop() {
  const box = $("top");
  if (!topDjs.length) {
    box.replaceChildren(el("li", { class: "muted small" }, "No Awesomes yet. Step up and play something good."));
    return;
  }
  box.replaceChildren(...topDjs.map((u, i) => {
    const face = el("span", { class: "mini" });
    face.innerHTML = figureSvg(u.look, true);
    return el("li", {}, el("b", { class: "rank" }, String(i + 1)), face, el("span", { class: "grow" }, u.name), el("span", { class: "muted" }, `★ ${u.score}`));
  }));
}
renderHistory();
renderTop();

// ------------------------------------------------------------ search + queue

const YT_URL = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/|music\.youtube\.com\/watch\?(?:.*&)?v=)([\w-]{11})/;
let lastResults = [];

// The server tries Spotify, Deezer, then iTunes. If they're all busy, this
// browser asks iTunes directly, since iTunes limits by address.
async function searchCatalog(q) {
  try {
    return (await api(`/api/search?q=${encodeURIComponent(q)}`)).results;
  } catch (err) {
    if (/password/i.test(err.message)) throw err;
    const r = await fetch(`https://itunes.apple.com/search?media=music&entity=song&limit=15&term=${encodeURIComponent(q)}`);
    if (!r.ok) throw new Error(`Search is busy right now (${r.status}). Try again in a minute.`);
    const data = await r.json();
    return (data.results || []).map((t) => ({
      title: t.trackName,
      artist: t.artistName,
      album: t.collectionName || "",
      art: (t.artworkUrl100 || "").replace("100x100", "300x300"),
      durationMs: t.trackTimeMillis || 0,
    }));
  }
}

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
      lastResults = await searchCatalog(q);
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
      el("button", { title: "Add to top of queue", onclick: (e) => addTrack(i, true, e.currentTarget) }, "⤒"),
      el("button", { class: "primary", onclick: (e) => addTrack(i, false, e.currentTarget) }, "+ Queue")))));
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
