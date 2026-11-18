"""인쇄 원본 PDF → 추적 타깃용 PNG (재현용).

    python -I scripts/render_poster.py

reference/CURT_*_Poster.pdf 한 쪽을 1.5배(2526x3576)로 렌더링해
reference/poster_print_master_2526x3576.png 로 저장한다. PyMuPDF 가 필요하다 (pip install pymupdf).
QR 스티커를 붙이기 전의 원본을 그대로 렌더링한다. 타깃을 자르고 QR 자리를 가리는 일은
apps/web-ar/tools/compile-target.html 이 한다.
"""
import glob
import os
import sys

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
pdfs = glob.glob(os.path.join(root, "reference", "CURT_*Poster.pdf"))
if not pdfs:
    sys.exit("reference/ 에 포스터 PDF 가 없습니다.")
try:
    import fitz  # PyMuPDF
except ImportError:
    sys.exit("PyMuPDF 가 필요합니다: pip install pymupdf")

page = fitz.open(pdfs[0])[0]
w_mm, h_mm = page.rect.width / 72 * 25.4, page.rect.height / 72 * 25.4
print(f"page {w_mm:.1f} x {h_mm:.1f} mm (A1 = 594 x 841)")
pix = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)
out = os.path.join(root, "reference", f"poster_print_master_{pix.width}x{pix.height}.png")
pix.save(out)
print("wrote", out)
