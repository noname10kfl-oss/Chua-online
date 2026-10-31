const REQUIRED_KEY = "Hao123";

function checkAuth(callback) {
  if (process.env.APP_KEY === REQUIRED_KEY || process.argv.includes(`--key=${REQUIRED_KEY}`)) {
    return callback();
  }
  const readline = require("readline").createInterface({
    input: process.stdin,
    output: process.stdout
  });
  console.log("\n======================================================");
  console.log("🔒 HỆ THỐNG BẢO VỆ BẢN QUYỀN CHÙA ONLINE");
  console.log("======================================================");
  readline.question("👉 Nhập Key kích hoạt để vào tool: ", (inputKey) => {
    readline.close();
    if (inputKey.trim() === REQUIRED_KEY) {
      console.log("✅ Key chính xác! Đang mở tool...\n");
      callback();
    } else {
      console.error("\n❌ SAI MÃ KEY! Bạn không có quyền truy cập vào tool.\n");
      process.exit(1);
    }
  });
}

checkAuth(() => {
  initApp();
});

function initApp() {
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const https = require("https");
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");
const { WebcastPushConnection, SignConfig } = require("tiktok-live-connector");

const HTTP_PORT = 3000;
const WS_PORT = 8080;

// Cấu hình EulerStream API Key / Session
let userApiKey = process.env.EULER_API_KEY || "";
let userSessionId = process.env.TIKTOK_SESSION_ID || "";

const CONFIG_FILE = path.join(__dirname, "connector_config.json");
if (fs.existsSync(CONFIG_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    if (saved.apiKey) userApiKey = saved.apiKey;
    if (saved.sessionId) userSessionId = saved.sessionId;
  } catch(e) {}
}

if (userApiKey) {
  SignConfig.apiKey = userApiKey;
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
app.use(express.json());
app.use(express.static(path.join(__dirname, "chua_clone")));

// ─── TTS Audio Proxy & Cache ──────────────────────────────────────
const pendingTTS = new Map();

app.get("/api/giong-doc", (req, res) => {
  const text = (req.query.chu || "").trim();
  const giong = req.query.giong || "0";
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
const wss = new WebSocketServer({ port: WS_PORT });
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
      if (data.source === "python_bridge") {
        bridgeSocket = ws;
        if (data.type === "tiktok_status") {
          connectionStatus = data.status;
          if (data.roomId) currentRoomId = data.roomId;
          if (data.error) lastError = data.error;
          console.log(`[TikTok Bridge] @${data.username || currentUsername}: ${data.status} ${data.roomId ? '(Room: ' + data.roomId + ')' : ''}`);
        } else {
          // Bắn trực tiếp các sự kiện viewer, chat, gift, like, social tới tất cả màn hình Game
          broadcast(data);
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
function connectToTikTok(username) {
  disconnectTikTok();
  currentUsername = username.replace(/^@/, "").trim().toLowerCase();
  if (!currentUsername) return;

  connectionStatus = "connecting";
  currentRoomId = "";
  lastError = "";
  console.log(`[TikTok] Bắt đầu kết nối kênh @${currentUsername} qua Python Bridge...`);

  const pythonBin = findPythonBinary();
  const bridgeScript = path.join(__dirname, "tiktok_bridge.py");

  try {
    bridgeProcess = spawn(pythonBin, [bridgeScript, currentUsername, "--ws", `ws://127.0.0.1:${WS_PORT}`], {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8" }
    });

    bridgeProcess.on("error", (err) => {
      console.error(`[TikTok Bridge] Lỗi tiến trình Python: ${err.message}`);
      connectionStatus = "error";
      lastError = "Chưa phát hiện Python trên máy để đọc Live. Vui lòng cài Python (python.org) và tích chọn Add to PATH.";
    });

    bridgeProcess.stdout.on("data", (chunk) => {
      const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
      for (const l of lines) {
        console.log(l);
      }
    });

    bridgeProcess.stderr.on("data", (chunk) => {
      const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
      for (const l of lines) {
        console.error(`[Bridge Err] ${l}`);
      }
    });

    bridgeProcess.on("close", (code) => {
      console.log(`[Bridge] Tiến trình kết nối TikTok dừng (code ${code})`);
      if (connectionStatus === "connecting" || connectionStatus === "connected") {
        connectionStatus = "disconnected";
      }
    });
  } catch (err) {
    console.error(`[TikTok Bridge] Không thể tạo tiến trình: ${err.message}`);
    connectionStatus = "error";
    lastError = err.message;
  }
}

function disconnectTikTok() {
  if (bridgeProcess) {
    try {
      bridgeProcess.kill();
    } catch(e) {}
    bridgeProcess = null;
  }
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

app.post("/api/config", (req, res) => {
  const { apiKey, sessionId } = req.body;
  userApiKey = (apiKey || "").trim();
  userSessionId = (sessionId || "").trim();

  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ apiKey: userApiKey, sessionId: userSessionId }, null, 2));
  if (userApiKey) {
    SignConfig.apiKey = userApiKey;
  }
  console.log(`[CONFIG] Đã lưu cấu hình kết nối (ApiKey: ${userApiKey ? "ĐÃ CÓ" : "CHƯA CÓ"}, Session: ${userSessionId ? "ĐÃ CÓ" : "CHƯA CÓ"})`);
  res.json({ success: true, message: "Đã lưu cấu hình thành công" });
});

app.post("/api/connect", (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: "Thiếu username TikTok" });
  connectToTikTok(username);
  res.json({ success: true, message: `Bắt đầu kết nối @${username}` });
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
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, sessionId })
      });
      const data = await res.json();
      alert(data.message);
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
  </script>
</body>
</html>
  `);
});

const server = app.listen(HTTP_PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🏯 CHÙA ONLINE SERVER ĐÃ KHỞI CHẠY`);
  console.log(`- Màn hình Game:     http://localhost:${HTTP_PORT}/index.html?demo=1&relay=8080&mode=hanh-le`);
  console.log(`- Bảng Điều Khiển:   http://localhost:${HTTP_PORT}/admin`);
  console.log(`- Cổng WebSocket:    ws://localhost:${WS_PORT}`);
  console.log(`======================================================\n`);
});
}


