// Chùa Online - server (đã bỏ yêu cầu nhập key, thêm tự động kết nối TikTok)
function initApp() {
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const https = require("https");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");

const HTTP_PORT = 3000;
const WS_PORT = 8080;
// Mặc định chỉ cho truy cập từ chính máy này. Muốn mở cho máy khác trong LAN: set HOST=0.0.0.0
const HOST = process.env.HOST || "127.0.0.1";

// ─── Cấu hình lưu trong connector_config.json ───────────────────
const CONFIG_FILE = path.join(__dirname, "connector_config.json");
let settings = {
  apiKey: process.env.EULER_API_KEY || "",
  sessionId: process.env.TIKTOK_SESSION_ID || "",
  username: "",
  autoConnect: true,
  adminPasswordHash: ""
};
function loadSettings() {
  if (!fs.existsSync(CONFIG_FILE)) return;
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    if (typeof saved.apiKey === "string" && saved.apiKey) settings.apiKey = saved.apiKey;
    if (typeof saved.sessionId === "string" && saved.sessionId) settings.sessionId = saved.sessionId;
    if (typeof saved.username === "string") settings.username = saved.username;
    if (typeof saved.autoConnect === "boolean") settings.autoConnect = saved.autoConnect;
    if (typeof saved.adminPasswordHash === "string") settings.adminPasswordHash = saved.adminPasswordHash;
  } catch (e) {
    console.error("[CONFIG] Không đọc được connector_config.json:", e.message);
  }
}
function saveSettings() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error("[CONFIG] Không ghi được connector_config.json:", e.message);
  }
}
loadSettings();

// ═══════════════════════════════════════════════════════════════
//  KIỂM DUYỆT BÌNH LUẬN (lọc từ cấm, link, spam)  — moderation.json
// ═══════════════════════════════════════════════════════════════
const MOD_FILE = path.join(__dirname, "moderation.json");
const DEFAULT_MOD = {
  enabled: true,
  blockLinks: true,
  maxChatLength: 100,        // cắt bớt bình luận dài hơn số ký tự này
  perUserCooldownMs: 3000,   // mỗi người chỉ được hiện 1 bình luận mỗi 3 giây
  maxChatsPerSecond: 3,      // tối đa số bình luận hiện/đọc mỗi giây (toàn kênh)
  dropDuplicateMs: 30000,    // bỏ bình luận y hệt của cùng 1 người trong 30 giây
  bannedWords: [
    "đm", "dm", "dmm", "đmm", "dcm", "đcm", "đcmm", "vcl", "vkl", "clgt",
    "cặc", "lồn", "buồi", "địt", "đụ", "đéo", "đĩ", "chó đẻ", "óc chó", "mẹ mày",
    "sex", "porn", "xxx", "cá độ", "nhà cái", "soi cầu", "lô đề", "casino"
  ]
};
let mod = JSON.parse(JSON.stringify(DEFAULT_MOD));
const modStats = { passed: 0, bannedWord: 0, link: 0, spam: 0 };
let bannedCache = [];

function tokenize(text) {
  return String(text || "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}
// Gộp chữ bị kéo dài: "đmmmmm" -> "đm" (chống lách luật bằng cách lặp ký tự)
const squash = (str) => str.replace(/(.)\1+/gu, "$1");
let bannedSquashed = [];
function rebuildBanned() {
  bannedCache = mod.bannedWords.map((w) => tokenize(w).join(" ")).filter(Boolean);
  // Chỉ dùng dạng gộp cho mục còn từ 2 ký tự trở lên, tránh chặn nhầm chữ đơn như "x"
  bannedSquashed = Array.from(new Set(bannedCache.map(squash).filter((b) => b.replace(/ /g, "").length >= 2)));
}
function containsBanned(text) {
  if (!bannedCache.length) return false;
  const tokens = tokenize(text);
  const t = " " + tokens.join(" ") + " ";
  if (bannedCache.some((b) => t.includes(" " + b + " "))) return true;
  const sq = " " + tokens.map(squash).join(" ") + " ";
  return bannedSquashed.some((b) => sq.includes(" " + b + " "));
}
const LINK_RE = /(https?:\/\/|www\.|\b[a-z0-9-]{2,}\.(com|net|org|vn|xyz|top|me|io|info|club|site|online|tk|ml|ly|gl)\b|\bt\.me\b|(?:\d[ .\-]?){9,})/i;

function loadMod() {
  try {
    if (!fs.existsSync(MOD_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(MOD_FILE, "utf-8"));
    for (const k of Object.keys(DEFAULT_MOD)) {
      if (saved[k] !== undefined && typeof saved[k] === typeof DEFAULT_MOD[k]) mod[k] = saved[k];
    }
    if (!Array.isArray(mod.bannedWords)) mod.bannedWords = DEFAULT_MOD.bannedWords.slice();
  } catch (e) {
    console.error("[MOD] Không đọc được moderation.json:", e.message);
  }
}
function saveMod() {
  try { fs.writeFileSync(MOD_FILE, JSON.stringify(mod, null, 2)); }
  catch (e) { console.error("[MOD] Không ghi được moderation.json:", e.message); }
}
loadMod();
rebuildBanned();

const CTRL_RE = /[\u0000-\u001f\u007f\u200B-\u200D\uFEFF]/g;
const userLastChat = new Map();   // userId -> thời điểm bình luận gần nhất
const userLastText = new Map();   // userId -> {text, t}
let chatWindow = [];              // mốc thời gian các bình luận vừa cho qua (giới hạn theo giây)

setInterval(() => {               // dọn bộ nhớ đệm
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of userLastChat) if (v < cutoff) userLastChat.delete(k);
  for (const [k, v] of userLastText) if (v.t < cutoff) userLastText.delete(k);
}, 60000).unref();

function cleanNickname(n) {
  const s = String(n || "").replace(CTRL_RE, " ").replace(/\s+/g, " ").trim();
  if (!s) return "Phật tử";
  if (mod.enabled && (containsBanned(s) || (mod.blockLinks && LINK_RE.test(s)))) return "Phật tử";
  return Array.from(s).slice(0, 30).join("");
}

// Trả về sự kiện chat đã làm sạch, hoặc null nếu bị chặn
function filterChat(ev) {
  let text = String(ev.text || "").replace(CTRL_RE, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (!mod.enabled) { ev.text = text; modStats.passed++; return ev; }

  text = text.replace(/(.)\1{4,}/gu, "$1$1$1");           // "aaaaaaa" -> "aaa"
  if (containsBanned(text)) { modStats.bannedWord++; return null; }
  if (mod.blockLinks && LINK_RE.test(text)) { modStats.link++; return null; }

  const chars = Array.from(text);
  if (chars.length > mod.maxChatLength) text = chars.slice(0, mod.maxChatLength).join("").trim() + "…";

  const uid = String(ev.userId || "");
  const now = Date.now();
  if (now - (userLastChat.get(uid) || 0) < mod.perUserCooldownMs) { modStats.spam++; return null; }
  const prev = userLastText.get(uid);
  if (prev && prev.text === text && now - prev.t < mod.dropDuplicateMs) { modStats.spam++; return null; }
  chatWindow = chatWindow.filter((t) => now - t < 1000);
  if (chatWindow.length >= mod.maxChatsPerSecond) { modStats.spam++; return null; }

  chatWindow.push(now);
  userLastChat.set(uid, now);
  userLastText.set(uid, { text, t: now });
  modStats.passed++;
  ev.text = text;
  return ev;
}

// ═══════════════════════════════════════════════════════════════
//  ĐIỂM CÔNG ĐỨC (chỉ tính từ sự kiện THẬT của TikTok) — merit_data.json
// ═══════════════════════════════════════════════════════════════
const MERIT_FILE = path.join(__dirname, "merit_data.json");
const MERIT_WEIGHTS = { perDiamond: 10, perLike: 1, perChat: 2 };
const MERIT_MAX_USERS = 5000;
let merit = {};
let meritDirty = false;

try {
  if (fs.existsSync(MERIT_FILE)) merit = JSON.parse(fs.readFileSync(MERIT_FILE, "utf-8")) || {};
} catch (e) {
  console.error("[MERIT] Không đọc được merit_data.json (bỏ qua):", e.message);
  merit = {};
}

function recordMerit(ev) {
  if (!ev || !["gift", "like", "chat"].includes(ev.type)) return;
  const uid = String(ev.userId || "");
  if (!uid) return;
  const now = Date.now();
  let r = merit[uid];
  if (!r) r = merit[uid] = { name: "Phật tử", points: 0, diamonds: 0, gifts: 0, likes: 0, chats: 0, first: now, last: now };
  if (ev.nickname) r.name = String(ev.nickname);
  r.last = now;
  if (ev.type === "gift") {
    const d = Math.max(0, Math.min(Number(ev.diamonds) || 0, 1000000));
    r.diamonds += d; r.gifts += 1; r.points += d * MERIT_WEIGHTS.perDiamond;
  } else if (ev.type === "like") {
    const c = Math.max(0, Math.min(Number(ev.count) || 0, 1000));
    r.likes += c; r.points += c * MERIT_WEIGHTS.perLike;
  } else {
    r.chats += 1; r.points += MERIT_WEIGHTS.perChat;
  }
  meritDirty = true;
}

function flushMerit() {
  if (!meritDirty) return;
  try {
    const ids = Object.keys(merit);
    if (ids.length > MERIT_MAX_USERS) {            // giữ lại những người nhiều điểm nhất
      ids.sort((a, b) => merit[b].points - merit[a].points);
      const keep = {};
      for (const id of ids.slice(0, Math.floor(MERIT_MAX_USERS * 0.9))) keep[id] = merit[id];
      merit = keep;
    }
    const tmp = MERIT_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(merit));
    fs.renameSync(tmp, MERIT_FILE);
    meritDirty = false;
  } catch (e) {
    console.error("[MERIT] Không lưu được merit_data.json:", e.message);
  }
}
setInterval(flushMerit, 5000).unref();
process.on("exit", () => {
  flushMerit();
  try { if (bridgeProcess) bridgeProcess.kill(); } catch (e) {}   // không để bridge mồ côi
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => process.exit(0));
}

const CACHE_DIR = path.join(__dirname, "chua_clone", "assets", "cache_voice");
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function getVoiceHash(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

const app = express();

// ─── Bảo mật: chống trang web lạ / DNS rebinding / CSRF ───────────
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || crypto.randomBytes(24).toString("hex");
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const HOST_IS_LOOPBACK = LOOPBACK_HOSTS.has(HOST);
const EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
const EXTRA_HOSTS = (process.env.ALLOWED_HOSTS || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

function hostnameOf(hostHeader) {
  const h = String(hostHeader || "").trim().toLowerCase();
  if (h.startsWith("[")) { const i = h.indexOf("]"); return i > 0 ? h.slice(0, i + 1) : h; }
  return h.split(":")[0];
}
function isHostAllowed(hostHeader) {
  const name = hostnameOf(hostHeader);
  return LOOPBACK_HOSTS.has(name) || EXTRA_HOSTS.includes(name);
}
function isAllowedOrigin(origin, hostHeader) {
  if (!origin) return true;                       // không phải trình duyệt (bridge, curl...)
  if (EXTRA_ORIGINS.includes(String(origin).toLowerCase())) return true;
  let u;
  try { u = new URL(origin); } catch (e) { return false; }
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  if (port !== String(HTTP_PORT)) return false;   // chỉ chấp nhận trang do chính server này phát
  if (LOOPBACK_HOSTS.has(u.hostname) || LOOPBACK_HOSTS.has("[" + u.hostname + "]")) return true;
  return u.hostname.toLowerCase() === hostnameOf(hostHeader);
}
app.use((req, res, next) => {
  if (HOST_IS_LOOPBACK && !isHostAllowed(req.headers.host)) return res.status(403).send("Host không hợp lệ");
  if (!isAllowedOrigin(req.headers.origin, req.headers.host)) return res.status(403).send("Origin không được phép");
  next();
});

// ─── Mật khẩu trang quản trị (tuỳ chọn) ───────────────────────────
function safeEq(a, b) {
  const A = crypto.createHash("sha256").update(String(a)).digest();
  const B = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(A, B);
}
function hasAdminPassword() { return !!(process.env.ADMIN_PASSWORD || settings.adminPasswordHash); }
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + crypto.scryptSync(pw, salt, 32).toString("hex");
}
function verifyAdminPassword(pw) {
  if (process.env.ADMIN_PASSWORD) return safeEq(pw, process.env.ADMIN_PASSWORD);
  const [salt, hash] = String(settings.adminPasswordHash || "").split(":");
  if (!salt || !hash) return false;
  const calc = crypto.scryptSync(String(pw), salt, 32);
  const expect = Buffer.from(hash, "hex");
  return expect.length === calc.length && crypto.timingSafeEqual(calc, expect);
}
const authFails = new Map(); // ip -> {n, t}
app.use((req, res, next) => {
  const p = req.path;
  const isProtected = p === "/admin" || (p.startsWith("/api/") && !p.startsWith("/api/giong-") && p !== "/api/leaderboard");
  if (!isProtected || !hasAdminPassword()) return next();

  const ip = req.socket.remoteAddress || "?";
  const rec = authFails.get(ip);
  if (rec && rec.n >= 10 && Date.now() - rec.t < 5 * 60 * 1000) return res.status(429).send("Sai mật khẩu quá nhiều lần, thử lại sau 5 phút");

  const header = req.headers.authorization || "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
    const pw = decoded.slice(decoded.indexOf(":") + 1);
    if (verifyAdminPassword(pw)) { authFails.delete(ip); return next(); }
    authFails.set(ip, { n: ((rec && Date.now() - rec.t < 5 * 60 * 1000) ? rec.n : 0) + 1, t: Date.now() });
  }
  res.set("WWW-Authenticate", 'Basic realm="Chua Online Admin", charset="UTF-8"');
  res.status(401).send("Cần mật khẩu quản trị");
});
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "chua_clone")));

// ─── TTS Audio Proxy & Cache ──────────────────────────────────────
const pendingTTS = new Map();

app.get("/api/giong-doc", (req, res) => {
  const text = (req.query.chu || "").trim();
  const giongNum = parseInt(req.query.giong, 10);
  const giong = String(Number.isInteger(giongNum) && giongNum >= 0 && giongNum < 100 ? giongNum : 0);
  const token = req.query.t || "rdJTEZhSvawCJ-M5qlT4Lg";

  if (!text) return res.status(400).send("Thiếu text");

  const hashKey = `${giong}_${getVoiceHash(text)}`;
  const cacheFile = path.join(CACHE_DIR, `${hashKey}.mp3`);

  // Phục vụ tức thì từ ổ cứng (0ms) nếu đã có trong cache
  if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 100) {
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Accept-Ranges", "bytes");
    return fs.createReadStream(cacheFile).pipe(res);
  }

  // Nếu đang có một request cùng nội dung đang tải, gom chờ chung để không nghẽn
  if (pendingTTS.has(hashKey)) {
    pendingTTS.get(hashKey).push(res);
    return;
  }

  pendingTTS.set(hashKey, [res]);

  const upstreamUrl = `https://sannhay.tuanticker.lol/api/giong-doc?t=${encodeURIComponent(token)}&chu=${encodeURIComponent(text)}&giong=${encodeURIComponent(giong)}`;

  https.get(upstreamUrl, { headers: { "User-Agent": "Mozilla/5.0" } }, (upstreamRes) => {
    if (upstreamRes.statusCode === 200) {
      const fileStream = fs.createWriteStream(cacheFile);
      upstreamRes.pipe(fileStream);

      fileStream.on("finish", () => {
        const waitingList = pendingTTS.get(hashKey) || [];
        pendingTTS.delete(hashKey);

        for (const clientRes of waitingList) {
          try {
            clientRes.setHeader("Content-Type", "audio/mpeg");
            clientRes.setHeader("Accept-Ranges", "bytes");
            fs.createReadStream(cacheFile).pipe(clientRes);
          } catch(e) {}
        }
      });
    } else {
      console.warn(`[TTS] Upstream status ${upstreamRes.statusCode} for: "${text}"`);
      const waitingList = pendingTTS.get(hashKey) || [];
      pendingTTS.delete(hashKey);
      for (const clientRes of waitingList) {
        try { clientRes.status(upstreamRes.statusCode).end(); } catch(e) {}
      }
    }
  }).on("error", (err) => {
    console.error(`[TTS] Request failed: ${err.message}`);
    const waitingList = pendingTTS.get(hashKey) || [];
    pendingTTS.delete(hashKey);
    for (const clientRes of waitingList) {
      try { clientRes.status(500).end(); } catch(e) {}
    }
  });
});

// ─── WebSocket Server (Relay events to Game client) ───────────────
const wss = new WebSocketServer({
  port: WS_PORT,
  host: HOST,
  maxPayload: 64 * 1024,
  verifyClient: (info) => {
    if (HOST_IS_LOOPBACK && !isHostAllowed(info.req.headers.host)) return false;
    return isAllowedOrigin(info.origin, info.req.headers.host);
  }
});
let gameSockets = new Set();
let bridgeSocket = null;

let bridgeProcess = null;
let currentUsername = "";
let currentRoomId = "";
let connectionStatus = "disconnected";
let lastError = "";

wss.on("connection", (ws) => {
  console.log(`[WS] Client connected`);

  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.source === "python_bridge" && data.token === BRIDGE_TOKEN) {
        delete data.token;
        bridgeSocket = ws;
        if (data.type === "tiktok_status") {
          connectionStatus = data.status;
          if (data.roomId) currentRoomId = data.roomId;
          if (data.status === "connected") { restartCount = 0; lastError = ""; }
          if (data.error) lastError = data.error;
          console.log(`[TikTok Bridge] @${data.username || currentUsername}: ${data.status} ${data.roomId ? '(Room: ' + data.roomId + ')' : ''}`);
        } else {
          // Bắn trực tiếp các sự kiện viewer, chat, gift, like, social tới tất cả màn hình Game
          let out = data;
          if (out.nickname !== undefined) out.nickname = cleanNickname(out.nickname);
          if (out.type === "chat") out = filterChat(out);
          if (out) {
            recordMerit(out);
            broadcast(out);
          }
        }
      }
    } catch (e) {}
  });

  gameSockets.add(ws);
  console.log(`[WS] Total clients connected: ${gameSockets.size}`);

  ws.on("close", () => {
    gameSockets.delete(ws);
    if (ws === bridgeSocket) bridgeSocket = null;
    console.log(`[WS] Client disconnected (Remaining: ${gameSockets.size})`);
  });
});

function broadcast(eventData) {
  const payload = JSON.stringify(eventData);
  for (const client of gameSockets) {
    if (client !== bridgeSocket && client.readyState === 1) { // OPEN
      client.send(payload);
    }
  }
}

function findPythonBinary() {
  if (process.env.PYTHON_CMD) return process.env.PYTHON_CMD;
  if (process.env.PYTHON_BIN && fs.existsSync(process.env.PYTHON_BIN)) return process.env.PYTHON_BIN;
  const localBin = path.join(__dirname, "bin", "python.exe");
  if (fs.existsSync(localBin)) return localBin;

  const candidatePaths = [
    "C:\\Python314\\python.exe",
    "C:\\Python313\\python.exe",
    "C:\\Python312\\python.exe",
    "C:\\Python311\\python.exe",
    "C:\\Python310\\python.exe"
  ];
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    for (const ver of ["Python314", "Python313", "Python312", "Python311", "Python310"]) {
      candidatePaths.push(path.join(localAppData, "Programs", "Python", ver, "python.exe"));
    }
  }
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) return p;
  }
  return "python";
}

// ─── TikTok Live Connection Manager (Python Native Bridge) ──────────────
let wantConnected = false;   // true = muốn luôn giữ kết nối (tự khởi động lại nếu bridge sập)
let restartTimer = null;
let restartCount = 0;

function stopBridgeProcess() {
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (bridgeProcess) {
    const proc = bridgeProcess;
    bridgeProcess = null; // đặt trước để handler "close" biết đây là chủ động dừng
    try { proc.kill(); } catch (e) {}
  }
}

function startBridge() {
  restartTimer = null;
  if (!wantConnected || !currentUsername) return;

  const pythonBin = findPythonBinary();
  const bridgeScript = path.join(__dirname, "tiktok_bridge.py");
  connectionStatus = "connecting";
  console.log(`[TikTok] Kết nối kênh @${currentUsername} qua Python Bridge (${pythonBin})...`);

  let proc;
  try {
    proc = spawn(pythonBin, [bridgeScript, currentUsername, "--ws", `ws://127.0.0.1:${WS_PORT}`], {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUNBUFFERED: "1",
        EULER_API_KEY: settings.apiKey || "",
        TIKTOK_SESSION_ID: settings.sessionId || "",
        BRIDGE_TOKEN: BRIDGE_TOKEN
      }
    });
  } catch (err) {
    console.error(`[TikTok Bridge] Không thể tạo tiến trình: ${err.message}`);
    connectionStatus = "error";
    lastError = err.message;
    scheduleRestart();
    return;
  }
  bridgeProcess = proc;

  proc.on("error", (err) => {
    console.error(`[TikTok Bridge] Lỗi tiến trình Python: ${err.message}`);
    connectionStatus = "error";
    lastError = "Không chạy được Python. Hãy cài Python từ python.org (tích chọn Add to PATH) rồi chạy lại CHAY_NGAY.bat.";
  });

  proc.stdout.on("data", (chunk) => {
    for (const l of chunk.toString().split(/\r?\n/).filter(Boolean)) console.log(l);
  });

  proc.stderr.on("data", (chunk) => {
    const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
    for (const l of lines) console.error(`[Bridge Err] ${l}`);
    const last = lines[lines.length - 1];
    if (last) lastError = last.slice(0, 300);
  });

  proc.on("close", (code) => {
    console.log(`[Bridge] Tiến trình kết nối TikTok dừng (code ${code})`);
    if (proc !== bridgeProcess) return; // đã bị thay thế hoặc dừng chủ động
    bridgeProcess = null;
    if (wantConnected) {
      connectionStatus = "error";
      if (!lastError) lastError = `Bridge dừng bất ngờ (code ${code}).`;
      scheduleRestart();
    } else {
      connectionStatus = "disconnected";
    }
  });
}

function scheduleRestart() {
  if (!wantConnected || restartTimer) return;
  restartCount++;
  const delay = Math.min(30000, 3000 * restartCount);
  console.log(`[TikTok] Sẽ tự khởi động lại bridge sau ${Math.round(delay / 1000)} giây...`);
  restartTimer = setTimeout(startBridge, delay);
}

function connectToTikTok(username) {
  stopBridgeProcess();
  currentUsername = String(username || "").replace(/^@/, "").trim().toLowerCase();
  if (!currentUsername) return;
  wantConnected = true;
  restartCount = 0;
  currentRoomId = "";
  lastError = "";
  startBridge();
}

function disconnectTikTok() {
  wantConnected = false;
  stopBridgeProcess();
  connectionStatus = "disconnected";
  currentRoomId = "";
  lastError = "";
}

// ─── HTTP API & Admin UI ──────────────────────────────────────────
app.get("/api/status", (req, res) => {
  res.json({
    status: connectionStatus,
    username: currentUsername,
    roomId: currentRoomId,
    lastError: lastError,
    clients: Math.max(0, gameSockets.size - (bridgeSocket ? 1 : 0))
  });
});

app.get("/api/config", (req, res) => {
  res.json({
    hasApiKey: !!settings.apiKey,
    hasSession: !!settings.sessionId,
    username: settings.username,
    autoConnect: settings.autoConnect,
    hasAdminPassword: hasAdminPassword(),
    adminPasswordFromEnv: !!process.env.ADMIN_PASSWORD
  });
});

app.post("/api/config", (req, res) => {
  const b = req.body || {};
  // Để trống = giữ nguyên giá trị cũ. Muốn xoá thì gửi clearApiKey / clearSession.
  if (typeof b.apiKey === "string" && b.apiKey.trim()) settings.apiKey = b.apiKey.trim();
  if (b.clearApiKey) settings.apiKey = "";
  if (typeof b.sessionId === "string" && b.sessionId.trim()) settings.sessionId = b.sessionId.trim();
  if (b.clearSession) settings.sessionId = "";
  if (typeof b.autoConnect === "boolean") settings.autoConnect = b.autoConnect;
  if (typeof b.adminPassword === "string" && b.adminPassword.length > 0) {
    if (b.adminPassword.length < 6) return res.status(400).json({ error: "Mật khẩu quản trị cần ít nhất 6 ký tự" });
    settings.adminPasswordHash = hashPassword(b.adminPassword);
  }
  if (b.clearAdminPassword) settings.adminPasswordHash = "";
  saveSettings();
  console.log(`[CONFIG] Đã lưu (ApiKey: ${settings.apiKey ? "ĐÃ CÓ" : "CHƯA CÓ"}, Session: ${settings.sessionId ? "ĐÃ CÓ" : "CHƯA CÓ"}, Tự kết nối: ${settings.autoConnect ? "BẬT" : "TẮT"})`);
  // Nếu đang giữ kết nối thì nạp lại để áp dụng key mới ngay
  if (wantConnected && currentUsername) connectToTikTok(currentUsername);
  res.json({ success: true, message: "Đã lưu cấu hình thành công" });
});

app.post("/api/connect", (req, res) => {
  const username = String((req.body && req.body.username) || "").replace(/^@/, "").trim();
  if (!username) return res.status(400).json({ error: "Thiếu username TikTok" });
  if (!/^[A-Za-z0-9._]{1,40}$/.test(username)) {
    return res.status(400).json({ error: "Username TikTok không hợp lệ (chỉ gồm chữ, số, dấu chấm, gạch dưới)" });
  }
  settings.username = username.toLowerCase();
  saveSettings(); // nhớ kênh để lần sau tự kết nối
  connectToTikTok(settings.username);
  res.json({ success: true, message: `Bắt đầu kết nối @${settings.username}` });
});

app.post("/api/disconnect", (req, res) => {
  disconnectTikTok();
  res.json({ success: true, message: "Đã ngắt kết nối" });
});

// Chuyển đổi mode trực tiếp
app.post("/api/mode", (req, res) => {
  const { mode } = req.body;
  if (!mode || !["hanh-le", "vuon-sen"].includes(mode)) {
    return res.status(400).json({ error: "Mode không hợp lệ" });
  }
  broadcast({ type: "control", action: "mode", mode });
  console.log(`[MODE] Switched game mode to: ${mode}`);
  res.json({ success: true, mode });
});

// Giả lập nạp danh sách phật tử vào phòng
app.post("/api/seed", (req, res) => {
  const names = [
    "An Nhiên", "Minh Tâm", "Thiện Ý", "Bảo Ngọc", "Tịnh Tiết", "Hoàng Long", 
    "Thu Hà", "Quốc Đạt", "Lan Chi", "Mai Phương", "Đức Huy", "Khánh Vy", 
    "Gia Bảo", "Hải Đăng", "Ngọc Ánh", "Phương Linh", "Tâm Như", "Phước An", 
    "Từ Bi", "Hỷ Xả", "Giác Ngộ", "Thiền Tâm", "Pháp Vân", "Phổ Hiền", "Quảng Đức"
  ];
  names.forEach((name, i) => {
    setTimeout(() => {
      broadcast({
        type: "viewer",
        userId: `seed_${i}`,
        nickname: name,
        avatarUrl: ""
      });
    }, i * 80);
  });
  res.json({ success: true, message: `Đang nạp ${names.length} phật tử vào chỗ...` });
});

// Reset toàn bộ danh sách phật tử và làm mới màn hình game
app.post("/api/reset", (req, res) => {
  broadcast({ type: "control", action: "reset", reset: true });
  console.log(`[RESET] Đã gửi lệnh reset toàn bộ phật tử tới tất cả màn hình Game.`);
  res.json({ success: true, message: "Đã reset toàn bộ phật tử thành công" });
});

// Giả lập sự kiện (Dành cho việc test trực tiếp)
app.post("/api/inject", (req, res) => {
  const event = req.body;
  if (!event || !event.type) return res.status(400).json({ error: "Dữ liệu event không hợp lệ" });
  broadcast(event);
  res.json({ success: true, injected: event });
});

// ─── API kiểm duyệt bình luận ─────────────────────────────────────
app.get("/api/moderation", (req, res) => {
  res.json({ ...mod, stats: modStats });
});

app.post("/api/moderation", (req, res) => {
  const b = req.body || {};
  const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v))));
  if (typeof b.enabled === "boolean") mod.enabled = b.enabled;
  if (typeof b.blockLinks === "boolean") mod.blockLinks = b.blockLinks;
  if (Number.isFinite(Number(b.maxChatLength))) mod.maxChatLength = num(b.maxChatLength, 20, 300);
  if (Number.isFinite(Number(b.perUserCooldownMs))) mod.perUserCooldownMs = num(b.perUserCooldownMs, 0, 60000);
  if (Number.isFinite(Number(b.maxChatsPerSecond))) mod.maxChatsPerSecond = num(b.maxChatsPerSecond, 1, 20);
  if (Array.isArray(b.bannedWords)) {
    const seen = new Set();
    mod.bannedWords = b.bannedWords
      .map((w) => String(w).trim().slice(0, 40))
      .filter((w) => w && !seen.has(w.toLowerCase()) && seen.add(w.toLowerCase()))
      .slice(0, 500);
  }
  rebuildBanned();
  saveMod();
  console.log(`[MOD] Đã lưu kiểm duyệt (${mod.bannedWords.length} từ cấm, bật: ${mod.enabled})`);
  res.json({ success: true, message: "Đã lưu cấu hình kiểm duyệt" });
});

// ─── API bảng xếp hạng công đức ───────────────────────────────────
app.get("/api/leaderboard", (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 10, 50));
  const rows = Object.values(merit)
    .sort((a, b) => b.points - a.points)
    .slice(0, limit)
    .map((r, i) => ({ rank: i + 1, name: r.name, points: r.points, diamonds: r.diamonds }));
  res.json({ updated: Date.now(), total: Object.keys(merit).length, rows });
});

app.post("/api/merit/reset", (req, res) => {
  merit = {};
  meritDirty = true;
  flushMerit();
  console.log("[MERIT] Đã xoá toàn bộ điểm công đức.");
  res.json({ success: true });
});

// Trang Admin điều khiển
app.get("/admin", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <title>Bảng Điều Khiển Chùa Online</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #181210; color: #f4e8da; margin: 0; padding: 24px; }
    h1 { color: #f5d06f; margin-bottom: 8px; }
    .card { background: #261914; border: 1px solid #4a3225; border-radius: 12px; padding: 20px; margin-bottom: 20px; max-width: 680px; }
    input, button, select { font-size: 15px; padding: 10px 14px; border-radius: 8px; border: 1px solid #634332; background: #120b08; color: #fff; }
    button { background: #b86e28; color: #fff; cursor: pointer; border: none; font-weight: bold; transition: 0.2s; }
    button:hover { background: #d98230; }
    button.btn-mode { background: #7a2818; padding: 12px 18px; font-size: 16px; margin-right: 10px; }
    button.btn-mode:hover { background: #a83620; }
    button.btn-mode.active { background: #c97d26; border: 2px solid #ffe3a0; }
    button.alt { background: #3b281f; border: 1px solid #634332; }
    button.alt:hover { background: #52382c; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 10px; margin-top: 14px; }
    .status-badge { display: inline-block; padding: 4px 10px; border-radius: 20px; font-size: 13px; font-weight: bold; }
    .badge-disconnected { background: #4a2119; color: #f88; }
    .badge-connecting { background: #544415; color: #fe8; }
    .badge-connected { background: #194a21; color: #8f8; }
    .links a { color: #f5d06f; margin-right: 15px; text-decoration: none; font-weight: bold; }
    .links a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>🏯 Bảng Điều Khiển Chùa Online</h1>
  <p class="links">
    Mở màn hình Game (cho OBS):
    <a href="/index.html?demo=1&relay=8080&mode=hanh-le" target="_blank">▶ Mở Mode Hành Lễ</a>
    <a href="/index.html?demo=1&relay=8080&mode=vuon-sen" target="_blank">▶ Mở Mode Vườn Sen</a>
  </p>

  <div class="card">
    <h3>1. Kết Nối TikTok Live (Chạy Trực Tiếp Bằng Tên - 100% Không Cần Cookie)</h3>
    <p style="font-size:13px; color:#c7a892; margin-bottom:12px;">
      Nhập chính xác TikTok Username của kênh đang live hoặc sắp live. Hệ thống tự động vượt WAF và kết nối trực tiếp, tự động nhận bình luận, tặng quà hoa sen, vái lạy và đọc tên bằng giọng AI.
    </p>
    <div style="display:flex; gap: 10px; align-items: center; margin-bottom: 12px;">
      <input type="text" id="tt-user" placeholder="Nhập TikTok username (vd: @thanhan_238)" style="flex:1;">
      <button onclick="connectLive()">🚀 Kết Nối Ngay</button>
      <button class="alt" onclick="disconnectLive()">⏹ Ngắt</button>
    </div>
    <div style="margin-top:8px;">Trạng thái: <span id="status-badge" class="status-badge badge-disconnected">Đang kiểm tra...</span></div>
    <div id="status-hint" style="font-size:12px; color:#ffcf6a; margin-top:8px;"></div>
  </div>

  <div class="card">
    <h3>⚙️ Tự Động & Cấu Hình Kết Nối</h3>
    <label style="display:block; margin-bottom:12px; font-size:14px;">
      <input type="checkbox" id="cfg-auto" checked style="transform:scale(1.3); margin-right:8px;">
      Tự động kết nối lại kênh đã lưu mỗi khi mở tool (tự canh khi streamer lên sóng)
    </label>
    <div style="display:flex; flex-direction:column; gap:10px;">
      <input type="password" id="cfg-apikey" placeholder="EulerStream API Key (không bắt buộc, giúp tránh lỗi giới hạn)">
      <input type="password" id="cfg-session" placeholder="TikTok Session ID (không bắt buộc)">
      <input type="password" id="cfg-adminpw" placeholder="Mật khẩu trang quản trị (từ 6 ký tự, để trống = giữ nguyên)">
      <div style="display:flex; gap:10px; align-items:center;">
        <button onclick="saveConfig()">💾 Lưu Cấu Hình</button>
        <span id="cfg-hint" style="font-size:12px; color:#c7a892;"></span>
      </div>
    </div>
  </div>

  <div class="card">
    <h3>2. Chuyển Đổi Chế Độ Game (Đổi Tức Thì Cả Màn Hình)</h3>
    <div style="display:flex; gap:12px; margin-bottom: 12px;">
      <button class="btn-mode" onclick="switchMode('hanh-le')">🏯 Chế độ Hành Lễ (Chánh điện vái lạy)</button>
      <button class="btn-mode" onclick="switchMode('vuon-sen')">🌸 Chế độ Vườn Sen (Đài sen toạ thiền)</button>
    </div>
    <div style="display:flex; gap:10px;">
      <button class="alt" onclick="seedDevotees()">👥 Nạp 25 Phật tử ngồi kín chỗ</button>
      <button class="alt" style="border-color:#ff8888; color:#ffb0b0;" onclick="resetDevotees()">🔄 Reset Tất Cả Phật Tử (Làm Mới Màn Hình)</button>
    </div>
  </div>

  <div class="card">
    <h3>3. Thử Nghiệm Tương Tác Trực Tiếp (Voice + Hoạt Họa + Chat)</h3>
    <p style="font-size:13px; color:#ffcf6a;">🔔 <i>Lưu ý: Bấm 1 click vào màn hình Game để trình duyệt cấp quyền phát Audio (Voice đọc tên và nhạc nền).</i></p>
    
    <div style="display:flex; gap:10px; margin-bottom:12px;">
      <input type="text" id="custom-chat" placeholder="Nhập câu chat bất kỳ..." style="flex:1;" value="Nam mô A Di Đà Phật, con cầu bình an">
      <button onclick="testCustomChat()">💬 Gửi Chat Bong Bóng</button>
    </div>

    <div class="grid">
      <button onclick="testJoin()">+ Người Mới Vào</button>
      <button onclick="testChat('Bình an')">Chat: Bình an</button>
      <button onclick="testChat('A Di Đà Phật')">Chat: A Di Đà Phật</button>
      <button onclick="testLike()">❤️ Thả 50 Tim</button>
      <button onclick="testGift('Hương Trầm', 1)">🕯️ Dâng Hương (1 xu)</button>
      <button onclick="testGift('Lễ Phật', 5)">🙏 Lễ Phật (5 xu)</button>
      <button onclick="testGift('Đài Sen', 10)">🪷 Dâng Hoa Sen (10 xu)</button>
      <button onclick="testGift('Đại Lễ Cúng Dường', 99)">✨ Đại Lễ (99 xu)</button>
    </div>
  </div>

  <div class="card">
    <h3>🛡️ Kiểm Duyệt Bình Luận (trước khi hiện & đọc bằng giọng AI)</h3>
    <label style="display:block; margin-bottom:8px; font-size:14px;">
      <input type="checkbox" id="mod-enabled" checked style="transform:scale(1.3); margin-right:8px;"> Bật kiểm duyệt
    </label>
    <label style="display:block; margin-bottom:12px; font-size:14px;">
      <input type="checkbox" id="mod-links" checked style="transform:scale(1.3); margin-right:8px;"> Chặn link, tên miền và số điện thoại
    </label>
    <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:12px; font-size:13px; color:#c7a892;">
      <label>Dài tối đa (ký tự)<br><input type="number" id="mod-maxlen" min="20" max="300" style="width:110px;"></label>
      <label>Mỗi người cách nhau (giây)<br><input type="number" id="mod-cooldown" min="0" max="60" style="width:110px;"></label>
      <label>Tối đa bình luận / giây<br><input type="number" id="mod-rate" min="1" max="20" style="width:110px;"></label>
    </div>
    <p style="font-size:13px; color:#c7a892; margin:0 0 6px;">Từ / cụm từ cấm (mỗi dòng một mục). Bình luận hoặc tên chứa mục này sẽ bị chặn.</p>
    <textarea id="mod-words" rows="6" style="width:100%; box-sizing:border-box; font-size:14px; padding:10px; border-radius:8px; border:1px solid #634332; background:#120b08; color:#fff;"></textarea>
    <div style="display:flex; gap:10px; align-items:center; margin-top:10px;">
      <button onclick="saveModeration()">💾 Lưu Kiểm Duyệt</button>
      <span id="mod-stats" style="font-size:12px; color:#c7a892;"></span>
    </div>
  </div>

  <div class="card">
    <h3>🪷 Bảng Công Đức</h3>
    <p style="font-size:13px; color:#c7a892; margin:0 0 10px;">
      Điểm tính từ quà, tim và bình luận THẬT của khán giả: 1 xu = ${MERIT_WEIGHTS.perDiamond} điểm, 1 tim = ${MERIT_WEIGHTS.perLike} điểm, 1 bình luận = ${MERIT_WEIGHTS.perChat} điểm. Lưu vào merit_data.json nên không mất khi tắt tool.
    </p>
    <div id="lb-rows" style="font-size:14px; margin-bottom:10px;"></div>
    <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
      <a href="/leaderboard.html?top=5" target="_blank" style="color:#f5d06f; font-weight:bold; text-decoration:none;">▶ Mở bảng cho OBS</a>
      <button class="alt" style="border-color:#ff8888; color:#ffb0b0;" onclick="resetMerit()">🗑 Xoá toàn bộ điểm</button>
      <span id="lb-total" style="font-size:12px; color:#c7a892;"></span>
    </div>
  </div>

  <script>
    let currentUserId = "phat_tu_1";
    let currentUserName = "Tâm An";

    let randomUsers = [
      { id: "u1", name: "Tâm An" },
      { id: "u2", name: "Thiện Đức" },
      { id: "u3", name: "Bảo Ngọc" },
      { id: "u4", name: "Minh Tuệ" },
      { id: "u5", name: "Khánh An" },
      { id: "u6", name: "Quốc Đạt" },
      { id: "u7", name: "Phương Lan" }
    ];
    function getRandUser() {
      return randomUsers[Math.floor(Math.random() * randomUsers.length)];
    }

    async function switchMode(mode) {
      await fetch('/api/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode })
      });
    }

    async function seedDevotees() {
      await fetch('/api/seed', { method: 'POST' });
    }

    async function resetDevotees() {
      if (confirm("Bạn có chắc chắn muốn reset toàn bộ phật tử và làm mới màn hình game không?")) {
        await fetch('/api/reset', { method: 'POST' });
      }
    }

    async function sendInject(data) {
      await fetch('/api/inject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
    }

    function testJoin() {
      const u = getRandUser();
      currentUserId = "user_" + Date.now().toString().slice(-4);
      currentUserName = u.name;
      sendInject({ type: 'viewer', userId: currentUserId, nickname: currentUserName });
    }

    function testCustomChat() {
      const text = document.getElementById('custom-chat').value.trim();
      if (!text) return;
      sendInject({ type: 'chat', userId: currentUserId, nickname: currentUserName, text: text });
    }

    function testChat(text) {
      sendInject({ type: 'chat', userId: currentUserId, nickname: currentUserName, text: text });
    }

    function testLike() {
      sendInject({ type: 'like', userId: currentUserId, nickname: currentUserName, count: 50 });
    }

    function testGift(giftName, diamonds) {
      sendInject({
        type: 'gift',
        userId: currentUserId,
        nickname: currentUserName,
        giftName: giftName,
        giftId: 'gift_' + diamonds,
        diamonds: diamonds,
        count: 1,
        repeatEnd: true
      });
    }

    async function saveConfig() {
      const apiKey = document.getElementById('cfg-apikey').value.trim();
      const sessionId = document.getElementById('cfg-session').value.trim();
      const adminPassword = document.getElementById('cfg-adminpw').value;
      const autoConnect = document.getElementById('cfg-auto').checked;
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, sessionId, autoConnect, adminPassword })
      });
      const data = await res.json();
      document.getElementById('cfg-apikey').value = '';
      document.getElementById('cfg-session').value = '';
      document.getElementById('cfg-adminpw').value = '';
      alert(data.message || data.error);
      loadConfig();
    }

    async function loadConfig() {
      try {
        const res = await fetch('/api/config');
        const c = await res.json();
        document.getElementById('cfg-auto').checked = !!c.autoConnect;
        document.getElementById('cfg-hint').textContent =
          'API Key: ' + (c.hasApiKey ? 'đã có' : 'chưa có') + ' • Session: ' + (c.hasSession ? 'đã có' : 'chưa có') + ' • Mật khẩu admin: ' + (c.hasAdminPassword ? 'đã đặt' : 'chưa đặt');
        if (c.username && !document.getElementById('tt-user').value) {
          document.getElementById('tt-user').value = '@' + c.username;
        }
      } catch (e) {}
    }

    async function loadModeration(full) {
      try {
        const m = await (await fetch('/api/moderation')).json();
        if (full) {
          document.getElementById('mod-enabled').checked = !!m.enabled;
          document.getElementById('mod-links').checked = !!m.blockLinks;
          document.getElementById('mod-maxlen').value = m.maxChatLength;
          document.getElementById('mod-cooldown').value = Math.round(m.perUserCooldownMs / 1000);
          document.getElementById('mod-rate').value = m.maxChatsPerSecond;
          document.getElementById('mod-words').value = (m.bannedWords || []).join(String.fromCharCode(10));
        }
        const st = m.stats || {};
        document.getElementById('mod-stats').textContent =
          'Cho qua: ' + st.passed + ' • Chặn từ cấm: ' + st.bannedWord + ' • Chặn link/SĐT: ' + st.link + ' • Chặn spam: ' + st.spam;
      } catch (e) {}
    }

    async function saveModeration() {
      const words = document.getElementById('mod-words').value
        .split(String.fromCharCode(10)).flatMap(function (x) { return x.split(','); })
        .map(function (x) { return x.trim(); }).filter(Boolean);
      const body = {
        enabled: document.getElementById('mod-enabled').checked,
        blockLinks: document.getElementById('mod-links').checked,
        maxChatLength: Number(document.getElementById('mod-maxlen').value),
        perUserCooldownMs: Number(document.getElementById('mod-cooldown').value) * 1000,
        maxChatsPerSecond: Number(document.getElementById('mod-rate').value),
        bannedWords: words
      };
      const res = await fetch('/api/moderation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      alert(data.message || data.error);
      loadModeration(true);
    }

    async function loadLeaderboard() {
      try {
        const d = await (await fetch('/api/leaderboard?limit=10')).json();
        const box = document.getElementById('lb-rows');
        box.textContent = '';
        document.getElementById('lb-total').textContent = d.total + ' người đã có điểm';
        if (!d.rows.length) {
          box.textContent = 'Chưa có dữ liệu. Điểm xuất hiện khi khán giả thật tặng quà, thả tim hoặc bình luận.';
          return;
        }
        for (const r of d.rows) {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex; justify-content:space-between; gap:12px; padding:6px 0; border-bottom:1px solid #3a281f;';
          const left = document.createElement('span');
          left.textContent = r.rank + '. ' + r.name;
          const right = document.createElement('span');
          right.textContent = r.points.toLocaleString('vi-VN') + ' điểm';
          row.append(left, right);
          box.append(row);
        }
      } catch (e) {}
    }

    async function resetMerit() {
      if (confirm('Xoá toàn bộ điểm công đức? Không thể hoàn tác.')) {
        await fetch('/api/merit/reset', { method: 'POST' });
        loadLeaderboard();
      }
    }

    async function connectLive() {
      const user = document.getElementById('tt-user').value;
      if (!user) return alert("Vui lòng nhập username TikTok");
      await fetch('/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user })
      });
      pollStatus();
    }

    async function disconnectLive() {
      await fetch('/api/disconnect', { method: 'POST' });
      pollStatus();
    }

    async function pollStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        const badge = document.getElementById('status-badge');
        const hint = document.getElementById('status-hint');

        if (data.username && !document.getElementById('tt-user').value) {
          document.getElementById('tt-user').value = '@' + data.username;
        }

        if (data.status === 'connected') {
          badge.textContent = '🟢 ĐANG TRỰC TIẾP (Room: ' + (data.roomId || 'OK') + ') • ' + data.clients + ' màn hình Game';
          badge.className = 'status-badge badge-connected';
          hint.textContent = '✅ Đã kết nối với @' + data.username + '! Bình luận, tặng sen và vái lạy đang truyền về Chùa Online theo thời gian thực.';
          hint.style.color = '#72f58e';
        } else if (data.status === 'connecting') {
          badge.textContent = '🟡 ĐANG KẾT NỐI (@' + (data.username || '...') + ')...';
          badge.className = 'status-badge badge-connecting';
          hint.textContent = '⏳ Đang khởi tạo kết nối trực tiếp đến TikTok Live...';
          hint.style.color = '#ffe3a0';
        } else if (data.status === 'offline') {
          badge.textContent = '🟠 STREAMER CHƯA LÊN SÓNG (@' + data.username + ')';
          badge.className = 'status-badge badge-connecting';
          hint.textContent = '📡 Kênh hiện chưa bật Live. Hệ thống đang tự động canh và sẽ kết nối NGAY LẬP TỨC khi streamer bấm phát sóng!';
          hint.style.color = '#ffba6a';
        } else if (data.status === 'streamEnd') {
          badge.textContent = '⚪ PHIÊN LIVE ĐÃ KẾT THÚC';
          badge.className = 'status-badge badge-disconnected';
          hint.textContent = 'Live đã dừng phát sóng.';
          hint.style.color = '#c7a892';
        } else if (data.status.startsWith('error')) {
          badge.textContent = '🔴 LỖI KẾT NỐI: ' + (data.lastError || data.status);
          badge.className = 'status-badge badge-disconnected';
          hint.textContent = 'Đang tự động thử kết nối lại...';
          hint.style.color = '#ff8888';
        } else {
          badge.textContent = '⚪ ĐÃ NGẮT KẾT NỐI';
          badge.className = 'status-badge badge-disconnected';
          hint.textContent = 'Hãy nhập tên TikTok và bấm Kết Nối Ngay.';
          hint.style.color = '#c7a892';
        }
      } catch(e) {}
    }
    setInterval(pollStatus, 2000);
    pollStatus();
    loadConfig();
    loadModeration(true);
    loadLeaderboard();
    setInterval(function () { loadModeration(false); loadLeaderboard(); }, 5000);
  </script>
</body>
</html>
  `);
});

const server = app.listen(HTTP_PORT, HOST, () => {
  console.log(`\n======================================================`);
  console.log(`🏯 CHÙA ONLINE SERVER ĐÃ KHỞI CHẠY`);
  console.log(`- Màn hình Game:     http://localhost:${HTTP_PORT}/index.html?demo=1&relay=8080&mode=hanh-le`);
  console.log(`- Bảng Điều Khiển:   http://localhost:${HTTP_PORT}/admin`);
  console.log(`- Cổng WebSocket:    ws://localhost:${WS_PORT}`);
  console.log(`======================================================\n`);

  // Tự động kết nối kênh đã lưu
  if (settings.autoConnect && settings.username) {
    console.log(`[AUTO] Tự động kết nối kênh đã lưu: @${settings.username}`);
    connectToTikTok(settings.username);
  } else {
    console.log("[AUTO] Chưa có kênh đã lưu hoặc đã tắt tự động. Vào /admin để nhập tên TikTok.");
  }
});

server.on("error", (err) => {
  console.error(`[SERVER] Lỗi mở cổng ${HTTP_PORT}: ${err.message}`);
  process.exit(1);
});

}

initApp();
