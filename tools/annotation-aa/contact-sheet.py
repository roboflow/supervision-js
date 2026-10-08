import json
from pathlib import Path
import sys

from PIL import Image, ImageDraw, ImageFont

report_path = Path(sys.argv[1])
report = json.loads(report_path.read_text())
artifacts = Path(report["artifacts"]["directory"])
output = report_path.parent
modes = ["none", "fxaa", "fxaa2"]
labels = {"none": "AA off", "fxaa": "FXAA", "fxaa2": "FXAA + 2x"}
font_path = Path("/System/Library/Fonts/Supplemental/Arial.ttf")
font = ImageFont.truetype(str(font_path), 22) if font_path.exists() else ImageFont.load_default()
small = ImageFont.truetype(str(font_path), 16) if font_path.exists() else ImageFont.load_default()

overview = Image.new("RGB", (768 * len(modes), 558), "#181818")
draw = ImageDraw.Draw(overview)
for index, mode in enumerate(modes):
    draw.text((index * 768 + 16, 12), labels[mode], font=font, fill="white")
    overview.paste(Image.open(artifacts / f"{mode}.composite.png").convert("RGB"), (index * 768, 46))
overview.save(output / f"{report['backend']['requested']}-overview.png")

rows = [
    ("Masks and thin colored borders", report["regions"]["categoricalMasks"]),
    ("Vector paths and keypoints", report["regions"]["vectorsAndKeypoints"]),
    ("Focus cutout", report["regions"]["focus"]),
    ("Mask label", report["regions"]["labels"]),
]
cell_width = 480
height = 70 + sum(34 + roi["height"] * 2 for _, roi in rows)
sheet = Image.new("RGB", (cell_width * len(modes), height), "#181818")
draw = ImageDraw.Draw(sheet)
draw.text((16, 10), "Native output pixels magnified 2x with nearest sampling", font=small, fill="#cccccc")
for index, mode in enumerate(modes):
    draw.text((index * cell_width + 16, 37), labels[mode], font=font, fill="white")
y = 70
for title, roi in rows:
    for index, mode in enumerate(modes):
        draw.text((index * cell_width + 16, y + 8), title, font=small, fill="#cccccc")
        image = Image.open(artifacts / f"{mode}.composite.png").convert("RGB")
        crop = image.crop((roi["x"], roi["y"], roi["x"] + roi["width"], roi["y"] + roi["height"]))
        enlarged = crop.resize((roi["width"] * 2, roi["height"] * 2), Image.Resampling.NEAREST)
        sheet.paste(enlarged, (index * cell_width + 16, y + 34))
    y += 34 + roi["height"] * 2
sheet.save(output / f"{report['backend']['requested']}-edge-crops.png")
print(output / f"{report['backend']['requested']}-overview.png")
print(output / f"{report['backend']['requested']}-edge-crops.png")
