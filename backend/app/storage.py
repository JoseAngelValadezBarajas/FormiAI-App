from __future__ import annotations
import json, sqlite3
from pathlib import Path

class Store:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True); self.path = path
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, source_name TEXT NOT NULL, output_dir TEXT NOT NULL, command_json TEXT NOT NULL, message TEXT NOT NULL DEFAULT "", session_id TEXT)')
            db.execute('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, artifact_dir TEXT NOT NULL, status TEXT NOT NULL)')
    def connect(self): return sqlite3.connect(self.path)
    def job(self, id: str, status: str, source_name: str, output_dir: Path, command: list[str]) -> None:
        with self.connect() as db: db.execute('INSERT INTO jobs VALUES (?,?,?,?,?,?,NULL)',(id,status,source_name,str(output_dir),json.dumps(command),''))
    def update_job(self,id:str,status:str,message:str,session_id:str|None=None)->None:
        with self.connect() as db: db.execute('UPDATE jobs SET status=?,message=?,session_id=? WHERE id=?',(status,message,session_id,id))
    def get_job(self,id:str):
        with self.connect() as db:
            row=db.execute('SELECT id,status,source_name,output_dir,command_json,message,session_id FROM jobs WHERE id=?',(id,)).fetchone()
        return None if not row else dict(zip(('id','status','source_name','output_dir','command_json','message','session_id'),row))
    def processing_jobs(self):
        with self.connect() as db:
            rows=db.execute("SELECT id,status,source_name,output_dir,command_json,message,session_id FROM jobs WHERE status='processing'").fetchall()
        fields=('id','status','source_name','output_dir','command_json','message','session_id')
        return [dict(zip(fields,row)) for row in rows]
    def session(self,id:str,artifact_dir:Path,status:str='ready')->None:
        with self.connect() as db: db.execute('INSERT OR REPLACE INTO sessions VALUES (?,?,?)',(id,str(artifact_dir),status))
    def get_session(self,id:str):
        with self.connect() as db: row=db.execute('SELECT id,artifact_dir,status FROM sessions WHERE id=?',(id,)).fetchone()
        return None if not row else dict(zip(('id','artifact_dir','status'),row))
