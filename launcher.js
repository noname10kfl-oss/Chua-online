const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");
const readline = require("readline");

// Thiết lập mã hóa UTF-8 cho console
if (process.platform === "win32") {
  try {
    execSync("chcp 65001", { stdio: "ignore" });
  } catch(e) {}
}

const REQUIRED_KEY = "Hao123";

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

function promptAuth() {
  console.clear();
  console.log("===================================================================");
  console.log("             🏯 HỆ THỐNG LIVESTREAM CHÙA ONLINE TỰ ĐỘNG 🏯");
  console.log("===================================================================");
  console.log("");
  console.log("  [!] Phần mềm yêu cầu Mã Kích Hoạt để sử dụng.");
  console.log("  [!] Vui lòng nhập đúng chữ hoa / chữ thường (Key: Hao123).");
  console.log("");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.question("👉 Nhập Key Bản Quyền: ", (inputKey) => {
    rl.close();
    if (inputKey.trim() === REQUIRED_KEY) {
      console.clear();
      console.log("===================================================================");
      console.log("             ✅ XÁC THỰC THÀNH CÔNG - CHÀO MỪNG BẠN!");
      console.log("===================================================================\n");
      startSystem();
    } else {
      console.log("\n❌ SAI MÃ KEY! BẠN KHÔNG CÓ QUYỀN TRUY CẬP VÀO TOOL NÀY.");
      console.log("Vui lòng kiểm tra lại (chú ý chữ H viết hoa).\n");
      const waitRl = readline.createInterface({ input: process.stdin, output: process.stdout });
      waitRl.question("Bấm Enter để thử lại...", () => {
        waitRl.close();
        promptAuth();
      });
    }
  });
}

function freePorts() {
  console.log("[1/3] Đang làm sạch cổng mạng (3000, 8080)...");
  try {
    const output = execSync("netstat -aon", { encoding: "utf-8" });
    const pids = new Set();
    for (const line of output.split(/\r?\n/)) {
      if (line.includes(":3000 ") || line.includes(":8080 ")) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && !isNaN(pid) && pid !== "0" && pid !== String(process.pid)) {
          pids.add(pid);
        }
      }
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
      } catch(e) {}
    }
  } catch(e) {}
}

function checkPython() {
  console.log("[2/3] Đang kiểm tra hệ thống đọc Live TikTok...");
  let pythonCmd = null;

  const candidates = [
    "python",
    "py",
    "C:\\Python314\\python.exe",
    "C:\\Python313\\python.exe",
    "C:\\Python312\\python.exe"
  ];
  if (process.env.LOCALAPPDATA) {
    for (const ver of ["Python314", "Python313", "Python312", "Python311", "Python310"]) {
      candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "Python", ver, "python.exe"));
    }
  }

  for (const cmd of candidates) {
    try {
      execSync(`"${cmd}" --version`, { stdio: "ignore" });
      pythonCmd = cmd;
      break;
    } catch(e) {}
  }

  if (pythonCmd) {
    try {
      execSync(`"${pythonCmd}" -c "import TikTokLive, websockets"`, { stdio: "ignore" });
    } catch(e) {
      console.log("    -> Đang tự động nạp thư viện đọc Live TikTok (chỉ tải lần đầu)...");
      try {
        execSync(`"${pythonCmd}" -m pip install TikTokLive websockets`, { stdio: "inherit" });
      } catch(err) {
        console.log("    -> Không thể tự tải thư viện TikTokLive qua pip. Nếu cần đọc Live thật hãy chạy: pip install TikTokLive websockets");
      }
    }
  } else {
    console.log("    -> Lưu ý: Máy chưa cài Python. Khi cần đọc Live TikTok thật, vui lòng cài Python tại python.org.");
  }
}

function openBrowser() {
  console.log("[3/3] Đang mở giao diện Game và Bảng Điều Khiển...");
  setTimeout(() => {
    try {
      const startCmd = process.platform === "win32" ? "start" : "xdg-open";
      execSync(`${startCmd} http://localhost:3000/admin`, { stdio: "ignore", shell: true });
      execSync(`${startCmd} "http://localhost:3000/index.html?demo=1&relay=8080&mode=hanh-le"`, { stdio: "ignore", shell: true });
    } catch(e) {}
  }, 2000);
}

function startSystem() {
  freePorts();
  checkPython();
  openBrowser();

  console.log("\n===================================================================");
  console.log("  🏯 CHÙA ONLINE ĐÃ SẴN SÀNG HOẠT ĐỘNG!");
  console.log("  -----------------------------------------------------------------");
  console.log("  • Bảng điều khiển: http://localhost:3000/admin");
  console.log("  • Màn hình Game:   http://localhost:3000/index.html?demo=1&relay=8080&mode=hanh-le");
  console.log("  (HÃY ĐỂ CỬA SỔ NÀY MỞ TRONG SUỐT QUÁ TRÌNH LIVESTREAM)");
  console.log("===================================================================\n");

  process.env.APP_KEY = REQUIRED_KEY;
  require("./server.js");
}

promptAuth();
