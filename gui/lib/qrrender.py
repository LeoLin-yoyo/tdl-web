#!/usr/bin/env python3
"""把 tdl 小方块字符矩阵渲染成 PNG。

输入：stdin 传 JSON {"text": "...", "cell": 8}
输出：stdout 打印 JSON {"png": "<base64>"} 或 {"error": "..."}

字符语义（来自 skip2/go-qrcode 的 ToSmallString(false)，注意是反色的）：
  ' '  上下都黑
  '█'  上下都白
  '▄'  上黑下白
  '▀'  上白下黑
每个字符承载「上下两个像素格」。
"""
import sys
import json
import base64
import io
from PIL import Image

FULL = '\u2588'    # 上下都白
UPPER = '\u2580'   # 上白下黑
LOWER = '\u2584'   # 上黑下白


def main():
    data = json.load(sys.stdin)
    text = data.get('text', '')
    cell = int(data.get('cell', 8))

    n = chr(10)
    lines = text.split(n)
    block_chars = set(' ' + FULL + UPPER + LOWER + '\u2592')
    lines = [l for l in lines if l and set(l) <= block_chars and len(l.strip()) >= 8]
    if not lines:
        print(json.dumps({'error': 'empty'}))
        return

    cols = max(len(l) for l in lines)
    rows = len(lines)
    W = cols * cell
    H = rows * cell * 2

    img = Image.new('L', (W, H), 255)   # 255 = 白
    px = img.load()

    def fill_black(x0, y0, x1, y1):
        for yy in range(y0, y1):
            for xx in range(x0, x1):
                px[xx, yy] = 0

    for r, line in enumerate(lines):
        for c, ch in enumerate(line):
            x0 = c * cell
            y_top = r * cell * 2
            y_mid = y_top + cell
            y_bot = y_top + cell * 2
            if ch == LOWER:      # 上黑下白 → 填上半
                fill_black(x0, y_top, x0 + cell, y_mid)
            elif ch == UPPER:    # 上白下黑 → 填下半
                fill_black(x0, y_mid, x0 + cell, y_bot)
            elif ch == ' ':      # 上下都黑
                fill_black(x0, y_top, x0 + cell, y_bot)
            # FULL（上下都白）保持白

    buf = io.BytesIO()
    img.save(buf, format='PNG', optimize=True)
    print(json.dumps({'png': base64.b64encode(buf.getvalue()).decode()}))


if __name__ == '__main__':
    main()
