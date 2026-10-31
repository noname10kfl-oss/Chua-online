const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// Thiết lập mã hóa UTF-8 cho console
if (process.platform === "win32") {
  try {
    execSync("chcp 65001", { stdio: "ignore" });
  } catch (e) {}
}

// Kiểm tra xem file có bị chạy trực tiếp từ trong file nén không
if (!fs.existsSync(path.join(__dirname, "server.js"))) {
  console.log("\n===================================================================");
  console.log("❌ LỖI: BẠN ĐANG MỞ FILE TRỰC TIẾP TRONG FILE NÉN ZIP!");
  console.log("===================================================================");
  console.log("Vui lòng giải nén toàn bộ thư mục trước khi chạy:");
  console.log("1. Chuột phải vào file ChuaOnline_Full_1Click.zip");
  console.log("2. Chọn 'Extract All...' (hoặc 'Giải nén ở đây')");
  console.log("3. Mở thư mục vừa giải nén ra và bấm lại file CHAY_NGAY.bat");
  console.log("===================================================================\n");
  process.exit(1);
}

const CONFIG_FILE = path.join(__dirname, "connector_config.json");
const UPDATE_STAMP = path.join(__dirname, ".tiktoklive_update");
const UPDATE_EVERY_MS = 7 * 24 * 60 * 60 * 1000; // 7 ngày

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch (e) {
    return {};
  }
}

// Chỉ giải phóng tiến trình đang LẮNG NGHE (LISTENING) ở cổng 3000/8080 trên máy này.
// (Bản cũ khớp cả cổng đích của kết nối ra ngoài nên có thể tắt nhầm trình duyệt/ứng dụng khác.)
function freePorts() {
  console.log("[1/3] Đang làm sạch cổng mạng (3000, 8080)...");
  if (process.platform !== "win32") return;
  try {
    const output = execSync("netstat -aon -p TCP", { encoding: "utf-8" });
    const pids = new Set();
    for (const line of output.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5 || parts[0] !== "TCP") continue;
      const local = parts[1];
      const state = parts[3];
      const pid = parts[4];
      if (state !== "LISTENING") continue;
      if (!/:(3000|8080)$/.test(local)) continue;
      if (pid && /^\d+$/.test(pid) && pid !== "0" && pid !== String(process.pid)) pids.add(pid);
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
      } catch (e) {}
    }
  } catch (e) {}
}

function canRun(cmd, args) {
  try {
    execSync(`"${cmd}" ${args}`, { stdio: "ignore" });
    return true;
  } catch (e) {
    return false;
  }
}

function checkPython() {
  console.log("[2/3] Đang kiểm tra hệ thống đọc Live TikTok...");
  let pythonCmd = null;

  const candidates = ["py", "python", "python3"];
  for (const v of ["Python314", "Python313", "Python312", "Python311", "Python310"]) {
    candidates.push(`C:\\${v}\\python.exe`);
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "Python", v, "python.exe"));
    }
  }

  for (const cmd of candidates) {
    if (canRun(cmd, "--version")) {
      pythonCmd = cmd;
      break;
    }
  }

  if (!pythonCmd) {
    console.log("    -> Lưu ý: Máy chưa cài Python. Để đọc Live TikTok thật, hãy cài Python tại python.org");
    console.log("       (nhớ tích chọn 'Add python.exe to PATH') rồi chạy lại.");
    return;
  }

  process.env.PYTHON_CMD = pythonCmd; // server.js dùng đúng lệnh này để chạy bridge

  const hasLibs = canRun(pythonCmd, '-c "import TikTokLive, websockets"');
  if (!hasLibs) {
    console.log("    -> Đang tự động nạp thư viện đọc Live TikTok (chỉ tải lần đầu)...");
    try {
      execSync(`"${pythonCmd}" -m pip install --upgrade TikTokLive websockets`, { stdio: "inherit" });
    } catch (err) {
      console.log("    -> Không thể tự tải thư viện qua pip. Hãy chạy tay lệnh:");
      console.log(`       "${pythonCmd}" -m pip install --upgrade TikTokLive websockets`);
    }
    touchStamp();
    return;
  }

  // TikTok hay đổi giao thức -> mỗi 7 ngày tự cập nhật thư viện (bỏ qua nếu mất mạng)
  let stale = true;
  try {
    stale = Date.now() - fs.statSync(UPDATE_STAMP).mtimeMs > UPDATE_EVERY_MS;
  } catch (e) {}
  if (stale) {
    console.log("    -> Đang kiểm tra bản cập nhật thư viện TikTokLive (mỗi 7 ngày 1 lần)...");
    try {
      execSync(`"${pythonCmd}" -m pip install --upgrade TikTokLive websockets`, { stdio: "inherit", timeout: 120000 });
    } catch (err) {
      console.log("    -> Không cập nhật được (có thể mất mạng). Dùng bản hiện tại.");
    }
    touchStamp();
  }
}

function touchStamp() {
  try {
    fs.writeFileSync(UPDATE_STAMP, String(Date.now()));
  } catch (e) {}
}

function openBrowser(hasSavedChannel) {
  console.log("[3/3] Đang mở giao diện...");
  setTimeout(() => {
    const open = (url) => {
      try {
        if (process.platform === "win32") {
          // Chú ý: tham số "" là tiêu đề cửa sổ, nếu thiếu thì URL trong ngoặc kép bị hiểu nhầm là tiêu đề
          execSync(`start "" "${url}"`, { stdio: "ignore", shell: true });
        } else {
          execSync(`xdg-open "${url}"`, { stdio: "ignore", shell: true });
        }
      } catch (e) {}
    };
    // Chưa có kênh đã lưu thì mở trang điều khiển để nhập tên TikTok
    if (!hasSavedChannel) open("http://localhost:3000/admin");
    open("http://localhost:3000/index.html?demo=1&relay=8080&mode=hanh-le");
  }, 2000);
}

function startSystem() {
  const settings = readSettings();
  const hasSavedChannel = !!(settings.username && settings.autoConnect !== false);

  freePorts();
  checkPython();
  openBrowser(hasSavedChannel);

  console.log("\n===================================================================");
  console.log("  🏯 CHÙA ONLINE ĐÃ SẴN SÀNG HOẠT ĐỘNG!");
  console.log("  -----------------------------------------------------------------");
  console.log("  • Bảng điều khiển: http://localhost:3000/admin");
  console.log("  • Màn hình Game:   http://localhost:3000/index.html?demo=1&relay=8080&mode=hanh-le");
  if (hasSavedChannel) {
    console.log(`  • Tự động kết nối kênh đã lưu: @${settings.username}`);
  }
  console.log("  (HÃY ĐỂ CỬA SỔ NÀY MỞ TRONG SUỐT QUÁ TRÌNH LIVESTREAM)");
  console.log("===================================================================\n");

  require("./server.js");
}

startSystem();
