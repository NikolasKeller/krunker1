"""Run the candidate's unchanged load matrices in an isolated process inside Railway.

python3 tests/railway-remote.py
python3 tests/railway-remote.py --collect

Uploads self-contained bundles to /tmp and uses the installed ws dependency.
The load runner checks isolation on the candidate's separate port. It records
live-service occupancy as background load and runs with reduced CPU priority.
Does not deploy or change /app. This is
a Railway runtime/loopback measurement; it does not measure public-edge latency.
"""
import argparse
import base64
import hashlib
import json
import pathlib
import shlex
import subprocess

root = pathlib.Path(__file__).resolve().parent.parent
out = root / 'artifacts/remote'
remote = '/tmp/arena-remote-verification'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--collect', action='store_true')
args = parser.parse_args()


def ssh(script):
    result = subprocess.run(['railway', 'ssh', '--', 'node -e ' + shlex.quote(script)], cwd=root, text=True, capture_output=True)
    if result.returncode:
        raise SystemExit(result.stderr or result.stdout)
    return result.stdout


out.mkdir(parents=True, exist_ok=True)
if args.collect:
    result = ssh("const fs=require('fs');for(const name of ['status','load-0','load-80']){const p=" + json.dumps(remote) + "+'/'+name+'.json';if(fs.existsSync(p))console.log(JSON.stringify({name,data:JSON.parse(fs.readFileSync(p,'utf8'))}));}")
    for line in result.splitlines():
        if line.startswith('{'):
            item = json.loads(line)
            path = out / ('railway-' + item['name'] + '.json')
            path.write_text(json.dumps(item['data'], indent=2) + '\n')
            print(path)
    raise SystemExit()

bundles = {}
hashes = {}
for name, source in [('server', 'src/server/index.ts'), ('load', 'tests/load.ts')]:
    target = pathlib.Path('/tmp/arena-remote-' + name + '.mjs')
    subprocess.run([str(root / 'node_modules/.bin/esbuild'), source, '--bundle', '--platform=node', '--format=esm', '--packages=external', '--minify', '--outfile=' + str(target)], cwd=root, check=True)
    data = target.read_bytes()
    bundles[name + '.mjs'] = base64.b64encode(data).decode()
    hashes[name] = hashlib.sha256(data).hexdigest()

manifest = {
    'baseRevision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
    'candidateSourceSha256': {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((root / 'src').rglob('*.ts'))},
    'bundleSha256': hashes,
    'vantage': 'inside Railway, isolated candidate server over loopback; live service unchanged',
}
controller = r"""
import { createGameServer } from './server.mjs';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const dir=DIRECTORY, manifest=MANIFEST;
const save = value => writeFileSync(dir+'/status.json', JSON.stringify({...manifest,node:process.version,...value}));
let app;
const results=[];
try {
 const health=await(await fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health')).json();
 app=createGameServer();
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+app.server.address().port;
 for(const latency of [0,80]){
  const live=await(await fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health')).json();
  save({done:false,origin,liveRevision:health.revision,backgroundPlayers:live.players,results});
  const status=await new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[dir+'/load.mjs'],{stdio:'inherit',env:{...process.env,GAME_URL:origin,LOAD_COUNTS:'2,5,10',LOAD_SECONDS:'30',LOAD_BOTS:'7',LOAD_LATENCY_MS:String(latency),LOAD_REPORT:dir+'/load-'+latency+'.json'}});
   child.once('error',reject);child.once('exit',resolve);
  });
  results.push({latency,status,backgroundPlayers:live.players});
  if(status!==0)throw Error('Load matrix failed: '+latency);
 }
 save({done:true,passed:true,origin,liveRevision:health.revision,results});
}catch(error){save({done:true,passed:false,error:String(error),results});console.error(error);}
finally{if(app)await app.close();}
""".replace('DIRECTORY', json.dumps(remote)).replace('MANIFEST', json.dumps(manifest))

launcher = r"""
const fs=require('fs'),{spawn}=require('child_process');
(async()=>{
 const dir=DIRECTORY;
 const health=await(await fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health')).json();
 fs.mkdirSync(dir,{recursive:true});
 const status=dir+'/status.json';
 if(fs.existsSync(status)&&!JSON.parse(fs.readFileSync(status)).done)throw Error('A verification run already exists; collect it first.');
 if(!fs.existsSync(dir+'/node_modules'))fs.symlinkSync('/app/node_modules',dir+'/node_modules','dir');
 for(const [name,data] of Object.entries(BUNDLES))fs.writeFileSync(dir+'/'+name,Buffer.from(data,'base64'));
 fs.writeFileSync(dir+'/controller.mjs',CONTROLLER);
 for(const name of ['load-0','load-80'])fs.rmSync(dir+'/'+name+'.json',{force:true});
 fs.writeFileSync(status,JSON.stringify({done:false}));
 const log=fs.openSync(dir+'/run.log','w');
 const child=spawn('nice',['-n','10',process.execPath,dir+'/controller.mjs'],{detached:true,stdio:['ignore',log,log]});
 child.unref();console.log(JSON.stringify({pid:child.pid,directory:dir,node:process.version,liveRevision:health.revision,backgroundPlayers:health.players}));
})().catch(e=>{console.error(e);process.exitCode=1;});
""".replace('DIRECTORY', json.dumps(remote)).replace('BUNDLES', json.dumps(bundles)).replace('CONTROLLER', json.dumps(controller))
result = ssh(launcher)
(out / 'railway-launch.json').write_text(json.dumps({'manifest': manifest, 'launcherOutput': result.strip()}, indent=2) + '\n')
print(result)
