"""원본 포스터에서 글 영역만 지우고 같은 자리에 한국어를 넣어 번역판을 만든다.

    python tools/build_poster_ko.py

입력: reference/poster_print_master_2526x3576.png (비공개), packages/educational-content/data/poster_ko.json
출력: apps/web-ar/public/assets/poster/original.webp, ko.webp
글 영역은 그 사각형에서 가장 흔한 색(=바탕색)으로 덮는다. 그림·사진·그래프는 원본 픽셀 그대로다.
"""
import io
import json
import os
import sys
from collections import Counter

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'reference', 'poster_print_master_2526x3576.png')
SPEC = os.path.join(ROOT, 'packages', 'educational-content', 'data', 'poster_ko.json')
FONTS = os.path.join(ROOT, 'node_modules', 'pretendard', 'dist', 'public', 'static')
OUT = os.path.join(ROOT, 'apps', 'web-ar', 'public', 'assets', 'poster')
OUT_W = 1800

COLORS = {
    'ink': (14, 27, 61),
    'body': (28, 36, 54),
    'gray': (92, 102, 118),
    'white': (255, 255, 255),
    'orange': (196, 121, 62),
    'purple': (105, 88, 150),
}
_fonts = {}


def font(weight, size):
    key = (weight, size)
    if key not in _fonts:
        _fonts[key] = ImageFont.truetype(os.path.join(FONTS, f'Pretendard-{weight}.otf'), size)
    return _fonts[key]


def wrap(draw, text, f, width):
    lines, cur = [], ''
    for word in text.split(' '):
        trial = word if not cur else cur + ' ' + word
        if draw.textlength(trial, font=f) <= width or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


def main():
    spec = json.load(io.open(SPEC, encoding='utf-8'))
    im = Image.open(SRC).convert('RGB')
    assert list(im.size) == spec['source_size'], im.size
    os.makedirs(OUT, exist_ok=True)
    h = round(OUT_W * im.size[1] / im.size[0])
    im.resize((OUT_W, h), Image.LANCZOS).save(os.path.join(OUT, 'original.webp'), quality=84, method=6)

    draw = ImageDraw.Draw(im)
    problems = []
    for b in spec['blocks']:
        r = b.get('r')
        if r:
            crop = im.crop(tuple(r))
            bg = Counter(crop.getdata()).most_common(1)[0][0]
            draw.rectangle([r[0], r[1], r[2] - 1, r[3] - 1], fill=bg)
        t = b.get('t')
        if not t:
            continue
        f = font(b.get('w', 'Regular'), b['s'])
        color = COLORS[b.get('c', 'body')]
        align = b.get('a', 'l')
        anchor = {'l': 'l', 'c': 'm', 'r': 'r'}[align]
        if b.get('wrap'):
            pad = b.get('pad', 0)
            lines = wrap(draw, t, f, r[2] - r[0] - pad)
            lh = b['lh']
            if len(lines) * lh > r[3] - r[1] + 6:
                problems.append(f'넘침(줄 {len(lines)}): {t[:24]}')
            for i, line in enumerate(lines):
                draw.text((r[0] + pad, r[1] + lh * (i + 0.5)), line, font=f, fill=color, anchor='lm')
            continue
        if 'at' in b:
            x, y = b['at']
        else:
            pad = b.get('pad', 0)
            x = {'l': r[0] + pad, 'c': (r[0] + r[2]) / 2, 'r': r[2] - pad}[align]
            y = (r[1] + r[3]) / 2
            if draw.textlength(t, font=f) > r[2] - r[0] - pad:
                problems.append(f'넘침: {t[:24]}')
        draw.text((x, y), t, font=f, fill=color, anchor=anchor + 'm')

    if '--preview' in sys.argv:
        im.save(sys.argv[sys.argv.index('--preview') + 1])
    im.resize((OUT_W, h), Image.LANCZOS).save(os.path.join(OUT, 'ko.webp'), quality=84, method=6)
    for p in problems:
        print('!', p.encode('unicode_escape').decode())
    print('ok', OUT_W, h, [os.path.getsize(os.path.join(OUT, n)) for n in ('original.webp', 'ko.webp')])


main()
