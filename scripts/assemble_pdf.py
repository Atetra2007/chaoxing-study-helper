"""Build and verify an offline PDF from numbered PNG pages (no network access)."""

import argparse
import hashlib
import json
import re
from pathlib import Path

from PIL import Image, ImageChops
from pypdf import PdfReader
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--images-dir', required=True, type=Path)
    parser.add_argument('--expected-pages', required=True, type=int)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--title', required=True)
    parser.add_argument('--report', required=True, type=Path)
    args = parser.parse_args()
    if args.expected_pages < 1:
        raise ValueError('Expected page count must be positive')
    if args.output.exists() or args.report.exists():
        raise FileExistsError('Output or report exists; choose new paths')

    pages = {}
    for path in args.images_dir.iterdir():
        if not path.is_file():
            continue
        match = re.fullmatch(r'(\d+)\.png', path.name, re.IGNORECASE)
        if not match:
            continue
        number = int(match.group(1))
        if number in pages:
            raise ValueError(f'Duplicate numeric page number: {number}')
        pages[number] = path
    expected = set(range(1, args.expected_pages + 1))
    if set(pages) != expected:
        raise ValueError(f'Page mismatch: missing={sorted(expected - set(pages))}, '
                         f'extra={sorted(set(pages) - expected)}')

    records = []
    hashes = {}
    for number in sorted(pages):
        path = pages[number]
        with Image.open(path) as original:
            original.load()
            if original.format != 'PNG' or original.width < 100 or original.height < 100:
                raise ValueError(f'Invalid page image: {path.name}')
            rgb = original.convert('RGB')
            digest = hashlib.sha256(rgb.tobytes()).hexdigest()
            hashes.setdefault(digest, []).append(number)
            records.append({'page': number, 'width': rgb.width, 'height': rgb.height,
                            'pixel_sha256': digest})

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    pdf = canvas.Canvas(str(args.output), pageCompression=1)
    pdf.setTitle(args.title)
    pdf.setAuthor('')
    pdf.setSubject('Offline reading copy assembled from displayed course page images')
    for record in records:
        with Image.open(pages[record['page']]) as original:
            rgb = original.convert('RGB')
            page_width = 595.2755905511812
            page_height = page_width * rgb.height / rgb.width
            pdf.setPageSize((page_width, page_height))
            pdf.drawImage(ImageReader(rgb), 0, 0, width=page_width, height=page_height)
            key = f'page-{record["page"]}'
            pdf.bookmarkPage(key)
            pdf.addOutlineEntry(f'Page {record["page"]}', key, 0)
            pdf.showPage()
    pdf.save()

    # Reopen the file without any browser/network and compare every embedded image
    # with its corresponding source page, verifying count, order and pixel fidelity.
    reader = PdfReader(str(args.output))
    if len(reader.pages) != args.expected_pages:
        raise ValueError('PDF page count differs from the reader page count')
    for index, page in enumerate(reader.pages, start=1):
        embedded = list(page.images)
        if len(embedded) != 1:
            raise ValueError(f'Expected one page image on PDF page {index}')
        with Image.open(pages[index]) as original:
            rgb = original.convert('RGB')
            saved = embedded[0].image.convert('RGB')
            if saved.size != rgb.size or ImageChops.difference(rgb, saved).getbbox():
                raise ValueError(f'Embedded image mismatch on PDF page {index}')
        records[index - 1]['embedded_pixels_match'] = True

    report = {
        'expected_pages': args.expected_pages,
        'pdf_pages': len(reader.pages),
        'page_sequence': list(range(1, args.expected_pages + 1)),
        'pdf_bytes': args.output.stat().st_size,
        'pdf_sha256': hashlib.sha256(args.output.read_bytes()).hexdigest(),
        'duplicate_pixel_groups': [nums for nums in hashes.values() if len(nums) > 1],
        'offline_parse': True,
        'all_embedded_images_match': True,
        'visual_review': 'pending',
        'pages': records,
    }
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: v for k, v in report.items() if k != 'pages'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
