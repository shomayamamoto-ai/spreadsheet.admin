"""
デモ用のサンプルPDFを作るスクリプト。

・会社名・金額などはすべて架空です。
・一般的な会計帳票の見た目をまねたもので、
  特定の会計ソフトの帳票レイアウトを再現したものではありません。

使い方:
    python3 scripts/generate_samples.py
→ demo/samples/ にPDFが出力されます。
"""
from pathlib import Path

from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

FONT_CANDIDATES = [
    "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf",
    "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
]
OUT = Path(__file__).resolve().parent.parent / "demo" / "samples"
OFFICE = "サンプル会計事務所"

for f in FONT_CANDIDATES:
    if Path(f).exists():
        pdfmetrics.registerFont(TTFont("JP", f))
        break
else:
    raise SystemExit("日本語フォント(IPAゴシック)が見つかりません")


def yen(n):
    return ("△" if n < 0 else "") + f"{abs(n):,}"


class Sheet:
    def __init__(self, filename, size=A4):
        OUT.mkdir(parents=True, exist_ok=True)
        self.c = canvas.Canvas(str(OUT / filename), pagesize=size)
        self.w, self.h = size
        self.c.setTitle(filename)

    def text(self, x, y, s, size=10, right=False, center=False):
        self.c.setFont("JP", size)
        if right:
            self.c.drawRightString(x, y, s)
        elif center:
            self.c.drawCentredString(x, y, s)
        else:
            self.c.drawString(x, y, s)

    def title(self, s, y=None):
        y = y or self.h - 70
        self.text(self.w / 2, y, s, 18, center=True)
        self.c.setLineWidth(0.8)
        self.c.line(self.w / 2 - 110, y - 6, self.w / 2 + 110, y - 6)

    def table(self, x, y, widths, rows, row_h=20, header=True, aligns=None):
        """rows: list of list of str。数字列は右寄せ。"""
        c = self.c
        total_w = sum(widths)
        c.setLineWidth(0.5)
        for r, row in enumerate(rows):
            top = y - r * row_h
            if header and r == 0:
                c.setFillGray(0.9)
                c.rect(x, top - row_h, total_w, row_h, stroke=0, fill=1)
                c.setFillGray(0)
            cx = x
            for i, cell in enumerate(row):
                align = (aligns or ["l"] * len(row))[i]
                if align == "r":
                    self.text(cx + widths[i] - 6, top - row_h + 6, cell, 9.5, right=True)
                elif align == "c" or (header and r == 0):
                    self.text(cx + widths[i] / 2, top - row_h + 6, cell, 9.5, center=True)
                else:
                    self.text(cx + 6, top - row_h + 6, cell, 9.5)
                cx += widths[i]
            c.line(x, top, x + total_w, top)
        bottom = y - len(rows) * row_h
        c.line(x, bottom, x + total_w, bottom)
        cx = x
        for wd in [0] + widths:
            cx += wd
            c.line(cx, y, cx, bottom)
        return bottom

    def footer(self):
        self.text(self.w - 40, 30, f"{OFFICE}  ※デモ用の架空データです", 8, right=True)

    def save(self):
        self.footer()
        self.c.showPage()
        self.c.save()


# ------------------------------------------------------------------
# 1. 月次試算表(株式会社さくら建設)
# ------------------------------------------------------------------
def monthly_trial_balance(filename="scan_0001.pdf", month="令和7年3月分(第18期)",
                          created="令和7年4月15日", code="顧問先コード:10001",
                          name="顧問先名:株式会社さくら建設"):
    s = Sheet(filename, landscape(A4))
    s.title("月次試算表(損益計算書)", s.h - 50)
    if code:
        s.text(40, s.h - 85, code)
    s.text(40, s.h - 102, name)
    s.text(s.w / 2, s.h - 85, month, 11, center=True)
    s.text(s.w - 40, s.h - 85, "作成日:" + created, right=True)
    rows = [
        ["勘定科目", "当月", "期首からの累計", "構成比"],
        ["売上高", "12,380,000", "110,830,000", "100.0%"],
        ["売上原価", "8,904,500", "79,116,500", "71.4%"],
        ["売上総利益", "3,475,500", "31,713,500", "28.6%"],
        ["販売費及び一般管理費", "1,912,800", "22,917,100", "20.7%"],
        ["営業利益", "1,562,700", "8,796,400", "7.9%"],
        ["営業外収益", "28,000", "340,000", "0.3%"],
        ["営業外費用", "41,000", "529,000", "0.5%"],
        ["経常利益", "1,549,700", "8,607,400", "7.8%"],
    ]
    s.table(40, s.h - 125, [230, 170, 170, 100], rows,
            aligns=["l", "r", "r", "r"])
    s.text(40, 70, f"{OFFICE} 担当:佐藤", 9)
    s.save()


# ------------------------------------------------------------------
# 2. 決算報告書(有限会社みなと商店)
# ------------------------------------------------------------------
def financial_statements():
    s = Sheet("scan_0002.pdf")
    s.title("決 算 報 告 書", s.h - 160)
    s.text(s.w / 2, s.h - 230, "第32期", 14, center=True)
    s.text(s.w / 2, s.h - 260, "自 令和6年1月1日  至 令和6年12月31日", 12, center=True)
    s.text(s.w / 2, s.h - 420, "有限会社みなと商店", 20, center=True)
    s.text(s.w / 2, s.h - 450, "顧問先コード:10002", 10, center=True)
    rows = [
        ["損益計算書(要約)", "金額(円)"],
        ["売上高", "64,210,880"],
        ["売上総利益", "19,808,400"],
        ["営業利益", "2,914,300"],
        ["経常利益", "3,005,120"],
        ["税引前当期純利益", "3,005,120"],
        ["法人税、住民税及び事業税", "702,400"],
        ["当期純利益", "2,302,720"],
    ]
    s.table(s.w / 2 - 160, s.h - 500, [200, 120], rows, aligns=["l", "r"])
    s.text(s.w / 2, 120, "作成日:令和7年2月20日", 10, center=True)
    s.save()


# ------------------------------------------------------------------
# 3. 法人税申告書(合同会社ひかりデザイン)
# ------------------------------------------------------------------
def corporate_tax():
    s = Sheet("scan_0003.pdf")
    s.title("法人税の確定申告書(別表一 控)", s.h - 60)
    s.text(40, s.h - 100, "事業年度 自 令和6年7月1日 至 令和7年6月30日")
    s.text(40, s.h - 118, "法人名:合同会社ひかりデザイン")
    s.text(40, s.h - 136, "顧問先コード:10003")
    s.text(s.w - 40, s.h - 118, "TEL 03-0000-1234", right=True)
    s.text(s.w - 40, s.h - 100, "提出日:令和7年8月25日", right=True)
    rows = [
        ["項目", "金額(円)"],
        ["所得金額又は欠損金額", "8,412,000"],
        ["法人税額", "1,320,960"],
        ["法人税額計", "1,320,960"],
        ["控除税額", "0"],
        ["差引確定法人税額", "1,320,900"],
        ["中間申告分の法人税額", "600,000"],
        ["この申告により納付すべき法人税額", "720,900"],
    ]
    s.table(40, s.h - 170, [330, 180], rows, aligns=["l", "r"])
    s.text(40, 120, f"税理士 {OFFICE} 代表 山田太郎(架空)", 9)
    s.save()


# ------------------------------------------------------------------
# 4. 消費税申告書(株式会社さくら建設)
# ------------------------------------------------------------------
def consumption_tax():
    s = Sheet("scan_0004.pdf")
    s.title("消費税及び地方消費税の確定申告書(控)", s.h - 60)
    s.text(40, s.h - 100, "課税期間 自 令和6年4月1日 至 令和7年3月31日")
    s.text(40, s.h - 118, "名称:株式会社さくら建設")
    s.text(40, s.h - 136, "顧問先コード:10001")
    s.text(s.w - 40, s.h - 100, "作成日:令和7年5月26日", right=True)
    rows = [
        ["項目", "金額(円)"],
        ["課税標準額", "120,815,000"],
        ["消費税額", "9,423,570"],
        ["控除対象仕入税額", "6,912,300"],
        ["差引税額", "2,511,200"],
        ["地方消費税 譲渡割額", "708,300"],
        ["消費税及び地方消費税の合計納付税額", "3,219,500"],
    ]
    s.table(40, s.h - 170, [330, 180], rows, aligns=["l", "r"])
    s.save()


# ------------------------------------------------------------------
# 5. 源泉所得税の納付書(有限会社みなと商店)
# ------------------------------------------------------------------
def withholding():
    s = Sheet("scan_0005.pdf", landscape(A4))
    s.title("給与所得・退職所得等の所得税徴収高計算書(納付書)", s.h - 60)
    s.text(40, s.h - 100, "令和7年10月分")
    s.text(40, s.h - 118, "氏名又は名称:有限会社みなと商店")
    s.text(40, s.h - 136, "顧問先コード:10002")
    s.text(s.w - 40, s.h - 100, "作成日:令和7年11月5日", right=True)
    rows = [
        ["区分", "人員", "支給額(円)", "税額(円)"],
        ["俸給・給料等", "6", "1,824,000", "48,210"],
        ["賞与", "0", "0", "0"],
        ["本税", "", "", "48,210"],
        ["合計額", "", "", "48,210"],
    ]
    s.table(40, s.h - 160, [220, 80, 180, 180], rows, aligns=["l", "r", "r", "r"])
    s.save()


# ------------------------------------------------------------------
# 6. 源泉徴収票(株式会社あおば食品)
# ------------------------------------------------------------------
def year_end():
    s = Sheet("scan_0006.pdf")
    s.title("令和6年分 給与所得の源泉徴収票(控)", s.h - 60)
    s.text(40, s.h - 100, "支払者 名称:株式会社あおば食品")
    s.text(40, s.h - 118, "顧問先コード:10004")
    s.text(40, s.h - 136, "受給者 氏名:山田 花子(架空)")
    s.text(40, s.h - 154, "住所:東京都架空区みどり町1-2-3")
    s.text(40, s.h - 172, "個人番号:1234 5678 9012(ダミー)")
    s.text(320, s.h - 172, "生年月日:昭和60年5月1日")
    s.text(s.w - 40, s.h - 100, "作成日:令和7年1月20日", right=True)
    rows = [
        ["項目", "金額(円)"],
        ["支払金額", "4,560,000"],
        ["給与所得控除後の金額", "3,192,000"],
        ["所得控除の額の合計額", "1,210,000"],
        ["源泉徴収税額", "86,400"],
    ]
    s.table(40, s.h - 200, [260, 160], rows, aligns=["l", "r"])
    s.save()


# ------------------------------------------------------------------
# 7. 要確認になる例(顧問先・期間が書かれていない打合せメモ)
# ------------------------------------------------------------------
def unknown_memo():
    s = Sheet("scan_0007.pdf")
    s.title("打合せメモ", s.h - 60)
    lines = [
        "・来期の設備投資について相談あり",
        "・借入の返済予定表を次回までに用意してもらう",
        "・役員報酬の改定は次回の打合せで検討",
    ]
    for i, l in enumerate(lines):
        s.text(60, s.h - 120 - i * 22, l, 11)
    s.save()


# ------------------------------------------------------------------
# 8. 表記ゆれの例:コードなし・「(株)」表記・西暦 → マスタ照合でそろう
# ------------------------------------------------------------------
def monthly_variant():
    monthly_trial_balance("scan_0008.pdf", month="2025年4月分", created="2025/05/14",
                          code="", name="顧問先名:(株)さくら建設")


# ------------------------------------------------------------------
# 9. 重複の例:scan_0001 と同じ書類を、もう一度保存してしまったケース
# ------------------------------------------------------------------
def duplicate():
    monthly_trial_balance("scan_0009.pdf")


# ------------------------------------------------------------------
# 10. スキャンした紙の書類の例(文字情報が無く、画像だけのPDF)
#     ローカルAI版の「画像の文字起こし」のテストに使う(local/samples に出力)
# ------------------------------------------------------------------
def scanned_image():
    from io import BytesIO
    from PIL import Image, ImageDraw, ImageFont
    from reportlab.lib.utils import ImageReader
    font_path = next(f for f in FONT_CANDIDATES if Path(f).exists())
    W, H = 1240, 1754  # A4 を 150dpi で読み取った大きさ
    img = Image.new("RGB", (W, H), (250, 249, 245))
    d = ImageDraw.Draw(img)
    big, mid = ImageFont.truetype(font_path, 44), ImageFont.truetype(font_path, 28)
    d.text((W // 2, 150), "月次試算表(損益計算書)", font=big, fill=(20, 20, 20), anchor="mm")
    lines = ["顧問先コード:10001", "顧問先名:株式会社さくら建設", "令和7年5月分", "作成日:令和7年6月12日"]
    for i, t in enumerate(lines):
        d.text((120, 260 + i * 48), t, font=mid, fill=(30, 30, 30))
    rows = [("売上高", "11,920,000"), ("売上原価", "8,410,300"), ("売上総利益", "3,509,700"), ("営業利益", "1,402,100")]
    for i, (k, v) in enumerate(rows):
        y = 520 + i * 56
        d.rectangle((120, y, 1120, y + 56), outline=(60, 60, 60), width=2)
        d.text((140, y + 12), k, font=mid, fill=(30, 30, 30))
        d.text((1100, y + 12), v, font=mid, fill=(30, 30, 30), anchor="ra")
    d.text((W - 80, H - 80), "サンプル会計事務所  ※デモ用の架空データです", font=ImageFont.truetype(font_path, 20), fill=(90, 90, 90), anchor="rs")
    img = img.rotate(0.6, expand=False, fillcolor=(250, 249, 245))  # 少し傾いた、スキャンらしい画像
    buf = BytesIO()
    img.save(buf, "JPEG", quality=80)
    out = Path(__file__).resolve().parent.parent / "local" / "samples"
    out.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(out / "scan_image_0001.pdf"), pagesize=A4)
    buf.seek(0)
    c.drawImage(ImageReader(buf), 0, 0, width=A4[0], height=A4[1])
    c.showPage()
    c.save()
    print("出力:", out / "scan_image_0001.pdf")


if __name__ == "__main__":
    for fn in [monthly_trial_balance, financial_statements, corporate_tax,
               consumption_tax, withholding, year_end, unknown_memo,
               monthly_variant, duplicate]:
        fn()
    scanned_image()
    print("出力先:", OUT)
    for p in sorted(OUT.glob("*.pdf")):
        print(" -", p.name)
