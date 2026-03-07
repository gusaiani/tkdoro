"""Generate static/og.png for social sharing (1200×630)."""
from PIL import Image, ImageDraw, ImageFont
import os

W, H = 1200, 630

# Colours (matching app)
BG     = "#FCFBFB"
RED    = "#FF3B30"
TEXT   = "#1C1C1E"
DIM    = "#6E6E73"

def hex2rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

img  = Image.new("RGB", (W, H), hex2rgb(BG))
draw = ImageDraw.Draw(img)

# ── Font loader ────────────────────────────────────────────────────────────────
def font(size, bold=False):
    candidates = [
        # San Francisco (macOS system font)
        "/System/Library/Fonts/SFNS.ttf",
        # CI fallbacks for Linux (GitHub Actions)
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/opt/anaconda3/lib/python3.12/site-packages/matplotlib/mpl-data/fonts/ttf/DejaVuSans-Bold.ttf" if bold else "/opt/anaconda3/lib/python3.12/site-packages/matplotlib/mpl-data/fonts/ttf/DejaVuSans.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    return ImageFont.load_default()

f_logo = font(120, bold=True)
f_tag  = font(38)
f_url  = font(31)

# ── Beaver mascot (centered) ──────────────────────────────────────────────────
beaver_path = os.path.join(os.path.dirname(__file__), "static", "beaver.png")
beaver = Image.open(beaver_path).convert("RGBA")
bh = 350
bw = int(beaver.width * bh / beaver.height)
beaver = beaver.resize((bw, bh), Image.LANCZOS)
bx = (W // 2 - bw) // 2
by = (H - bh) // 2
img.paste(beaver, (bx, by), beaver)

# ── Right column: wordmark + tagline ─────────────────────────────────────────
center_x = (bx + bw + W) // 2

logo_text = "DOING IT"
bb = draw.textbbox((0, 0), logo_text, font=f_logo)
lw = bb[2] - bb[0]
draw.text((center_x - lw // 2, 210), logo_text, font=f_logo, fill=hex2rgb(RED))

tag_text = "From to-do to done, tracked"
bb = draw.textbbox((0, 0), tag_text, font=f_tag)
tw = bb[2] - bb[0]
draw.text((center_x - tw // 2, 335), tag_text, font=f_tag, fill=hex2rgb(TEXT))

# ── URL below tagline, centered in right column ───────────────────────────────
url_text = "doingit.online"
bb = draw.textbbox((0, 0), url_text, font=f_url)
uw = bb[2] - bb[0]
draw.text((center_x - uw // 2, 390), url_text, font=f_url, fill=hex2rgb(DIM))

out = os.path.join(os.path.dirname(__file__), "static", "og.png")
img.save(out, "PNG", optimize=True)
print(f"Saved {out}  ({os.path.getsize(out)//1024} KB)")
