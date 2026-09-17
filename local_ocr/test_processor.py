import io
import json
import threading
import unittest
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer

from PIL import Image,ImageDraw
from pypdf import PdfReader
from .processor import layout_reason,text_lines,text_pdf
from .server import make_handler,allowed_origin


class PageTests(unittest.TestCase):
    def fixture(self):
        image=Image.new('RGB',(300,200),'white')
        ImageDraw.Draw(image).rectangle((20,20,200,40),fill='black')
        boxes=[{'label':'text','score':0.99,'coordinate':[20,20,200,40]}]
        ocr={'rec_texts':['清晰的中文测试'],'rec_scores':[0.999], 'rec_polys':[[[20,20],[200,20],[200,40],[20,40]]], 'dt_polys':[0]}
        return image,boxes,ocr

    def test_graphics_formulas_unknown_and_low_confidence_keep_images(self):
        for label in ['image','table','formula','figure_title','unknown']:
            self.assertEqual(layout_reason([{'label':label,'score':0.99}]),'non-text-layout')
        image,boxes,ocr=self.fixture();ocr['rec_scores']=[0.8]
        self.assertEqual(text_lines(image,boxes,ocr)[0],'uncertain-text')
        ocr['rec_scores']=[0.999];ocr['rec_texts']=['速度v等于位移除以时间']
        self.assertEqual(text_lines(image,boxes,ocr)[0],'possible-formula')

    def test_uncovered_content_and_rotated_lines_are_not_deleted(self):
        image,boxes,ocr=self.fixture();ImageDraw.Draw(image).rectangle((20,80,200,100),fill='black')
        self.assertEqual(text_lines(image,boxes,ocr)[0],'uncovered-content')
        image,boxes,ocr=self.fixture();ocr['rec_polys'][0][1][1]=35
        self.assertEqual(text_lines(image,boxes,ocr)[0],'rotated-text')

    def test_positioned_chinese_text_is_searchable_without_a_page_image(self):
        image,boxes,ocr=self.fixture();reason,lines=text_lines(image,boxes,ocr)
        self.assertIsNone(reason)
        # Use a realistic character width for the render check.
        lines[0]['box']=[20,20,160,40]
        data=text_pdf(image,lines);reader=PdfReader(io.BytesIO(data))
        self.assertEqual(len(reader.pages),1);self.assertEqual(len(reader.pages[0].images),0)
        self.assertIn('清晰的中文测试',reader.pages[0].extract_text())

    def test_loopback_service_rejects_cross_site_missing_token_and_oversize(self):
        class Fake:
            def process(self,raw):return {'kind':'image','reason':'non-text-layout'}
        server=ThreadingHTTPServer(('127.0.0.1',0),make_handler(Fake(),'a'*64))
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        base=f'http://127.0.0.1:{server.server_port}'
        headers={'Host':'127.0.0.1:8765','Authorization':'Bearer '+'a'*64}
        try:
            with urllib.request.urlopen(urllib.request.Request(base+'/health',headers=headers)) as response:
                self.assertTrue(json.load(response)['ready'])
            for route,changes,data,code in [('/health',{'Authorization':''},None,403),('/health',{'Origin':'https://evil.test'},None,403),('/page',{'Content-Length':str(26*1024*1024)},b'x',413)]:
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    urllib.request.urlopen(urllib.request.Request(base+route,headers={**headers,**changes},data=data))
                self.assertEqual(caught.exception.code,code)
        finally:server.shutdown();server.server_close()
        self.assertTrue(allowed_origin('chrome-extension://'+'a'*32));self.assertFalse(allowed_origin('null'))


if __name__=='__main__':unittest.main()
