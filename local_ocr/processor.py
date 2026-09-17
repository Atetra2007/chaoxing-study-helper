"""Conservative page classification and positioned text PDF output.

Never remove an image page on OCR confidence alone: require a text-only layout,
horizontal text, supported glyphs, and coverage of the original page's dark ink.
"""
import base64
import io
import math
import os
import re
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

TEXT_LABELS = {'text', 'doc_title', 'paragraph_title', 'header', 'footer', 'number', 'page_number', 'abstract', 'reference', 'footnote'}
MATH = re.compile(r'[=+*/<>∑∫√^_α-ωΑ-Ω⁰¹²³⁴⁵⁶⁷⁸⁹₀-₉]|(?<![A-Za-z])[A-Za-z](?![A-Za-z])')
MAX_PIXELS = 32 * 1024 * 1024


def layout_reason(boxes):
    if not boxes:
        return 'uncertain-layout'
    for box in boxes:
        if box.get('label') not in TEXT_LABELS:
            return 'non-text-layout'
    if max(float(box.get('score',0)) for box in boxes) < 0.8:
        return 'uncertain-layout'
    return None


def text_lines(image, boxes, ocr):
    reason = layout_reason(boxes)
    if reason:
        return reason, []
    texts, scores, polys = ocr.get('rec_texts', []), ocr.get('rec_scores', []), ocr.get('rec_polys', [])
    detected = ocr.get('dt_polys', [])
    if not len(texts) or len(texts) != len(scores) or len(texts) != len(polys) or len(detected) != len(texts):
        return 'uncertain-text', []
    mask = Image.new('L', image.size)
    draw = ImageDraw.Draw(mask)
    lines = []
    for text, score, poly in zip(texts, scores, polys):
        if float(score) < 0.98 or not text.strip() or '\ufffd' in text:
            return 'uncertain-text', []
        if MATH.search(text):
            return 'possible-formula', []
        points = np.asarray(poly, dtype=float)
        if points.shape != (4, 2) or not np.isfinite(points).all():
            return 'uncertain-text', []
        angle = math.degrees(math.atan2(points[1, 1]-points[0, 1], points[1, 0]-points[0, 0]))
        if abs(angle) > 2:
            return 'rotated-text', []
        x1, y1 = points.min(axis=0); x2, y2 = points.max(axis=0)
        if not (0 <= x1 < x2 <= image.width and 0 <= y1 < y2 <= image.height):
            return 'uncertain-text', []
        draw.rectangle((max(0,x1-1), max(0,y1-1), min(image.width-1,x2+1), min(image.height-1,y2+1)), fill=255)
        lines.append({'text': text, 'box': [float(x1), float(y1), float(x2), float(y2)]})
    # Watermarks, diagrams, borders or missed lines must not silently disappear.
    ink = np.asarray(image.convert('L')) < 210
    uncovered = np.count_nonzero(ink & (np.asarray(mask) == 0))
    if uncovered > max(20, np.count_nonzero(ink) * 0.015):
        return 'uncovered-content', []
    # Initial release handles a single text column only; preserve complex columns.
    blocks = [b['coordinate'] for b in boxes if b['label'] == 'text']
    for a in blocks:
        for b in blocks:
            if a[2] < b[0] and min(a[3],b[3])-max(a[1],b[1]) > 30:
                return 'complex-columns', []
    return None, sorted(lines, key=lambda line: (round(line['box'][1]/5), line['box'][0]))


def register_font():
    if 'StudyChinese' not in pdfmetrics.getRegisteredFontNames():
        font = Path(os.environ.get('WINDIR', r'C:\Windows')) / 'Fonts' / 'simsun.ttc'
        pdfmetrics.registerFont(TTFont('StudyChinese', str(font), subfontIndex=0))


def text_pdf(image, lines):
    register_font()
    font = pdfmetrics.getFont('StudyChinese')
    if any(ord(c) not in font.face.charToGlyph for line in lines for c in line['text'] if not c.isspace()):
        raise ValueError('unsupported-glyph')
    width = 595.2755905511812; scale = width / image.width; height = image.height * scale
    output = io.BytesIO(); pdf = canvas.Canvas(output, pagesize=(width,height), pageCompression=1)
    pdf.setTitle('OCR positioned text page')
    for line in lines:
        x1,y1,x2,y2 = line['box']; text=line['text']
        size=(y2-y1)*scale
        measured=pdfmetrics.stringWidth(text,'StudyChinese',size)
        stretch=(x2-x1)*scale/measured
        if not 0.65 <= stretch <= 1.45:
            raise ValueError('uncertain-typesetting')
        obj=pdf.beginText(x1*scale,height-y2*scale+size*0.12)
        obj.setFont('StudyChinese',size);obj.setHorizScale(stretch*100);obj.textOut(text);pdf.drawText(obj)
    pdf.showPage();pdf.save()
    return output.getvalue()


class Processor:
    def __init__(self, model_root):
        os.environ['PADDLE_PDX_CACHE_HOME'] = str(model_root)
        names=['PP-DocLayout_plus-L','PP-OCRv5_mobile_det','PP-OCRv5_server_rec']
        if all((Path(model_root)/'official_models'/name/'inference.yml').exists() for name in names):
            os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK']='True'
        from paddleocr import LayoutDetection, PaddleOCR
        common = dict(device='cpu',enable_mkldnn=False,cpu_threads=8)
        # Standalone modules avoid loading unused chart/formula generation models.
        self.layout = LayoutDetection(model_name='PP-DocLayout_plus-L', threshold=0.3, **common)
        self.ocr = PaddleOCR(text_detection_model_name='PP-OCRv5_mobile_det',text_recognition_model_name='PP-OCRv5_server_rec',
            use_doc_orientation_classify=False,use_doc_unwarping=False,use_textline_orientation=False,**common)
        register_font()

    def process(self, raw):
        image=Image.open(io.BytesIO(raw))
        if image.width*image.height > MAX_PIXELS or image.format not in ('PNG','JPEG'):
            return {'kind':'image','reason':'unsupported-image'}
        image=image.convert('RGB'); array=np.asarray(image)[:,:,::-1].copy()
        boxes=self.layout.predict(array)[0]['boxes']
        reason=layout_reason(boxes)
        if reason:
            return {'kind':'image','reason':reason}
        result=self.ocr.predict(array)[0]
        reason,lines=text_lines(image,boxes,result)
        if reason:
            return {'kind':'image','reason':reason}
        try:
            data=text_pdf(image,lines)
        except ValueError:
            return {'kind':'image','reason':'uncertain-typesetting'}
        return {'kind':'text','reason':'text','pdf':base64.b64encode(data).decode('ascii'),'lines':len(lines)}
