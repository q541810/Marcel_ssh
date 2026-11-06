"""玛瑟尔（吉祥物）像素动画的源头：零件化绘制 + 9 个状态的帧编排。

前端只读本脚本生成的 `src/lib/mascot/marcelFrames.json`，**别手改那份 JSON**——改造型 / 改动作都改这里，
然后重跑：

    python scripts/mascot/marcel_frames.py                 # 只重新生成前端数据
    python scripts/mascot/marcel_frames.py --preview DIR   # 另外导出帧表 PNG 和 GIF 供肉眼检查（需要 Pillow）

坐标约定：零件坐标沿用 48x48 的「人物坐标」；画到 64x64 画布时整体平移 (OX, OY)，
留出跳跃、气泡、爆米花飞散的空间。每个格子一个字符，字符 → 颜色见 PAL；
'O' 是主题外缘（前端按当前主题的强边框色画），'.' 透明。
"""
import argparse
import json
import math
import os

W, H = 64, 64          # 画布
OX, OY = 9, 13         # 人物坐标 → 画布坐标的平移

PAL = {
    'K': (17, 17, 17),      # 描边
    'V': (26, 26, 30),      # 面罩
    'R': (52, 52, 55),      # 遥控器
    'D': (78, 78, 80),      # 深灰
    'G': (112, 112, 114),   # 身体
    'L': (146, 146, 148),   # 亮灰
    'S': (88, 88, 90),      # 缝线
    'P': (192, 192, 194),   # 浅灰
    'W': (240, 240, 240),   # 白
    # 特效色
    'y': (255, 205, 60),    # 琥珀黄：感叹泡泡、耳尖闪光
    'r': (232, 72, 77),     # 红：感叹号、断线斜杠、遥控器红灯
    'g': (61, 220, 132),    # 绿：遥控器绿灯、信号波、对勾
    'h': (36, 168, 98),     # 深绿：对勾徽章底
    'b': (122, 167, 255),   # 蓝：问号泡泡、Zzz
    'c': (170, 222, 255),   # 浅蓝：鼻涕泡、汗滴
    'o': (251, 146, 60),    # 橙：命令符号
    'v': (167, 139, 250),   # 紫：命令符号
}
RIM_DARK = (82, 82, 91)     # 深色主题外缘（zinc-600）；浅色主题不画


class Grid:
    def __init__(self):
        self.g = [['.'] * W for _ in range(H)]

    def put(self, x, y, c):
        x, y = int(x), int(y)
        if 0 <= x < W and 0 <= y < H and c not in ' .':
            self.g[y][x] = c

    def get(self, x, y):
        if 0 <= x < W and 0 <= y < H:
            return self.g[y][x]
        return '.'

    def row(self, x, y, s):
        for i, c in enumerate(s):
            self.put(x + i, y, c)

    def span(self, y, x0, x1, c):
        for x in range(x0, x1 + 1):
            self.put(x, y, c)

    def bitmap(self, x0, y0, rows, color=None):
        for dy, r in enumerate(rows):
            for dx, ch in enumerate(r):
                if ch not in ' .':
                    self.put(x0 + dx, y0 + dy, color if (color and ch == 'X') else ch)

    def ring_pass(self, mark):
        """在所有非空格外面描一圈 mark（4 邻域）。"""
        filled = [[self.g[y][x] != '.' for x in range(W)] for y in range(H)]
        for y in range(H):
            for x in range(W):
                if filled[y][x]:
                    continue
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < W and 0 <= ny < H and filled[ny][nx]:
                        self.g[y][x] = mark
                        break

    def over(self, other):
        for y in range(H):
            for x in range(W):
                if other.g[y][x] != '.':
                    self.g[y][x] = other.g[y][x]


class Layer:
    """带偏移的画笔：零件用人物坐标画，自动加上 (OX+dx, OY+dy)。"""

    def __init__(self, grid, dx=0, dy=0):
        self.G, self.dx, self.dy = grid, OX + dx, OY + dy

    def put(self, x, y, c):
        self.G.put(x + self.dx, y + self.dy, c)

    def row(self, x, y, s):
        for i, c in enumerate(s):
            self.put(x + i, y, c)

    def span(self, y, x0, x1, c):
        for x in range(x0, x1 + 1):
            self.put(x, y, c)

    def bitmap(self, x0, y0, rows, color=None):
        for dy, r in enumerate(rows):
            for dx, ch in enumerate(r):
                if ch not in ' .':
                    self.put(x0 + dx, y0 + dy, color if (color and ch == 'X') else ch)


# ====================================================================
# 零件
# ====================================================================

def ear(L, base, angle, length=15.0, tip='P'):
    """耳朵：沿方向画一根胶囊。angle=0 竖直向上，正数往右（顺时针）。
    横截面从左到右：D 边 1 格、W 内条 3 格、D 外层 2~3 格；末端是带 × 的按钮。"""
    bx, by = base
    th = math.radians(angle)
    ax, ay = math.sin(th), -math.cos(th)      # 沿耳朵方向
    nx, ny = math.cos(th), math.sin(th)       # 垂直方向（指向耳朵右侧）
    hw = 3.5
    cap = length - hw
    bt = length - 3.6                          # 按钮中心
    for y in range(int(by - length - 5), int(by + 5)):
        for x in range(int(bx - length - 5), int(bx + length + 5)):
            px, py = x + .5 - bx, y + .5 - by
            t = px * ax + py * ay
            s = px * nx + py * ny
            if t < -3 or abs(s) > hw:
                continue
            if t > cap and (t - cap) ** 2 + s * s > hw * hw:
                continue
            d_btn = (t - bt) ** 2 / 5.0 + (s + .4) ** 2 / 4.0
            if (t - bt) ** 2 + (s + .4) ** 2 < 0.5:
                c = 'K'
            elif d_btn < 1:
                c = tip
            elif s < -2.4:
                c = 'D'
            elif s < 1.1 and t < bt - 2.0:
                c = 'W'
            else:
                c = 'D'
            L.put(x, y, c)


# 身体每行的左右边界（人物坐标）
BODY = {
    10: (31, 36), 11: (28, 39), 12: (25, 41), 13: (23, 42), 14: (22, 43),
    **{y: (20, 43) for y in range(15, 26)},
    26: (21, 43), 27: (15, 43), 28: (13, 43), 29: (12, 43), 30: (12, 43),
    **{y: (11, 43) for y in range(31, 41)},
    **{y: (10, 43) for y in range(41, 44)},
    44: (10, 42), 45: (11, 39), 46: (14, 34),
}
SPLIT = 27   # 这一行以上算「上半身」，会随呼吸 / 点头整体下沉


def body_upper(L):
    for y, (a, b) in BODY.items():
        if y < SPLIT:
            L.span(y, a, b, 'G')
            if y >= 13:
                L.put(b, y, 'D')
    L.row(29, 11, 'LLL')
    L.row(27, 12, 'LL')
    L.put(34, 10, 'S'); L.put(33, 11, 'S')


def body_lower(L):
    for y, (a, b) in BODY.items():
        if y >= SPLIT:
            L.span(y, a, b, 'G')
            if y <= 30:
                L.put(b, y, 'D')
    L.span(45, 12, 38, 'D')
    L.span(46, 15, 33, 'D')
    L.span(44, 11, 16, 'D')
    for (x, y) in [(15, 28), (14, 29), (14, 30), (13, 31), (13, 32), (13, 33), (13, 34),
                   (13, 35), (14, 36), (14, 37), (15, 38), (15, 39), (16, 40)]:
        L.put(x, y, 'D')
    for (x, y) in [(12, 31), (12, 32), (12, 33), (12, 34), (12, 35), (13, 36), (13, 37)]:
        L.put(x, y, 'L')
    for (x, y) in [(11, 41), (12, 41), (13, 41), (14, 42), (15, 42), (16, 42), (17, 43)]:
        L.put(x, y, 'K')
    # 拉链线
    for (x, y) in [(19, 30), (19, 31), (18, 32), (18, 33), (17, 34), (17, 35),
                   (17, 36), (17, 37), (18, 38), (18, 39), (19, 40), (19, 41)]:
        L.put(x, y, 'W')


VIS = {13: (26, 33), 14: (24, 35), 15: (23, 36), 16: (22, 36),
       **{y: (21, 36) for y in range(17, 23)}, 23: (22, 36), 24: (22, 35), 25: (24, 34)}


def face(L, eyes='open', ex=0, ey=0):
    for y, (a, b) in VIS.items():
        L.span(y, a, b, 'V')
    for x in range(25, 36, 2):
        L.put(x, 12, 'S')
    for y in range(14, 26, 2):
        L.put(38, y, 'S')
    for x in range(25, 37, 2):
        L.put(x, 27, 'S')
    EYES = {
        'open': ([".XX.", "X..X", "X..X", "X..X", "X..X", "X..X", ".XX."],
                 ["..XX..", ".X..X.", "X....X", "X....X", "X....X", ".X..X.", "..XX.."], 0),
        # 眯眼笑：只剩上半圈（倒 U）
        'happy': ([".XX.", "X..X", "X..X"], ["..XX..", ".X..X.", "X....X"], 2),
        # 闭眼：一条横线
        'closed': (["XXXX"], [".XXXX."], 4),
        # 难过：下半圈压扁、整体下移
        'sad': (["XXXX", "X..X", ".XX."], ["XXXXXX", "X....X", ".X..X.", "..XX.."], 3),
        # 瞪大：和 open 一样大，但更靠上一格（配合「看着你」）
        'squint': ([".XX.", "X..X", ".XX."], ["..XX..", "X....X", "..XX.."], 3),
    }
    l, r, oy = EYES[eyes]
    L.bitmap(22 + ex, 17 + ey + oy, l, 'W')
    L.bitmap(28 + ex, 17 + ey + oy, r, 'W')


# 胳膊 + 遥控器（0° 时的手绘位图；人物坐标原点在 (2,20)）
ARM0 = [
    ".RRRRRRRRRRRK.....",
    "DDDDDDDDDDDDDKGGGG",
    "RRllRRRRRRRRRKGGGGG",
    "RRRRRRRRRRRRRKGGGGG",
    "RRRRRRRRRRRRRKGGGGG",
    ".RRRRRRRRRRRK.GGGG",
    "..............KKKKK",
]
ARM_ORIGIN = (2, 20)
SHOULDER = (20.5, 24.0)


def arm(L, angle=0, press=0, led='P'):
    """angle>0 举起（遥控器那头往上），angle<0 放下。press=1 时遥控器往前戳 1 格。
    旋转用「反向采样」：对目标格反算回 0° 位图里的格子，取最近的颜色。"""
    th = math.radians(angle)
    ox, oy = ARM_ORIGIN
    sx, sy = SHOULDER
    rows = [r.replace('l', led) for r in ARM0]
    cos, sin = math.cos(-th), math.sin(-th)
    for y in range(-6, 40):
        for x in range(-8, 30):
            px, py = x + .5 - sx, y + .5 - sy
            qx = px * cos - py * sin + sx
            qy = px * sin + py * cos + sy
            bx, by = int(math.floor(qx)) - ox, int(math.floor(qy)) - oy
            if 0 <= by < len(rows) and 0 <= bx < len(rows[by]):
                c = rows[by][bx]
                if c in ' .':
                    continue
                # 遥控器部分（手以左）跟着 press 前戳
                if press and bx < 13:
                    L.put(x - press, y, c)
                else:
                    L.put(x, y, c)


def zipper_tag(L):
    L.row(22, 25, 'PK')
    L.row(20, 26, 'PPPP')
    L.row(18, 27, 'PPPPP')
    L.row(17, 28, 'PPPPK')
    L.row(17, 29, 'KKKK')


POP_ROWS = {
    24: (35, "WW    W"),
    25: (32, "WW WWWP WWW"),
    26: (30, "WWWPKWWPPKWWPW"),
    27: (29, "WWWPPKWWWPKWWPPW"),
    28: (29, "WPPKWWWPPKWWWPKWW"),
    29: (28, "WWWKWWPPKWWWPPKWWW"),
    30: (28, "WPPKWWWKWWPPKWWWPW"),
}


def bucket(L, shear=0, pop_level=0):
    """shear>0：桶往右歪（按行错位模拟倾斜）。pop_level：桶口爆米花少掉几行（0=满）。"""
    def sx(y):  # 越往上错得越多
        return int(round(shear * (45 - y) / 14))
    for y, (x, s) in POP_ROWS.items():
        if y - 24 < pop_level:
            continue
        L.row(x + sx(y), y, s)
    L.span(31, 28 + sx(31), 45 + sx(31), 'W')
    L.span(32, 28 + sx(32), 45 + sx(32), 'K')
    lefts = [29, 29, 29, 30, 30, 30, 30, 31, 31, 31, 31, 32]
    rights = [44, 44, 44, 43, 43, 43, 43, 42, 42, 42, 42, 41]
    for i, (a, b) in enumerate(zip(lefts, rights)):
        y = 33 + i
        o = sx(y)
        L.put(a + o, y, 'K'); L.put(b + o, y, 'K')
        for x in range(a + 1, b):
            band = int((x - a - 0.5) / (b - a - 1) * 5)
            L.put(x + o, y, 'W' if band % 2 == 0 else 'L')
    L.span(45, 32, 41, 'K')
    for y, (x, s) in {35: (43, "KGG"), 36: (42, "KGGG"), 37: (42, "KGGG"),
                      38: (42, "KGGD"), 39: (43, "KGD")}.items():
        L.row(x + sx(y), y, s)


KERNEL = ["WW", "WP"]


# ====================================================================
# 特效小图（自带描边，叠在最上层）
# ====================================================================

def bubble(G, x, y, fill, glyph, glyph_color, tail=True, thought=False):
    """13x11 圆角气泡 + 指向右下的尾巴。(x,y) 为画布坐标左上角。"""
    w, h = 13, 11
    for j in range(h):
        for i in range(w):
            corner = (i in (0, w - 1) and j in (0, h - 1))
            if corner:
                continue
            edge = i in (0, w - 1) or j in (0, h - 1) or \
                (i in (1, w - 2) and j in (1, h - 2))
            G.put(x + i, y + j, 'K' if edge else fill)
    for (i, j) in [(1, 1), (w - 2, 1), (1, h - 2), (w - 2, h - 2)]:
        G.put(x + i, y + j, 'K')
    if thought:
        f2 = fill * 2
        G.bitmap(x + 8, y + 11, [".KK.", "K" + f2 + "K", "K" + f2 + "K", ".KK."])
        G.bitmap(x + 12, y + 15, [".K.", "K" + fill + "K", ".K."])
        tail = False
    if tail:
        for (i, j, c) in [(9, 10, fill), (10, 10, fill), (9, 11, 'K'), (10, 11, fill), (11, 11, 'K'),
                          (10, 12, 'K'), (11, 12, fill), (12, 12, 'K'), (12, 13, 'K'),
                          (11, 10, fill), (8, 10, fill)]:
            G.put(x + i, y + j, c)
        G.put(x + 13, y + 13, 'K'); G.put(x + 12, y + 11, 'K') if False else None
    gw = max(len(r) for r in glyph)
    gx = x + (w - gw) // 2
    gy = y + (h - len(glyph)) // 2
    G.bitmap(gx, gy, glyph, glyph_color)


GLYPH_BANG = ["XX", "XX", "XX", "XX", "..", "XX"]
GLYPH_Q = [".XXX.", "X...X", "...XX", "..XX.", "..X..", ".....", "..X.."][0:7]
GLYPH_Q = [".XXX.", "X..XX", "..XX.", "..X..", ".....", "..X.."]
GLYPH_NOSIG = ["..XXX..", ".X...X.", "...X...", "..X.X..", "...X..."]
DOTS = {1: ["X......"], 2: ["X..X..."], 3: ["X..X..X"]}

CHECK_BADGE = [
    "...KKKKK...",
    ".KKhhhhhKK.",
    ".KhhhhhhWK.",
    "KhhhhhhWWhK",
    "KhhhhhWWhhK",
    "KhWhhWWhhhK",
    "KhWWWWhhhhK",
    "KhhWWhhhhhK",
    ".KhhhhhhhK.",
    ".KKhhhhhKK.",
    "...KKKKK...",
]
Z_BIG = ["XXXXX", "...X.", "..X..", ".X...", "XXXXX"]
Z_SMALL = ["XXX", ".X.", "XXX"]
SWEAT = [".K.", "KcK", "KcK", "KccK"[:3], ".K."]
SWEAT = ["..K..", ".KcK.", "KccWK", "KcccK", ".KKK."]
GL3 = {
    '>': ["X..", ".X.", "..X", ".X.", "X.."],
    '_': ["...", "...", "...", "...", "XXX"],
    '$': [".XX", "XX.", ".X.", ".XX", "XX."],
    '{': [".XX", ".X.", "X..", ".X.", ".XX"],
    '}': ["XX.", ".X.", "..X", ".X.", "XX."],
    '#': ["X.X", "XXX", "X.X", "XXX", "X.X"],
}


def glyph_text(G, x, y, text, color):
    for i, ch in enumerate(text):
        G.bitmap(x + i * 4, y, GL3[ch], color)


def waves(G, n):
    """遥控器前端的信号波 ((( ，n=1..3 圈。遥控器左端约在画布 x=OX+2, y=OY+22。"""
    cx, cy = OX + 1, OY + 22.5
    for k in range(1, n + 1):
        r = 2 + k * 2.2
        for a in range(-55, 56, 6):
            t = math.radians(a)
            G.put(round(cx - r * math.cos(t)), round(cy + r * math.sin(t)), 'g')


def snot(G, r):
    """鼻涕泡：面罩左下角。r=0..3。"""
    cx, cy = OX + 22, OY + 25.5
    if r <= 0:
        return
    for y in range(int(cy - r - 1), int(cy + r + 2)):
        for x in range(int(cx - r - 1), int(cx + r + 2)):
            d = math.hypot(x + .5 - cx, y + .5 - cy)
            if d <= r + .5:
                G.put(x, y, 'W' if d > r - .6 else 'c')
    if r >= 2:
        G.put(int(cx - r / 2), int(cy - r / 2), 'W')


# ====================================================================
# 一帧 = 一组姿势参数
# ====================================================================

DEFAULT = dict(
    fx=0, fy=0,            # 整个人平移（跳、抖）
    head=0,                # 上半身下沉格数（呼吸 / 点头）
    earL=20, earR=31,      # 耳朵角度
    earL_dy=0, earR_dy=0,
    tip='P',               # 耳尖按钮颜色
    eyes='open', ex=0, ey=0,
    arm=0, press=0, led='P',
    shear=0, pop_level=0,
    kernels=(),            # 额外的爆米花粒（人物坐标）
    fx_items=(),           # 特效：函数(G) 列表
)


def frame(**kw):
    p = dict(DEFAULT, **kw)
    fig = Grid()
    hd = p['head']
    up = Layer(fig, p['fx'], p['fy'] + hd)
    lo = Layer(fig, p['fx'], p['fy'])
    ear(Layer(fig, p['fx'], p['fy'] + hd + p['earL_dy']), (29.6, 13.2), p['earL'], tip=p['tip'])
    ear(Layer(fig, p['fx'], p['fy'] + hd + p['earR_dy']), (37.2, 14.0), p['earR'], tip=p['tip'])
    up.row(28, 11, 'K')
    body_lower(lo)
    body_upper(up)
    face(up, p['eyes'], p['ex'], p['ey'])
    arm(up, p['arm'], p['press'], p['led'])
    zipper_tag(up)
    bucket(lo, p['shear'], p['pop_level'])
    for (kx, ky) in p['kernels']:
        lo.bitmap(round(kx), round(ky), KERNEL)
    fig.ring_pass('K')
    fig.ring_pass('O')
    fx = Grid()
    for f in p['fx_items']:
        f(fx)
    fig.over(fx)
    return ["".join(r) for r in fig.g]


# ---- 特效的快捷写法（画布坐标） ----
BX, BY = OX + 3, OY - 6     # 气泡位置：头左上方


def fx_bubble(fill, glyph, color, dx=0, dy=0, thought=False):
    return lambda G: bubble(G, BX + dx, BY + dy, fill, glyph, color, thought=thought)


def fx_kernels(pts):
    """飞在空中的爆米花：单独一层、自带黑描边，盖在人物上面也看得清。"""
    def f(G):
        g2 = Grid()
        for (kx, ky) in pts:
            g2.bitmap(OX + round(kx), OY + round(ky), KERNEL)
        g2.ring_pass('K')
        G.over(g2)
    return f


def fx_badge(dx=0, dy=0):
    return lambda G: G.bitmap(BX + 1 + dx, BY + dy, CHECK_BADGE)


def fx_z(x, y, big=True):
    def f(G):
        rows = Z_BIG if big else Z_SMALL
        # 带描边的 Z：先描一圈黑
        g2 = Grid(); g2.bitmap(x, y, rows, 'b'); g2.ring_pass('K'); G.over(g2)
    return f


def fx_glyphs(items):
    def f(G):
        g2 = Grid()
        for (x, y, t, c) in items:
            glyph_text(g2, x, y, t, c)
        G.over(g2)
    return f


CONFETTI = [(-2.2, -2.6, 'y'), (-1.2, -3.2, 'g'), (0.2, -3.6, 'b'), (1.4, -3.0, 'r'), (2.4, -2.4, 'v'),
            (-2.8, -1.6, 'o'), (3.0, -1.4, 'g'), (-0.6, -2.2, 'r'), (0.9, -2.0, 'y'), (1.9, -3.4, 'b')]


def fx_confetti(k):
    """落地时头顶迸出的彩色纸屑：1~2 格的小色块，先冲上去再飘落。"""
    def f(G):
        if k > 8:
            return
        t = k + 1
        for n, (vx, vy, c) in enumerate(CONFETTI):
            x = OX + 36 + vx * 1.3 * t
            y = OY - 3 + vy * t + 0.30 * t * t
            G.put(round(x), round(y), c)
            if (n + k) % 2 == 0:
                G.put(round(x) + 1, round(y), c)
    return f


def fx_waves(n):
    return lambda G: waves(G, n)


def fx_snot(r):
    return lambda G: snot(G, r)


def fx_sweat(dy):
    return lambda G: G.bitmap(OX + 18, OY + 13 + dy, SWEAT)


# ====================================================================
# 9 个状态的编排：[(姿势, 毫秒)]
# ====================================================================

def build_states():
    S = {}

    # —— 闲着：呼吸、眨眼、耳朵轻晃、偶尔抓一粒爆米花吃 ——
    breathe_a = dict()
    breathe_b = dict(head=1, earL=18, earR=33)
    pop = [(38, 21), (39, 15), (40, 12), (40, 13), (39, 18)]   # 一粒爆米花自己蹦出桶口再落回
    S['idle'] = [
        (frame(**breathe_a), 450), (frame(**breathe_b), 450),
        (frame(**breathe_a), 450), (frame(**breathe_b), 450),
        (frame(**breathe_a, eyes='closed'), 110), (frame(**breathe_a), 350),
        (frame(**breathe_b), 450), (frame(**breathe_a), 300),
        (frame(fx_items=[fx_kernels([pop[0]])], ex=1), 110),
        (frame(fx_items=[fx_kernels([pop[1]])], ex=1, ey=-1), 110),
        (frame(fx_items=[fx_kernels([pop[2]])], ex=1, ey=-2), 160),
        (frame(fx_items=[fx_kernels([pop[3]])], ex=1, ey=-2), 160),
        (frame(fx_items=[fx_kernels([pop[4]])], ex=1, ey=-1), 110),
        (frame(head=1, eyes='happy'), 180), (frame(eyes='happy'), 180),
        (frame(head=1, eyes='happy'), 180), (frame(), 400),
    ]

    # —— 思考：抬眼看右上、耳朵交替抖、点点点 ——
    think = lambda n, **k: frame(**dict(dict(ex=1, ey=-2, fx_items=[fx_bubble('W', DOTS[n], 'D', thought=True)]), **k))
    S['thinking'] = [
        (think(1, earL=14), 320), (think(2), 320), (think(3, earR=37), 320), (think(3, head=1), 320),
    ]

    # —— 执行命令：遥控器一下下按，绿灯闪，信号波一圈圈出去，命令符号往上飘 ——
    def run(i):
        press = 1 if i % 4 == 0 else 0
        led = 'g' if i % 4 in (0, 1) else 'P'
        n_w = [1, 2, 3, 0][i % 4]
        t = i / 8
        gl = []
        for k, (txt, col) in enumerate([('>_', 'g'), ('$', 'v'), ('{}', 'o')]):
            ph = (t + k / 3) % 1
            if ph < .85:
                gl.append((OX + 1 + k * 5 - int(ph * 4), OY + 12 - int(ph * 18), txt, col))
        return frame(press=press, led=led, ex=-1, head=1 if i % 4 in (0, 1) else 0,
                     earL=20 - (i % 2) * 3, earR=31 + (i % 2) * 3,
                     fx_items=[fx_waves(n_w), fx_glyphs(gl)])
    S['running'] = [(run(i), 110) for i in range(8)]

    # —— 等你确认：举遥控器挥、蹦、耳尖闪黄、感叹泡泡 ——
    def ask(i):
        hop = [0, -2, -3, -1][i % 4]
        return frame(fy=hop, arm=20 + (i % 2) * 8, eyes='open', ex=0, ey=1,
                     tip='y' if i % 2 == 0 else 'P', head=1 if hop == 0 and i else 0,
                     fx_items=[fx_bubble('y', GLYPH_BANG, 'r', dy=-1 if i % 2 else 0)])
    S['approval'] = [(ask(i), 140) for i in range(8)]

    # —— 提问：一只耳朵耷拉、往左上看、问号左右晃 ——
    q = lambda dx, **k: frame(**dict(dict(earR=70, earL=12, ex=-1, ey=-1,
                              fx_items=[fx_bubble('b', GLYPH_Q, 'W', dx=dx)]), **k))
    S['asking'] = [(q(0), 380), (q(-1, head=1), 380), (q(0), 380), (q(1, earL=16), 380)]

    # —— 完成：蹲、跳、落地时爆米花炸开、对勾弹出、眯眼笑 ——
    jump = [0, 2, -5, -9, -10, -8, -4, 0, 1, 0]
    S['done'] = []
    burst = [(39, 24, 0.3, 3.8), (40, 23, 0.9, 4.4), (41, 24, 1.5, 3.6), (43, 25, 2.2, 3.0),
             (40, 25, 0.6, 2.9), (42, 23, 1.9, 4.6), (42, 25, 2.8, 2.4)]
    for i, j in enumerate(jump):
        S['done'].append((frame(fy=min(j, 0), head=2 if j > 0 else 0,
                                eyes='happy' if j < 0 else 'open', pop_level=0), 90))
    # 落地后：爆米花往上炸开再落下，对勾出现
    for k in range(10):
        ks = [(sx + vx * (k + 1), sy - vy * (k + 1) + 0.42 * (k + 1) ** 2) for (sx, sy, vx, vy) in burst]
        ks = [(x, y) for (x, y) in ks if y < 30 and x < 52]
        items = [fx_kernels(ks), fx_confetti(k)]
        if k >= 1:
            items.append(fx_badge(dy=0 if k > 1 else 2))
        S['done'].append((frame(eyes='happy', pop_level=1 if k < 6 else 0,
                                head=1 if k == 0 else 0, fx_items=items), 90))
    S['done'].append((frame(eyes='happy', fx_items=[fx_badge()]), 700))

    # —— 失败：桶歪了、爆米花撒一地、耳朵耷拉、难过眼、冒冷汗、抖 ——
    spilled = [(44, 44), (47, 45), (50, 44), (46, 42)]
    def err(i):
        shake = [-1, 1, -1, 1, 0, 0, 0, 0, 0, 0][i]
        return frame(fx=shake, shear=3, pop_level=2, kernels=spilled, earL=-30, earR=78,
                     earL_dy=1, earR_dy=1, eyes='sad', arm=-10, head=1,
                     fx_items=[fx_sweat(min(i, 6))] if i >= 2 else [])
    S['error'] = [(err(i), 120 if i < 4 else 160) for i in range(10)]

    # —— 断线：耳朵当天线左右扫、红灯闪、左右张望、断信号泡泡 ——
    scan = [(-8, 18), (8, 36), (20, 46), (8, 36), (-8, 18), (-14, 10)]
    S['offline'] = []
    for i, (a, b) in enumerate(scan):
        S['offline'].append((frame(earL=a + 20, earR=b + 5, ex=-2 if i < 3 else 1,
                                   led='r' if i % 2 == 0 else 'R',
                                   fx_items=[fx_bubble('P', GLYPH_NOSIG, 'r')]), 220))

    # —— 睡觉：闭眼、耳朵和手垂下、慢呼吸、鼻涕泡、Zzz ——
    S['sleeping'] = []
    for i in range(8):
        hb = 1 if i % 4 in (1, 2) else 0
        zs = []
        for k in range(3):
            ph = ((i / 8) + k / 3) % 1
            zs.append(fx_z(OX + 13 - int(ph * 8), OY + 4 - int(ph * 14), big=ph > .45))
        S['sleeping'].append((frame(eyes='closed', earL=-40, earR=82, earL_dy=2, earR_dy=2,
                                    arm=-14, head=hb + 1,
                                    fx_items=[fx_snot([1, 1.5, 2, 2.5, 2, 1.5, 1, 0][i])] + zs), 420))
    return S


# ====================================================================
# 导出
# ====================================================================

ORDER = ['idle', 'thinking', 'running', 'approval', 'asking', 'done', 'error', 'offline', 'sleeping']
NAMES = {'idle': '闲着', 'thinking': '思考', 'running': '执行命令', 'approval': '等你确认',
         'asking': '提问', 'done': '完成', 'error': '失败', 'offline': '断线', 'sleeping': '睡觉'}


def to_image(rows, scale, bg, dark):
    from PIL import Image
    im = Image.new("RGBA", (W, H), bg)
    for y, r in enumerate(rows):
        for x, c in enumerate(r):
            if c == '.':
                continue
            if c == 'O':
                if dark:
                    im.putpixel((x, y), RIM_DARK + (255,))
                continue
            im.putpixel((x, y), PAL[c] + (255,))
    return im.resize((W * scale, H * scale), Image.NEAREST)


def rle(row):
    """一行按「字符+连续个数」压缩：'....KKG' → '.4K2G'（个数为 1 时省略）。"""
    out, i = [], 0
    while i < len(row):
        j = i
        while j < len(row) and row[j] == row[i]:
            j += 1
        n = j - i
        out.append(row[i] + (str(n) if n > 1 else ''))
        i = j
    return ''.join(out)


def export_previews(states, out_dir):
    from PIL import Image
    os.makedirs(out_dir, exist_ok=True)
    for sid in ORDER:
        n = len(states[sid])
        cols = min(n, 8)
        rws = (n + cols - 1) // cols
        sc = 4
        sheet = Image.new("RGBA", (cols * (W * sc + 6), rws * (H * sc + 6)), (40, 40, 46, 255))
        for i, (rows, _) in enumerate(states[sid]):
            sheet.paste(to_image(rows, sc, (9, 9, 11, 255), True),
                        ((i % cols) * (W * sc + 6), (i // cols) * (H * sc + 6)))
        sheet.save(os.path.join(out_dir, f"{sid}.png"))
        frames = [to_image(rows, 4, (244, 244, 245, 255), False).convert("P", palette=Image.ADAPTIVE)
                  for rows, _ in states[sid]]
        frames[0].save(os.path.join(out_dir, f"{sid}.gif"), save_all=True, append_images=frames[1:],
                       duration=[ms for _, ms in states[sid]], loop=0, disposal=2)


def main():
    ap = argparse.ArgumentParser()
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    ap.add_argument("--out", default=os.path.join(root, "src", "lib", "mascot", "marcelFrames.json"))
    ap.add_argument("--preview", default=None, help="导出帧表 PNG / GIF 的目录（需要 Pillow）")
    args = ap.parse_args()

    states = build_states()
    # 帧去重：相同的格子只存一份
    pool, index, out = [], {}, {}
    for sid in ORDER:
        seq = []
        for rows, ms in states[sid]:
            key = "|".join(rows)
            if key not in index:
                index[key] = len(pool)
                pool.append(rows)
            seq.append([index[key], ms])
        out[sid] = seq
    data = {
        "size": [W, H],
        # 人物外框（画布坐标）：bottom/right = 描边最底行 / 最右列，前端「坐」在横线上、贴右对齐时用；
        # left/top = 人物 48x48 区域左上角，前端给点击热区用
        "anchor": {"bottom": OY + 47, "right": OX + 47, "left": OX, "top": OY},
        "palette": {k: "#%02x%02x%02x" % v for k, v in PAL.items()},
        "frames": [[rle(r) for r in rows] for rows in pool],
        "states": {sid: out[sid] for sid in ORDER},
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf8", newline="") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        f.write(chr(10))
    if args.preview:
        export_previews(states, args.preview)
    print("frames:", len(pool), {sid: len(out[sid]) for sid in ORDER}, "->", args.out)


if __name__ == "__main__":
    main()
