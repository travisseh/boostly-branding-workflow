# Compose Figma sheet exports into the onboarding-preview look (rounded cards, soft ambient shadow, white ground).
import sys, os
from PIL import Image, ImageDraw, ImageFilter, ImageFont
src, out_png, out_pdf, hero, title = sys.argv[1:6]
BG=(255,255,255)
def card(im, h, radius=28):
    im = im.convert('RGBA'); w = round(im.width * h / im.height); im = im.resize((w, h), Image.LANCZOS)
    mask = Image.new('L', (w, h), 0); ImageDraw.Draw(mask).rounded_rectangle([0,0,w-1,h-1], radius, fill=255)
    pad = 90; canvas = Image.new('RGBA', (w+2*pad, h+2*pad), (0,0,0,0))
    sh = Image.new('RGBA', canvas.size, (0,0,0,0)); ImageDraw.Draw(sh).rounded_rectangle([pad, pad+28, pad+w, pad+h+28], radius, fill=(20,16,16,95))
    sh = sh.filter(ImageFilter.GaussianBlur(34)); canvas.alpha_composite(sh)
    body = Image.new('RGBA', (w,h), (0,0,0,0)); body.paste(im, (0,0), mask)
    # 1px hairline so white sheets read as objects
    ImageDraw.Draw(body).rounded_rectangle([0,0,w-1,h-1], radius, outline=(0,0,0,28), width=2)
    canvas.alpha_composite(body, (pad, pad)); return canvas
names = ['1-table-stickers','2-review-stickers','3-bathroom-stickers','4-bathroom-review-stickers','5-pop-primary','6-pop-light','7-togo-promo','8-togo-review']
ims = {n: Image.open(os.path.join(src, n+'.png')) for n in names}
H=1100
row1 = [card(ims[n], H) for n in names[:4]]
pops = [card(ims[n], H) for n in names[4:6]]
togo = [card(ims[n], 360) for n in names[6:8]]
gap=10
w1 = sum(c.width for c in row1) + gap*3
togo_col_w = max(c.width for c in togo); togo_col_h = sum(c.height for c in togo)
w2 = sum(c.width for c in pops) + togo_col_w + gap*2
W = max(w1, w2) + 160
try: font = ImageFont.truetype('/System/Library/Fonts/HelveticaNeue.ttc', 54); small = ImageFont.truetype('/System/Library/Fonts/HelveticaNeue.ttc', 34)
except Exception: font = small = ImageFont.load_default()
r1h = max(c.height for c in row1); r2h = max(max(c.height for c in pops), togo_col_h)
sheet = Image.new('RGBA', (W, 200 + r1h + r2h + 120), BG+(255,))
d = ImageDraw.Draw(sheet); d.text((80, 60), title, fill=(23,19,19), font=font)
d.text((80, 135), 'Print sheets as generated in Figma. Table + bathroom stickers carry the VIP copy.', fill=(110,105,105), font=small)
x = (W - w1)//2; y = 200
for c in row1: sheet.alpha_composite(c, (x, y)); x += c.width + gap
x = (W - w2)//2; y = 200 + r1h
for c in pops: sheet.alpha_composite(c, (x, y)); x += c.width + gap
yy = y
for c in togo: sheet.alpha_composite(c, (x, yy)); yy += c.height
sheet.convert('RGB').save(out_png, optimize=True)
# PDF: page 1 hero preview (on white, matching harness), page 2 full set, then each sheet card alone
pages = []
h = Image.open(hero).convert('RGBA'); hp = Image.new('RGBA', (h.width+200, h.height+260), BG+(255,)); hp.alpha_composite(h, (100, 200))
ImageDraw.Draw(hp).text((100, 70), title, fill=(23,19,19), font=font); pages.append(hp.convert('RGB'))
pages.append(sheet.convert('RGB'))
for n in names:
    c = card(ims[n], 1600); p = Image.new('RGBA', (c.width+200, c.height+220), BG+(255,)); p.alpha_composite(c, (100, 160))
    ImageDraw.Draw(p).text((100, 60), n[2:].replace('-', ' ').title(), fill=(23,19,19), font=small); pages.append(p.convert('RGB'))
pages[0].save(out_pdf, save_all=True, append_images=pages[1:], resolution=150)
print(out_png, sheet.size, out_pdf, len(pages))
