"""Composes the dark README showcase: all six screenshots in phone frames on one canvas.

Usage: python3 tools/ui/showcase.py [SCREENSHOTS_DIR] [OUT]
       (defaults: docs/screenshots  docs/screenshots/showcase-dark.webp)
Needs Pillow and Noto Sans CJK (fonts-noto-cjk). Edit SHOTS to change screens, order or captions.

Same visual language as hero.py: neutral graphite backdrop, the light-mode screens are the only
light source, their cool spill reveals a fine dot grid; metal frames lit from above.
"""
import math, os, sys
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

here = os.path.dirname(os.path.abspath(__file__))
repo = os.path.dirname(os.path.dirname(here))
src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(repo, "docs/screenshots")
out_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(src, "showcase-dark.webp")

SHOTS = [
    ("01-home.png", "首页", "直接说你要做什么"),
    ("04-phone-action.png", "操作手机", "开关 Wi‑Fi、蓝牙、勿扰"),
    ("05-trajectory.png", "轨迹", "按轮次回看每一步"),
    ("08-quick-panel.png", "随处唤起", "悬浮球、磁贴、分享"),
    ("10-settings-perms.png", "手机权限", "用到才申请，一处管理"),
    ("07-drawer.png", "会话列表", "历史对话随时找回"),
]

W, H = 2560, 1200
BG_TOP, BG_BOTTOM = (25, 27, 31), (13, 14, 17)
INK, INK_2 = (244, 245, 247), (150, 156, 166)
LIGHT = (205, 218, 255)
SCREEN_W, BEZEL = 340, 12
MARGIN, TOP, STAGGER = 80, 86, 56

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
    g = Image.linear_gradient("L").resize((1, 256)).point(lambda v: round(top + (bottom - top) * v / 255))
    return g.resize(size)

def backdrop(lx, ly, rx, ry):
    """Graphite gradient + one wide elliptical spill of screen light centred on (lx, ly)."""
    bg = Image.merge("RGB", [vgrad((W, H), a, b) for a, b in zip(BG_TOP, BG_BOTTOM)]).convert("RGBA")
    fall = Image.radial_gradient("L").resize((2 * rx, 2 * ry), Image.BICUBIC)
    spill = Image.new("RGBA", fall.size, LIGHT + (0,))
    spill.putalpha(fall.point(lambda v: round(max(0, 1 - v / 255) ** 2.2 * 46)))
    bg.alpha_composite(spill, (lx - rx, ly - ry))
    grid = Image.new("L", (W, H), 0)
    gd = ImageDraw.Draw(grid)
    step = 36
    for y in range(step // 2, H, step):
        for x in range(step // 2, W, step):
            a = max(0.0, 1 - math.hypot((x - lx) / rx, (y - ly) / ry)) ** 1.4
            if a > 0.02:
                gd.ellipse((x - 1.7, y - 1.7, x + 1.7, y + 1.7), fill=round(a * 34))
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
    lay = Image.new("RGBA", (pw, ph), (0, 0, 0, 0))
    frame = Image.merge("RGB", [vgrad((pw, ph), 128, 42)] * 3).convert("RGBA")   # metal, lit from above
    frame.putalpha(rmask((pw, ph), r))
    lay.alpha_composite(frame)
    inner = Image.new("RGBA", (pw - 4, ph - 4), (12, 13, 16, 255))
    inner.putalpha(rmask(inner.size, r - 2))
    lay.alpha_composite(inner, (2, 2))
    sheen = Image.linear_gradient("L").rotate(-35, resample=Image.BICUBIC).resize(shot.size)
    glass = Image.new("RGBA", shot.size, (255, 255, 255, 0))
    glass.putalpha(sheen.point(lambda v: round(max(0, 120 - v) * 0.16)))
    shot.alpha_composite(glass)
    shot.putalpha(rmask(shot.size, r - BEZEL))
    lay.alpha_composite(shot, (BEZEL, BEZEL))
    d = ImageDraw.Draw(lay)
    cx = pw // 2
    d.ellipse((cx - 7, BEZEL + 13, cx + 7, BEZEL + 27), fill=(6, 6, 8))
    d.ellipse((cx - 3, BEZEL + 18, cx + 1, BEZEL + 22), fill=(34, 40, 56))
    return lay

def main():
    phones = [phone(Image.open(os.path.join(src, n)).convert("RGB")) for n, _, _ in SHOTS]
    pw, ph = phones[0].size
    gap = (W - 2 * MARGIN - len(phones) * pw) / (len(phones) - 1)
    slots = [(round(MARGIN + i * (pw + gap)), TOP + (STAGGER if i % 2 else 0)) for i in range(len(phones))]

    canvas = backdrop(W // 2, TOP + ph // 2 + 40, 1500, 760)
    for color, a, off, blur in (((0, 0, 0), 190, (0, 34), 30), (LIGHT, 44, (0, 0), 46)):
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        for p, (x, y) in zip(phones, slots):
            s = Image.new("RGBA", p.size, color + (0,))
            s.putalpha(p.getchannel("A").point(lambda v: v * a // 255))
            layer.alpha_composite(s, (x + off[0], y + off[1]))
        canvas.alpha_composite(layer.filter(ImageFilter.GaussianBlur(blur)))

    draw = ImageDraw.Draw(canvas)
    f_title, f_sub = font(True, 46), font(False, 32)
    for p, (x, y), (_, title, sub) in zip(phones, slots, SHOTS):
        canvas.alpha_composite(p, (x, y))
        cx = x + pw // 2
        draw.text((cx, y + ph + 50), title, font=f_title, fill=INK, anchor="mt")
        draw.text((cx, y + ph + 116), sub, font=f_sub, fill=INK_2, anchor="mt")

    canvas.putalpha(ImageChops.multiply(canvas.getchannel("A"), rmask((W, H), 44)))
    canvas.save(out_path, "WEBP", quality=90, method=6)
    print(out_path, os.path.getsize(out_path) // 1024, "KB")

main()
