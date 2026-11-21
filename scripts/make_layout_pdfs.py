"""
検証セットの文面を、実際のPDFにして書き出す(PDFから文字を取り出す部分まで含めて精度を測るため)。

レイアウトの種類(ファイルごとに順番に使う):
  plain    … ふつうの縦向き。2つ以上の空白で区切られた部分は、表の列として離して置く
  spaced   … 表題を1文字ずつ離して置く(均等割付)
  rotated  … 横向きの帳票を、ページを回転させて描く(会計ソフトの横向き帳票に多い)
  shuffled … 行を描く順番をばらばらにする(見出しを最後に描くソフトなど)
  rightcol … 作成日などを右端に寄せ、数字を右寄せにする
  small    … 小さい文字(7pt)で、行の間隔を詰める

使い方: python3 scripts/make_layout_pdfs.py <検証セットのJSON> <出力フォルダ>
  JSON は [{"id": ..., "text": ...}, ...]
"""
import json
import random
import sys
from pathlib import Path

from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

pdfmetrics.registerFont(TTFont("JP", "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf"))
LAYOUTS = ["plain", "spaced", "rotated", "shuffled", "rightcol", "small"]


def cells(line):
    import re
    return [c for c in re.split(r"\s{2,}", line.strip()) if c]


def draw(c, lines, layout, width, height, rnd):
    size = 7 if layout == "small" else 9.5
    lead = size * 1.45
    top = height - 50
    ops = []
    for i, line in enumerate(lines):
        y = top - i * lead * (1.6 if i == 0 else 1)
        if y < 40:
            break
        parts = cells(line)
        if not parts:
            continue
        if i == 0 and layout == "spaced":
            # 表題:1文字ずつ、広い間隔で置く
            title = "".join(parts)
            x = (width - len(title) * size * 2.2) / 2
            for ch in title:
                ops.append((x, y, ch, size * 1.3))
                x += size * 2.2
            continue
        x = 40
        for j, p in enumerate(parts):
            if layout == "rightcol" and j == len(parts) - 1 and len(parts) > 1:
                w = pdfmetrics.stringWidth(p, "JP", size)
                ops.append((width - 40 - w, y, p, size))
            else:
                ops.append((x, y, p, size))
            x += pdfmetrics.stringWidth(p, "JP", size) + size * 3
    if layout == "shuffled":
        rnd.shuffle(ops)
    for x, y, s, sz in ops:
        c.setFont("JP", sz)
        c.drawString(x, y, s)


def make(case, layout, out, rnd):
    lines = case["text"].replace("\r\n", "\n").split("\n")
    path = out / f"{case['id']}.pdf"
    if layout == "rotated":
        # 縦向きのページに、横向きの帳票を90度回して描く
        w, h = A4
        c = canvas.Canvas(str(path), pagesize=(w, h))
        c.translate(w, 0)
        c.rotate(90)
        draw(c, lines, layout, h, w, rnd)
    else:
        size = landscape(A4) if layout == "small" else A4
        c = canvas.Canvas(str(path), pagesize=size)
        draw(c, lines, layout, size[0], size[1], rnd)
    c.showPage()
    c.save()


def main():
    cases = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    rnd = random.Random(7)
    plan = {}
    for i, case in enumerate(cases):
        layout = LAYOUTS[i % len(LAYOUTS)]
        make(case, layout, out, rnd)
        plan[case["id"]] = layout
    (out / "layouts.json").write_text(json.dumps(plan, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
