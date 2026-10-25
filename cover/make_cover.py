# -*- coding: utf-8 -*-
"""把 AI 主视觉合成为 4:3 比赛封面：标题牌 + 赛事标签 + 底部信息条。"""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

SRC = r"E:\LC_DATA\syncDisk\AiData\projectFile\wayToAgi\dine\cover\A_clean_modern_poster_illustra_2026-10-25T03-02-10.png"
OUT_PNG = r"E:\LC_DATA\syncDisk\AiData\projectFile\wayToAgi\dine\cover\麦点点_比赛封面_4x3.png"
OUT_JPG = r"E:\LC_DATA\syncDisk\AiData\projectFile\wayToAgi\dine\cover\麦点点_比赛封面_4x3.jpg"

W, H = 1920, 1440  # 4:3
BRAND_RED = (200, 16, 46)      # #c8102e
BRAND_DEEP = (143, 11, 32)     # #8f0b20
GOLD = (255, 199, 44)          # #ffc72c
CREAM = (250, 247, 242)        # #faf7f2
INK = (23, 23, 23)

YAHEI_BD = r"C:\Windows\Fonts\msyhbd.ttc"
YAHEI = r"C:\Windows\Fonts\msyh.ttc"

def F(path, size):
    return ImageFont.truetype(path, size)

def fit_font(draw, text, path, start, max_w):
    s = start
    while s > 10:
        f = F(path, s)
        if draw.textlength(text, font=f) <= max_w:
            return f
        s -= 1
    return F(path, 10)

base = Image.open(SRC).convert("RGB").resize((W, H), Image.LANCZOS)
canvas = base.convert("RGBA")

# ---------- 底部信息条：渐变过渡 + 实心深红 ----------
band = Image.new("RGBA", (W, H), (0, 0, 0, 0))
bd = ImageDraw.Draw(band)
g0, g1, solid = 1200, 1262, 1262
for y in range(g0, g1):
    t = (y - g0) / (g1 - g0)
    a = int(255 * (t ** 1.4))
    bd.line([(0, y), (W, y)], fill=(143, 11, 32, a))
bd.rectangle([0, solid, W, H], fill=(143, 11, 32, 255))
# 顶部金色细线
bd.line([(0, solid), (W, solid)], fill=(255, 199, 44, 255), width=4)
canvas = Image.alpha_composite(canvas, band)
draw = ImageDraw.Draw(canvas)

# 底部文案
tag = "让看不清楚、识字困难的人，也能自己点一顿麦当劳"
tf = fit_font(draw, tag, YAHEI_BD, 46, W - 200)
draw.text((W // 2, 1302), tag, font=tf, fill=(255, 255, 255, 255), anchor="mm")

meta = "三键顺序点餐 · 麦当劳 MCP 真实数据 · 重庆赛区 · WorkBuddy 制作"
mf = fit_font(draw, meta, YAHEI_BD, 30, W - 240)
draw.text((W // 2, 1368), meta, font=mf, fill=(255, 205, 70, 255), anchor="mm")

# ---------- 左上角标题牌（带柔和阴影） ----------
bx0, by0, bx1, by1, r = 46, 46, 452, 268, 28
sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
shd = ImageDraw.Draw(sh)
shd.rounded_rectangle([bx0 + 6, by0 + 12, bx1 + 6, by1 + 12], radius=r, fill=(0, 0, 0, 90))
sh = sh.filter(ImageFilter.GaussianBlur(14))
canvas = Image.alpha_composite(canvas, sh)
draw = ImageDraw.Draw(canvas)

draw.rounded_rectangle([bx0, by0, bx1, by1], radius=r, fill=BRAND_RED + (255,))
# 金色内描边
draw.rounded_rectangle([bx0 + 5, by0 + 5, bx1 - 5, by1 - 5], radius=r - 4,
                       outline=GOLD + (255,), width=3)

title = "麦点点"
tfont = fit_font(draw, title, YAHEI_BD, 104, (bx1 - bx0) - 60)
draw.text((bx0 + 34, by0 + 26), title, font=tfont, fill=(255, 255, 255, 255), anchor="lt")
tw = draw.textlength(title, font=tfont)
# 金色下划短线
draw.rectangle([bx0 + 36, by0 + 150, bx0 + 36 + tw, by0 + 158], fill=GOLD + (255,))

sub = "无障碍顺序点餐"
sfont = fit_font(draw, sub, YAHEI_BD, 30, (bx1 - bx0) - 60)
draw.text((bx0 + 34, by0 + 168), sub, font=sfont, fill=GOLD + (255,), anchor="lt")

# ---------- 右上角赛事标签 ----------
pill = [1540, 50, 1888, 118]
psh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
pd = ImageDraw.Draw(psh)
pd.rounded_rectangle([pill[0] + 4, pill[1] + 8, pill[2] + 4, pill[3] + 8], radius=34, fill=(0, 0, 0, 70))
psh = psh.filter(ImageFilter.GaussianBlur(10))
canvas = Image.alpha_composite(canvas, psh)
draw = ImageDraw.Draw(canvas)

draw.rounded_rectangle(pill, radius=34, fill=(23, 23, 23, 200))
ptext = "WaytoAGI 1024 · 用餐赛道"
pf = fit_font(draw, ptext, YAHEI_BD, 27, 300)
draw.text(((pill[0] + pill[2]) // 2, (pill[1] + pill[3]) // 2), ptext,
          font=pf, fill=(255, 205, 70, 255), anchor="mm")

canvas.convert("RGB").save(OUT_PNG, "PNG")
canvas.convert("RGB").save(OUT_JPG, "JPEG", quality=92)
print("OK", OUT_PNG, canvas.size)
