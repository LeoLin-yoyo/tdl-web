// 二维码渲染：把 tdl 输出的方块字符矩阵渲染成 PNG
//
// 为什么需要它：
//   tdl login --type qr 输出的是用 █ ▀ ▄ 等方块字符拼成的"字符画"，
//   前端原本直接用 <pre> + 等宽字体显示。但方块字符能否正确显示，
//   取决于**客户端浏览器**装了哪个等宽字体 —— 而字体栈里排前面的
//   Cascadia Code / Consolas / JetBrains Mono 在 Linux 和手机上普遍缺失，
//   回退到通用 monospace 后这些方块字符往往不再等宽，矩阵错位 → 二维码扫不出来。
//
//   本模块在**服务端**把字符画按"整格填色"的方式渲染成 PNG，
//   彻底摆脱客户端字体依赖：任何浏览器、任何手机都能正确显示。
//
// 渲染方式说明（为什么不用字体画字）：
//   直接画字符会在格与格之间留下亚像素灰缝，二维码的模块边界会糊。
//   因此改为解析方块字符的**像素语义**，逐格填色 —— 无损、无缝隙：
//     █ (U+2588) 整格黑     ▀ (U+2580) 上半格黑
//     ▄ (U+2584) 下半格黑   ▒ (U+2592) 中灰（tdl 实际不用，兼容处理）
//   这样一个字符 = 2×1 的像素格，与 tdl 的编码方式一致。

const { execFile } = require('node:child_process');

const RENDER_SCRIPT = `
import sys, json, base64, io
from PIL import Image

data = json.load(sys.stdin)
text = data.get('text', '')
cell = int(data.get('cell', 8))   # 每个"像素格"的边长

lines = text.split('\\n')
# 去掉首尾空行
while lines and not lines[0].strip():
    lines.pop(0)
while lines and not lines[-1].strip():
    lines.pop()
if not lines:
    print(json.dumps({'error': 'empty'}))
    sys.exit(0)

cols = max(len(l) for l in lines)
rows = len(lines)

# 每个字符纵向代表 2 个像素格
W = cols * cell
H = rows * cell * 2

img = Image.new('L', (W, H), 255)   # 灰度，白底
px = img.load()

FULL  = '\\u2588'   # 整格
UPPER = '\\u2580'   # 上半格
LOWER = '\\u2584'   # 下半格
MED   = '\\u2592'   # 中灰
SPACE = ' '

def fill(x0, y0, x1, y1):
    for yy in range(y0, y1):
        for xx in range(x0, x1):
            px[xx, yy] = 0

for r, line in enumerate(lines):
    for c, chr_ in enumerate(line):
        x0 = c * cell
        y_mid = r * cell * 2 + cell
        y_top = r * cell * 2
        y_bot = r * cell * 2 + cell * 2
        if chr_ == FULL:
            fill(x0, y_top, x0 + cell, y_bot)
        elif chr_ == UPPER:
            fill(x0, y_top, x0 + cell, y_mid)
        elif chr_ == LOWER:
            fill(x0, y_mid, x0 + cell, y_bot)
        elif chr_ == MED:
            # 中灰：用点阵表示，用于少量场景
            for yy in range(y_top, y_bot, 2):
                for xx in range(x0, x0 + cell, 2):
                    px[xx, yy] = 0
        # 空格与其它字符视为白

# 加白边（静区），提升识别率
border = cell * 2
out = Image.new('L', (W + border * 2, H + border * 2), 255)
out.paste(img, (border, border))

buf = io.BytesIO()
out.save(buf, format='PNG', optimize=True)
print(json.dumps({'png': base64.b64encode(buf.getvalue()).decode()}))
`;

/**
 * 把 tdl 的方块字符矩阵渲染为 PNG（base64）
 * @param {string} text  方块字符矩阵
 * @param {number} cell  每像素格边长（默认 8）
 * @returns {Promise<string|null>}
 */
function renderQrPng(text, cell = 8) {
  return new Promise((resolve) => {
    if (!text || typeof text !== 'string') return resolve(null);
    let child;
    try {
      child = execFile('python3', ['-c', RENDER_SCRIPT], { timeout: 15000 }, (err, stdout) => {
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
