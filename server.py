from __future__ import annotations

import json, os, subprocess, threading, uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).parent
RESEARCH = Path(os.environ.get('FORMIAI_RESEARCH_ROOT', r'C:\Dev\Ants-2'))
DEFAULT = RESEARCH / 'artifacts' / 'analysis' / 'va_001_031026_1'
jobs: dict[str, dict] = {}

class App(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        return str(ROOT / 'web' / path.lstrip('/'))
    def do_GET(self):
        path=urlparse(self.path).path
        if path == '/api/session':
            analysis = DEFAULT / 'analysis.json'
            if not analysis.exists(): return self.send_error(404, 'No analysis artifact configured')
            run=json.loads(analysis.read_text(encoding='utf-8'))
            body=json.dumps({'analysis':run,'artifacts':{n:f'/artifact/{n}' for n in ['analyzed_video.mp4','occupancy_heatmap.png','activity_timeline.csv','analysis.json','analysis_summary.md']},'detectorStatus':'experimental detector','researchStatus':'not a scientific champion'},allow_nan=False).encode()
            self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body); return
        if path.startswith('/api/jobs/'):
            body=json.dumps(jobs.get(path.rsplit('/',1)[-1], {'state':'missing'})).encode(); self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body); return
        if path.startswith('/artifact/'):
            file=DEFAULT / Path(path).name
            if not file.is_file(): return self.send_error(404)
            self.send_response(200); self.send_header('Content-Type', 'video/mp4' if file.suffix=='.mp4' else 'image/png' if file.suffix=='.png' else 'application/octet-stream'); self.send_header('Content-Length',str(file.stat().st_size)); self.end_headers(); self.wfile.write(file.read_bytes()); return
        if path == '/': self.path='/index.html'
        return super().do_GET()
    def do_POST(self):
        if urlparse(self.path).path != '/api/analyze': return self.send_error(404)
        length=int(self.headers.get('Content-Length','0')); payload=json.loads(self.rfile.read(length) or b'{}'); video=Path(payload.get('videoPath',''))
        if not video.is_file(): return self.send_error(400, 'videoPath must point to a readable local video')
        job=uuid.uuid4().hex; output=Path(os.environ.get('FORMIAI_RUNS_ROOT', str(ROOT/'runs'))) / job; jobs[job]={'state':'processing','videoPath':str(video),'output':str(output),'detector':'own_colony (available adapter)'}
        def run():
            try:
                cmd=['uv','run','formicai','analyze-video',str(video),'--output',str(output),'--detector-role','own_colony','--confidence','0.25']
                done=subprocess.run(cmd,cwd=RESEARCH,capture_output=True,text=True,check=False)
                jobs[job].update(state='complete' if done.returncode==0 else 'failed', log=(done.stdout+done.stderr)[-4000:])
            except Exception as e: jobs[job].update(state='failed',log=str(e))
        threading.Thread(target=run,daemon=True).start(); body=json.dumps({'jobId':job}).encode(); self.send_response(202);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)

if __name__ == '__main__': ThreadingHTTPServer(('127.0.0.1',4173),App).serve_forever()
