"""Composes the README hero image (dark): tagline on the left, one screenshot in a phone on the right.

Usage: python3 tools/ui/hero.py [SCREENSHOT] [OUT]
       (defaults: docs/screenshots/07-drawer.png  docs/screenshots/hero.webp)
Needs Pillow, cairosvg and Noto Sans CJK (fonts-noto-cjk). The whale mark is read from ic_launcher_fg.xml.

Design notes: the light-mode screen is the only light source, so its cool glow is the only colour
in the backdrop; the backdrop itself is neutral graphite with a fine dot grid that the glow reveals.
Two frosted cards over the phone tell the story at a glance: you say one sentence, the phone does it.
"""
import io, math, os, re, sys
import cairosvg
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

here = os.path.dirname(os.path.abspath(__file__))
repo = os.path.dirname(os.path.dirname(here))
shot_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(repo, "docs/screenshots/07-drawer.png")
out_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(repo, "docs/screenshots/hero.webp")

NAME = "DSH-Android"
HEADLINE = ["让 DSH", "替你用手机"]
SUB = "不要 root，不用电脑，直接跑在你的安卓手机上。"
NOTE = "Android 10 及以上 ｜ 社区项目，非 DeepSeek 官方应用"
ASK = "列出下载目录里最大的 5 个文件"
DONE = ("已完成", "找到 5 个文件，共 3.2 GB")

W, H = 2560, 1280
BG_TOP, BG_BOTTOM = (25, 27, 31), (13, 14, 17)
INK, INK_2, INK_3 = (244, 245, 247), (160, 166, 175), (104, 110, 120)
BRAND = (65, 118, 230)                    # launcher_bg #4176E6
LIGHT = (205, 218, 255)                   # cool spill from the screen
TEXT_X = 200

SCREEN_W, BEZEL = 620, 15
PHONE_CX, PHONE_TOP, TILT = 1890, 150, 4  # degrees; top leans toward the text

FONT_DIRS = ["/usr/share/fonts/opentype/noto", "/System/Library/Fonts"]
def font(bold, size):
    name = "NotoSansCJK-Bold.ttc" if bold else "NotoSansCJK-Regular.ttc"
    for d in FONT_DIRS:
        p = os.path.join(d, name)
        if os.path.exists(p):
            return ImageFont.truetype(p, size, index=2)  # index 2 = SC
    sys.exit(f"font {name} not found; install fonts-noto-cjk")

def rmask(size, r):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), r, fill=255)
    return m

def vgrad(size, top, bottom):
    """Vertical L gradient from `top` to `bottom`."""
    g = Image.linear_gradient("L").resize((1, 256)).point(lambda v: round(top + (bottom - top) * v / 255))
    return g.resize(size)

def whale(size, tile=True):
    xml = open(os.path.join(repo, "app/src/main/res/drawable/ic_launcher_fg.xml")).read()
    d = re.search(r'pathData="([^"]+)"', xml).group(1)
    box = "-3 -5.5 29.3 29.3" if tile else "0 -3 23.2 23.2"
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{box}"><path fill="#fff" d="{d}"/></svg>'
    png = cairosvg.svg2png(bytestring=svg.encode(), output_width=size, output_height=size)
    w = Image.open(io.BytesIO(png)).convert("RGBA")
    if not tile:
        return w
    t = Image.new("RGBA", (size, size), BRAND + (255,))
    lift = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    lift.putalpha(vgrad((size, size), 46, 0))         # lighter top edge gives the tile some depth
    t.alpha_composite(lift)
    t.alpha_composite(w)
    t.putalpha(rmask((size, size), round(size * 0.28)))
    return t

def backdrop(light_c):
    bg = Image.merge("RGB", [vgrad((W, H), a, b) for a, b in zip(BG_TOP, BG_BOTTOM)]).convert("RGBA")
    lx, ly = light_c
    fall = Image.radial_gradient("L").resize((2300, 1800), Image.BICUBIC)
    spill = Image.new("RGBA", fall.size, LIGHT + (0,))
    spill.putalpha(fall.point(lambda v: round(max(0, 1 - v / 255) ** 2.4 * 62)))
    bg.alpha_composite(spill, (lx - 1150, ly - 900))
    # dot grid, visible only where the screen light reaches
    grid = Image.new("L", (W, H), 0)
    gd = ImageDraw.Draw(grid)
    step = 36
    for y in range(step // 2, H, step):
        for x in range(step // 2, W, step):
            a = max(0.0, 1 - math.hypot((x - lx) / 1.25, y - ly) / 1150) ** 1.6
            if a > 0.02:
                gd.ellipse((x - 1.7, y - 1.7, x + 1.7, y + 1.7), fill=round(a * 40))
    dots = Image.new("RGBA", (W, H), (230, 236, 255, 0))
    dots.putalpha(grid)
    bg.alpha_composite(dots)
    vig = Image.radial_gradient("L").resize((W, H)).point(lambda v: round(min(255, max(0, v - 120) * 1.1) * 0.45))
    shade = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    shade.putalpha(vig)
    bg.alpha_composite(shade)
    grain = Image.effect_noise((W, H), 2.5)           # against banding after WebP
    rgb = [ImageChops.add(c, grain, 1, -128) for c in bg.convert("RGB").split()]
    return Image.merge("RGBA", rgb + [bg.getchannel("A")])

def phone(shot):
    sh = round(SCREEN_W * shot.height / shot.width)
    shot = shot.resize((SCREEN_W, sh), Image.LANCZOS).convert("RGBA")
    pw, ph = SCREEN_W + 2 * BEZEL, sh + 2 * BEZEL
    r = round(pw * 0.13)
    pad = 12                                          # room for side buttons
    lay = Image.new("RGBA", (pw + 2 * pad, ph), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    for top, length in ((300, 150), (500, 90)):
        d.rounded_rectangle((pad + pw - 6, top, pad + pw + 5, top + length), 4, fill=(58, 62, 70))
    frame = Image.merge("RGB", [vgrad((pw, ph), 128, 42)] * 3).convert("RGBA")   # metal, lit from above
    frame.putalpha(rmask((pw, ph), r))
    lay.alpha_composite(frame, (pad, 0))
    inner = Image.new("RGBA", (pw - 6, ph - 6), (12, 13, 16, 255))
    inner.putalpha(rmask(inner.size, r - 3))
    lay.alpha_composite(inner, (pad + 3, 3))
    sheen = Image.linear_gradient("L").rotate(-35, resample=Image.BICUBIC).resize(shot.size)
    glass = Image.new("RGBA", shot.size, (255, 255, 255, 0))
    glass.putalpha(sheen.point(lambda v: round(max(0, 120 - v) * 0.18)))
    shot.alpha_composite(glass)
    shot.putalpha(rmask(shot.size, r - BEZEL))
    lay.alpha_composite(shot, (pad + BEZEL, BEZEL))
    cx = pad + pw // 2
    d.ellipse((cx - 11, BEZEL + 22, cx + 11, BEZEL + 44), fill=(6, 6, 8))
    d.ellipse((cx - 4, BEZEL + 29, cx + 2, BEZEL + 35), fill=(34, 40, 56))
    return lay

def glass_card(canvas, box, radius, tint=(30, 33, 40), alpha=196):
    """Frosted dark card: blurs what is behind it, tints it, top-lit hairline, soft shadow."""
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((x0, y0 + 24, x1, y1 + 30), radius, fill=(0, 0, 0, 150))
    canvas.alpha_composite(sh.filter(ImageFilter.GaussianBlur(34)))
    behind = canvas.crop(box).filter(ImageFilter.GaussianBlur(26))
    behind.alpha_composite(Image.new("RGBA", (w, h), tint + (alpha,)))
    edge = Image.new("RGBA", (w, h), (255, 255, 255, 0))
    ImageDraw.Draw(edge).rounded_rectangle((0, 0, w - 1, h - 1), radius, outline=(255, 255, 255, 255), width=2)
    edge.putalpha(ImageChops.multiply(edge.getchannel("A"), vgrad((w, h), 70, 14)))
    behind.alpha_composite(edge)
    canvas.paste(behind, (x0, y0), rmask((w, h), radius))

def check(draw, cx, cy, r):
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=BRAND)
    k = r / 22
    draw.line([(cx - 9 * k, cy + 1 * k), (cx - 2 * k, cy + 8 * k), (cx + 10 * k, cy - 7 * k)],
              fill=(255, 255, 255), width=round(4 * k), joint="curve")

def main():
    rot = phone(Image.open(shot_path).convert("RGB")).rotate(TILT, resample=Image.BICUBIC, expand=True)
    px, py = PHONE_CX - rot.width // 2, PHONE_TOP - 40
    canvas = backdrop((PHONE_CX, PHONE_TOP + 520))

    alpha = rot.getchannel("A")
    for color, a, off, blur in (((0, 0, 0), 200, (30, 50), 44), (LIGHT, 60, (0, 0), 70)):
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        s = Image.new("RGBA", rot.size, color + (0,))
        s.putalpha(alpha.point(lambda v: v * a // 255))
        layer.alpha_composite(s, (px + off[0], py + off[1]))
        canvas.alpha_composite(layer.filter(ImageFilter.GaussianBlur(blur)))
    canvas.alpha_composite(rot, (px, py))

    draw = ImageDraw.Draw(canvas)
    f_card, f_card_b, f_small = font(False, 38), font(True, 36), font(False, 30)

    # Card 1: the one sentence you say, as an input bar across the phone's left edge.
    ask_w = round(draw.textlength(ASK, font=f_card))
    bx0, by0 = 1290, 790
    bx1, by1 = bx0 + 48 + 44 + 26 + ask_w + 40 + 64 + 28, by0 + 120
    glass_card(canvas, (bx0, by0, bx1, by1), 60)
    draw = ImageDraw.Draw(canvas)
    canvas.alpha_composite(whale(44, tile=False), (bx0 + 48, by0 + 38))
    draw.text((bx0 + 48 + 44 + 26, by0 + 60), ASK, font=f_card, fill=INK, anchor="lm")
    sx = bx1 - 28 - 64
    draw.ellipse((sx, by0 + 28, sx + 64, by0 + 92), fill=BRAND)
    ax, ay = sx + 32, by0 + 60
    draw.line([(ax, ay + 14), (ax, ay - 14)], fill=(255, 255, 255), width=5)
    draw.line([(ax - 12, ay - 2), (ax, ay - 14), (ax + 12, ay - 2)], fill=(255, 255, 255), width=5, joint="curve")

    # Card 2: the result, floating off the phone's right shoulder.
    t1, t2 = DONE
    cw = 64 + 28 + 28 + max(draw.textlength(t1, font=f_card_b), draw.textlength(t2, font=f_small)) + 56
    cx0, cy0 = 2010, 420
    glass_card(canvas, (cx0, cy0, round(cx0 + cw), cy0 + 150), 36)
    draw = ImageDraw.Draw(canvas)
    check(draw, cx0 + 64, cy0 + 75, 28)
    draw.text((cx0 + 120, cy0 + 52), t1, font=f_card_b, fill=INK, anchor="lm")
    draw.text((cx0 + 120, cy0 + 100), t2, font=f_small, fill=INK_2, anchor="lm")

    # Text column.
    f_name, f_head, f_sub, f_note = font(True, 58), font(True, 140), font(False, 46), font(False, 30)
    y = 286
    canvas.alpha_composite(whale(100), (TEXT_X, y))
    draw.text((TEXT_X + 130, y + 50), NAME, font=f_name, fill=INK, anchor="lm")
    y += 100 + 92
    for line in HEADLINE:
        draw.text((TEXT_X - 6, y), line, font=f_head, fill=INK, anchor="lt")
        y += 176
    y += 30
    draw.text((TEXT_X, y), SUB, font=f_sub, fill=INK_2, anchor="lt")
    draw.text((TEXT_X, H - 140), NOTE, font=f_note, fill=INK_3, anchor="ls")

    canvas.putalpha(ImageChops.multiply(canvas.getchannel("A"), rmask((W, H), 44)))
    canvas.save(out_path, "WEBP", quality=90, method=6)
    print(out_path, os.path.getsize(out_path) // 1024, "KB")

main()
