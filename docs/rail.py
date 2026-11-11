"""Render docs/rail.png: a schematic of the chip row, drawn to match client.js CSS.

This is an illustration, not a screenshot. The real chips inherit the Harness theme
through --dsw-alias-* tokens; the values below are a plausible dark-theme stand-in
documented in the README so nobody mistakes it for captured UI.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

S = 3  # supersample; the result is downscaled for crisp edges

BG = (26, 26, 28, 255)
ROW = (32, 32, 36, 255)
ROW_EDGE = (46, 46, 51, 255)
TEXT_PRIMARY = (232, 232, 234, 255)
TEXT_SECONDARY = (154, 154, 162, 255)
BORDER = (58, 58, 63, 255)
BRAND = (77, 107, 254, 255)
IDLE = (107, 107, 116, 255)

FONT = r"C:\Windows\Fonts\segoeui.ttf"
FONT_BOLD = r"C:\Windows\Fonts\segoeuib.ttf"

size = 11 * S
font = ImageFont.truetype(FONT, size)
font_bold = ImageFont.truetype(FONT_BOLD, size)


def text_w(draw, text, f):
    box = draw.textbbox((0, 0), text, font=f)
    return box[2] - box[0]


CHIP_H = int(24 * S * 1.45)  # slightly airier than the UI so it reads at README size
PAD = 9 * S
GAP_IN = 5 * S
GAP_OUT = 4 * S
DOT = 5 * S
RADIUS = CHIP_H // 2

CHIPS = [
    {"label": "3Dviz", "count": "3", "on": True},
    {"label": "Anti-Slop", "count": "", "on": False},
    {"label": "UI/UX", "count": "", "on": False},
    {"label": "Assay", "count": "", "on": True},
]
MODEL = "DeepSeek V4"

probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))


def chip_w(chip):
    width = PAD * 2 + DOT + GAP_IN + text_w(probe, chip["label"], font)
    if chip["count"]:
        width += GAP_IN + text_w(probe, chip["count"], font_bold)
    return width


chips_total = sum(chip_w(c) for c in CHIPS) + GAP_OUT * (len(CHIPS) - 1)
model_w = PAD * 2 + text_w(probe, MODEL, font) + GAP_IN + 8 * S
content_w = chips_total + 18 * S + model_w
row_w = content_w + 32 * S
row_h = CHIP_H + 32 * S

canvas_w = row_w + 56 * S
canvas_h = row_h + 56 * S
img = Image.new("RGBA", (canvas_w, canvas_h), BG)
draw = ImageDraw.Draw(img)

row_x = 28 * S
row_y = 28 * S
draw.rounded_rectangle(
    [row_x, row_y, row_x + row_w, row_y + row_h],
    radius=14 * S,
    fill=ROW,
    outline=ROW_EDGE,
    width=max(1, S // 2),
)

x = row_x + 16 * S
cy = row_y + row_h // 2
top = cy - CHIP_H // 2

for chip in CHIPS:
    w = chip_w(chip)
    edge = BRAND if chip["on"] else BORDER
    fill = (42, 42, 47, 255) if chip["on"] else None
    draw.rounded_rectangle(
        [x, top, x + w, top + CHIP_H],
        radius=RADIUS,
        fill=fill,
        outline=edge,
        width=max(1, round(1.2 * S)),
    )
    dot_x = x + PAD
    dot_r = DOT // 2
    draw.ellipse(
        [dot_x, cy - dot_r, dot_x + DOT, cy + dot_r],
        fill=BRAND if chip["on"] else IDLE,
    )
    tx = dot_x + DOT + GAP_IN
    label_fill = TEXT_PRIMARY if chip["on"] else TEXT_SECONDARY
    draw.text((tx, cy), chip["label"], font=font, fill=label_fill, anchor="lm")
    if chip["count"]:
        tx += text_w(draw, chip["label"], font) + GAP_IN
        draw.text((tx, cy), chip["count"], font=font_bold, fill=BRAND, anchor="lm")
    x += w + GAP_OUT

# separator, then a stand-in for the model selector the chips sit beside
sep_x = x + 9 * S
draw.line([sep_x, top + 4, sep_x, top + CHIP_H - 4], fill=ROW_EDGE, width=max(1, S // 2))

mx = sep_x + 9 * S
draw.rounded_rectangle(
    [mx, top, mx + model_w, top + CHIP_H],
    radius=RADIUS,
    outline=BORDER,
    width=max(1, round(1.2 * S)),
)
draw.text((mx + PAD, cy), MODEL, font=font, fill=TEXT_PRIMARY, anchor="lm")
caret_x = mx + PAD + text_w(draw, MODEL, font) + GAP_IN + 3 * S
draw.line(
    [caret_x, cy - 2 * S, caret_x + 4 * S, cy + 2 * S, caret_x + 8 * S, cy - 2 * S],
    fill=TEXT_SECONDARY,
    width=max(1, round(1.2 * S)),
)

final = img.convert("RGB")
target_w = 1200
final = final.resize((target_w, round(final.height * target_w / final.width)), Image.LANCZOS)
out = Path(__file__).with_name("rail.png")
final.save(out)
print("wrote", out, final.size)
