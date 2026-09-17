"""Loopback-only service. Documents stay local; connection tokens are never logged."""
import argparse
import hmac
import json
import re
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = 8765
MAX_BODY = 25 * 1024 * 1024


def allowed_origin(origin):
    return not origin or bool(re.fullmatch(r'chrome-extension://[a-p]{32}',origin))


def make_handler(processor, token):
    lock=threading.Lock()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):
            pass

        def reply(self,status,data):
            body=json.dumps(data).encode('utf-8')
            self.send_response(status)
            origin=self.headers.get('Origin','')
            if origin and allowed_origin(origin):
                self.send_header('Access-Control-Allow-Origin',origin)
                self.send_header('Vary','Origin')
            self.send_header('Cache-Control','no-store')
            self.send_header('Content-Type','application/json')
            self.send_header('Content-Length',str(len(body)))
            self.end_headers()
            try:self.wfile.write(body)
            except (BrokenPipeError,ConnectionResetError):pass

        def permitted(self):
            return (self.headers.get('Host')==f'127.0.0.1:{PORT}'
                and allowed_origin(self.headers.get('Origin',''))
                and hmac.compare_digest(self.headers.get('Authorization',''),f'Bearer {token}'))

        def do_OPTIONS(self):
            if self.headers.get('Host')!=f'127.0.0.1:{PORT}' or not allowed_origin(self.headers.get('Origin','')):
                self.reply(403,{'error':'forbidden'});return
            self.send_response(204)
            self.send_header('Access-Control-Allow-Origin',self.headers.get('Origin',''))
            self.send_header('Access-Control-Allow-Methods','GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers','Authorization, Content-Type')
            self.end_headers()

        def do_GET(self):
            if not self.permitted():self.reply(403,{'error':'forbidden'});return
            if self.path!='/health':self.reply(404,{'error':'not-found'});return
            self.reply(200,{'schema':1,'ready':True,'engine':'local-paddleocr'})

        def do_POST(self):
            if not self.permitted():self.reply(403,{'error':'forbidden'});return
            if self.path!='/page':self.reply(404,{'error':'not-found'});return
            try:size=int(self.headers.get('Content-Length','0'))
            except ValueError:size=0
            if not 0<size<=MAX_BODY:self.reply(413,{'error':'size'});return
            if not lock.acquire(blocking=False):self.reply(409,{'error':'busy'});return
            try:
                self.connection.settimeout(120)
                raw=self.rfile.read(size)
                if len(raw)!=size:raise ValueError('incomplete')
                self.reply(200,processor.process(raw))
            except Exception:
                self.reply(500,{'error':'processing-failed'})
            finally:lock.release()
    return Handler


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--prepare-only',action='store_true');args=parser.parse_args()
    root=Path(__file__).resolve().parents[1];work=root/'work';work.mkdir(exist_ok=True)
    from .processor import Processor
    print('正在加载本地OCR和版面识别模型；首次使用需下载模型。',flush=True)
    processor=Processor(work/'ocr-models')
    if args.prepare_only:print('本地OCR模型已就绪。',flush=True);return
    token=secrets.token_hex(32)
    server=ThreadingHTTPServer(('127.0.0.1',PORT),make_handler(processor,token))
    connection=work/'ocr-connection.json'
    connection.write_text(json.dumps({'schema':1,'token':token}),encoding='utf-8')
    print('本地OCR已就绪。在助手中选择 work/ocr-connection.json 连接文件。',flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close()


if __name__=='__main__':main()
