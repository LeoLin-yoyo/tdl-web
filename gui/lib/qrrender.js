// 二维码渲染：把 tdl 输出的小方块字符矩阵渲染成 PNG
//
// ── 为什么需要它 ────────────────────────────────────────────────
//   tdl login --type qr 用 github.com/skip2/go-qrcode 的
//   `qr.ToSmallString(false)` 把二维码打成"字符画"输出到终端。
//   前端原本用 <pre> + 等宽字体显示，但方块字符是否等宽取决于
//   **客户端浏览器**装了哪个字体；字体缺失时矩阵错位 → 扫不出来。
//   本模块在**服务端**把字符画还原成像素矩阵再渲染成 PNG，
//   彻底摆脱客户端字体依赖。
//
// ── 关键：skip2 的输出是「反色」的 ──────────────────────────────
//   库源码 qrcode.go 的 ToSmallString(inverseColor bool)：
//     bitmap[y][x] 为 true 表示该像素是黑的（见 Bitmap() 文档）。
//     循环里判断 `if bits[y][x] != inverseColor` 才走 if 分支。
//   传入 inverseColor=false 时：bits=true(黑) != false 成立 → 走 if ；
//   bits=false(白) 不成立 → 走 else。于是：
//     上下相同 & 黑  → ' '  （空格）
//     上下相同 & 白  → '█'
//     上黑下白       → '▄'
//     上白下黑       → '▀'
//   **即：'█' 表示白、空格表示黑，整幅图是反色的。**
//   照着"█=黑"去画会把二维码黑白颠倒，手机完全识别不了 —— 这正是
//   之前「扫码毫无反应」的根因。
//
//   （另外 Bitmap() 默认带 4 模块静区，所以 45 列 = 4 + 37 + 4，
//     即版本 5 的二维码，渲染时不必再额外加静区。）
//
// ── 实现说明 ──────────────────────────────────────────────────
//   逐字节还原的实际渲染放在同目录的 qrrender.py 里（独立文件），
//   避免把 Python 脚本内嵌成 JS 模板字符串时的转义陷阱
//   （`\\n` 之类容易出错，曾导致整幅图渲染不出来）。
//   本模块只负责: 把矩阵喂给 python3，拿回 base64 PNG。

const { execFile } = require('node:child_process');
const path = require('node:path');

const PY_SCRIPT = path.join(__dirname, 'qrrender.py');

/**
 * 把 tdl 的小方块字符矩阵渲染为 PNG（base64）
 * @param {string} text  方块字符矩阵
 * @param {number} cell  每像素格边长（默认 8）
 * @returns {Promise<string|null>}
 */
function renderQrPng(text, cell = 8) {
  return new Promise((resolve) => {
    if (!text || typeof text !== 'string') return resolve(null);
    let child;
    try {
      child = execFile('python3', [PY_SCRIPT], { timeout: 15000 }, (err, stdout) => {
        if (err) return resolve(null);
        try {
          const out = JSON.parse(stdout);
          resolve(out.png || null);
        } catch {
          resolve(null);
        }
      });
    } catch {
      return resolve(null);
    }
    try {
      child.stdin.write(JSON.stringify({ text, cell }));
      child.stdin.end();
    } catch {
      resolve(null);
    }
  });
}

module.exports = { renderQrPng };
