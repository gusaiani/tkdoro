"""Generate static/og.png for social sharing (1200×630)."""
from PIL import Image, ImageDraw, ImageFont
import os

W, H = 1200, 630

# Colours (from style.css)
BG      = "#f8f5f2"
RED     = "#f45d48"
TEAL    = "#0a9e9e"
DIMMER  = "#b0aaa4"
BORDER  = "#e0dbd6"

def hex2rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

img  = Image.new("RGB", (W, H), hex2rgb(BG))
draw = ImageDraw.Draw(img)

# Subtle horizontal rule across the middle
draw.line([(0, H//2), (W, H//2)], fill=hex2rgb(BORDER), width=1)

# ── Try to load IBM Plex Mono; fall back to default ──────────────────────────
def font(size, bold=False):
    candidates = [
        f"/opt/anaconda3/lib/python3.12/site-packages/matplotlib/mpl-data/fonts/ttf/DejaVuSansMono{'Bold' if bold else ''}.ttf",
        "/System/Library/Fonts/Supplemental/Courier New Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Courier New.ttf",
        "/Library/Fonts/IBM Plex Mono Bold.ttf" if bold else "/Library/Fonts/IBM Plex Mono.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    return ImageFont.load_default()

f_logo    = font(108, bold=True)
f_tag     = font(28)
f_hint    = font(22)
f_url     = font(18)

# ── Wordmark ─────────────────────────────────────────────────────────────────
logo_text = "Tikkit"
bb = draw.textbbox((0, 0), logo_text, font=f_logo)
lw = bb[2] - bb[0]
draw.text(((W - lw) // 2, 195), logo_text, font=f_logo, fill=hex2rgb(RED))

# ── Tagline ───────────────────────────────────────────────────────────────────
tag_text = "keyboard-driven time tracking"
bb = draw.textbbox((0, 0), tag_text, font=f_tag)
tw = bb[2] - bb[0]
draw.text(((W - tw) // 2, 330), tag_text, font=f_tag, fill=hex2rgb(TEAL))

# ── Prompt hint ───────────────────────────────────────────────────────────────
# Draw the coloured parts separately so prompt ">" and "↵" are teal
hint_parts = [
    (">", TEAL,   True),
    ("  deep work   ", DIMMER, False),
    ("enter", TEAL,   True),
    (" to track", DIMMER, False),
]
total_w = 0
for text, _, bold in hint_parts:
    f = font(22, bold=bold)
    bb = draw.textbbox((0, 0), text, font=f)
    total_w += bb[2] - bb[0]

x = (W - total_w) // 2
y = 415
for text, color, bold in hint_parts:
    f = font(22, bold=bold)
    draw.text((x, y), text, font=f, fill=hex2rgb(color))
    bb = draw.textbbox((0, 0), text, font=f)
    x += bb[2] - bb[0]

# ── URL bottom-right ──────────────────────────────────────────────────────────
url_text = "tikkit.fly.dev"
bb = draw.textbbox((0, 0), url_text, font=f_url)
draw.text((W - bb[2] - bb[0] - 40, H - 40), url_text, font=f_url, fill=hex2rgb(DIMMER))

out = os.path.join(os.path.dirname(__file__), "static", "og.png")
img.save(out, "PNG", optimize=True)
print(f"Saved {out}  ({os.path.getsize(out)//1024} KB)")
