"""Verify workspace candidate bundles on an isolated loopback server inside Railway.
No deploy/browser. Bundles and reports are identified by SHA-256, not a claimed commit.
Run this file, then --collect; SSH must already be authenticated.
"""
import argparse
import base64
import gzip
import hashlib
import json
import pathlib
import shlex
import subprocess

root = pathlib.Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--collect', action='store_true')
parser.add_argument('--resume-probes', action='store_true', help='Resume failed probes, retaining successful checks only when their bundle hashes match')
args = parser.parse_args()
artifacts = root / 'artifacts/fairness'
artifacts.mkdir(parents=True, exist_ok=True)


def ssh(script):
    result = subprocess.run(['railway', 'ssh', '--', 'node -e ' + shlex.quote(script)], cwd=root, text=True, capture_output=True, timeout=60)
    if result.returncode:
        raise SystemExit(result.stderr or result.stdout)
    return result.stdout


if args.collect:
    directory = json.loads((artifacts / 'railway-launch.json').read_text())['directory']
    output = ssh("const fs=require('fs'),dir=" + json.dumps(directory) + ";for(const name of ['status','load-0','load-80','bad-link','hitscan','remote']){const p=dir+'/'+name+'.json';if(fs.existsSync(p))console.log(JSON.stringify({name,data:JSON.parse(fs.readFileSync(p,'utf8'))}));}")
    for line in output.splitlines():
        if line.startswith('{'):
            item = json.loads(line)
            (artifacts / ('railway-' + item['name'] + '.json')).write_text(json.dumps(item['data'], indent=2) + '\n')
            print(item['name'], 'collected')
    raise SystemExit()

previous = json.loads((artifacts / 'railway-launch.json').read_text()) if args.resume_probes else None
bundles = {}
for name, source in [('server', 'src/server/index.ts'), ('load', 'tests/load.ts'), ('bad-link', 'tests/bad-link-websocket.ts'), ('hitscan', 'tests/hitscan-websocket.ts'), ('remote', 'tests/remote-report.ts')]:
    target = pathlib.Path('/tmp/arena-fairness-' + name + '.mjs')
    # Bundling an imported server otherwise turns its CLI entry guard into the
    # probe's entry guard and tries to bind the production PORT.
    defines = ['--define:import.meta.url="file:///arena-test-library.ts"'] if name == 'hitscan' else []
    subprocess.run([str(root / 'node_modules/.bin/esbuild'), source, *defines, '--bundle', '--platform=node', '--format=esm', '--packages=external', '--minify', '--outfile=' + str(target)], cwd=root, check=True)
    bundles[name + '.mjs'] = target.read_bytes()
hashes = {name: hashlib.sha256(data).hexdigest() for name, data in bundles.items()}
directory = '/tmp/arena-fairness-' + hashes['server.mjs'][:12]
if previous:
    assert previous['directory'] == directory, 'Server changed: run the complete matrix again'
    for name in ['server.mjs', 'load.mjs', 'bad-link.mjs', 'remote.mjs']:
        assert previous['hashes'][name] == hashes[name], 'Previously passed bundle changed: ' + name
base = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
bootstrap = """import {createGameServer} from './server.mjs';
import fs from 'node:fs';
const app=createGameServer();
app.server.listen(0,'127.0.0.1',()=>fs.writeFileSync(new URL('./ready.json',import.meta.url),JSON.stringify({port:app.server.address().port})));
process.on('SIGTERM',()=>app.close().then(()=>process.exit(0)));
"""
controller = r"""const fs=require('fs'),{spawn,spawnSync}=require('child_process'),crypto=require('crypto');
const dir=DIRECTORY,hashes=HASHES,base=BASE;
const results=RESUME?JSON.parse(fs.readFileSync(dir+'/status.json')).results.filter(r=>r.status===0):[];
const write=(extra)=>fs.writeFileSync(dir+'/status.json',JSON.stringify({node:process.version,base,hashes,results,...extra}));
let server;
(async()=>{
 for(const [name,hash] of Object.entries(hashes))if(crypto.createHash('sha256').update(fs.readFileSync(dir+'/'+name)).digest('hex')!==hash)throw Error('Bundle mismatch: '+name);
 fs.rmSync(dir+'/ready.json',{force:true});
 server=spawn(process.execPath,[dir+'/bootstrap.mjs'],{stdio:'inherit',env:{...process.env,RAILWAY_GIT_COMMIT_SHA:undefined}});
 for(let n=0;!fs.existsSync(dir+'/ready.json');n++){if(n>200)throw Error('server startup timed out');await new Promise(r=>setTimeout(r,50));}
 const origin='http://127.0.0.1:'+JSON.parse(fs.readFileSync(dir+'/ready.json')).port;
 write({done:false,origin});
 for(const name of ['load-0','load-80','bad-link','hitscan','remote']){
  if(results.some(r=>r.name===name&&r.status===0))continue;
  const source=name.startsWith('load')?'load':name;
  const env={...process.env,GAME_URL:origin,LOAD_COUNTS:'2,5,10',LOAD_SECONDS:'30',LOAD_BOTS:'7',LOAD_LATENCY_MS:name==='load-80'?'80':'0',LOAD_REPORT:dir+'/'+name+'.json',BAD_LINK_REPORT:dir+'/'+name+'.json',HIT_REPORT:dir+'/'+name+'.json',REMOTE_REPORT:dir+'/'+name+'.json'};
  const child=spawnSync(process.execPath,[dir+'/'+source+'.mjs'],{stdio:'inherit',env});
  results.push({name,status:child.status});write({done:false,origin});
  if(child.status!==0)throw Error(name+' failed: '+child.status);
 }
 write({done:true,origin});
})().catch(error=>{console.error(error);write({done:true,error:String(error)});}).finally(()=>server?.kill('SIGTERM'));
""".replace('DIRECTORY', json.dumps(directory)).replace('HASHES', json.dumps(hashes)).replace('BASE', json.dumps(base)).replace('RESUME', json.dumps(args.resume_probes))
print(ssh("const fs=require('fs'),dir=" + json.dumps(directory) + ";fs.mkdirSync(dir,{recursive:true});if(!fs.existsSync(dir+'/node_modules'))fs.symlinkSync('/app/node_modules',dir+'/node_modules','dir');console.log(dir);"))
# Small independent chunks stay below SSH/exec argument limits.
for name, data in bundles.items():
    if previous and previous['hashes'].get(name) == hashes[name]:
        continue
    print('Uploading', name, len(data), flush=True)
    encoded = base64.b64encode(gzip.compress(data, mtime=0)).decode()
    for index in range(0, len(encoded), 24000):
        mode = 'writeFileSync' if index == 0 else 'appendFileSync'
        ssh("require('fs')." + mode + '(' + json.dumps(directory + '/' + name + '.gz') + ",Buffer.from(" + json.dumps(encoded[index:index + 24000]) + ",'base64'));")
    ssh("const fs=require('fs'),p=" + json.dumps(directory + '/' + name) + ";fs.writeFileSync(p,require('zlib').gunzipSync(fs.readFileSync(p+'.gz')));fs.rmSync(p+'.gz');")
launch = "const fs=require('fs'),{spawn}=require('child_process'),dir=" + json.dumps(directory) + ';'
launch += "fs.writeFileSync(dir+'/bootstrap.mjs'," + json.dumps(bootstrap) + ");fs.writeFileSync(dir+'/controller.cjs'," + json.dumps(controller) + ');'
launch += "const log=fs.openSync(dir+'/run.log','w'),child=spawn(process.execPath,[dir+'/controller.cjs'],{detached:true,stdio:['ignore',log,log]});child.unref();console.log(JSON.stringify({pid:child.pid,directory:dir}));"
output = ssh(launch)
for line in output.splitlines():
    if line.startswith('{'):
        item = json.loads(line)
        (artifacts / 'railway-launch.json').write_text(json.dumps({**item, 'base': base, 'hashes': hashes}, indent=2) + '\n')
print(output)
print('Collect in about seven minutes: python3 tests/railway-fairness.py --collect')
