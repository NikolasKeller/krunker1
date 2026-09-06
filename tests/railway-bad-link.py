"""Measure the deployed candidate from inside Railway, using Node only.

After the patch is committed and deployed:
  python3 tests/railway-bad-link.py --expect-revision <full candidate SHA>
  python3 tests/railway-bad-link.py --collect

Creates its own game rooms; refuses to benchmark a different revision or an
occupied server. Does not deploy. Requires a working Railway CLI login.
"""
import argparse
import base64
import json
import pathlib
import re
import shlex
import subprocess

root = pathlib.Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--expect-revision')
parser.add_argument('--collect', action='store_true')
parser.add_argument('--origin', default='https://krunker1-production.up.railway.app')
args = parser.parse_args()


def ssh(script):
    result = subprocess.run(['railway', 'ssh', '--', 'node -e ' + shlex.quote(script)],
                            cwd=root, text=True, capture_output=True)
    if result.returncode:
        raise SystemExit(result.stderr or result.stdout)
    return result.stdout


remote = '/tmp/arena-bad-link-verification'
if args.collect:
    output = ssh("const fs=require('fs');for(const name of ['status','load-0','load-80','websocket']){const p=" +
                 json.dumps(remote) + "+'/'+name+'.json';if(fs.existsSync(p))console.log(JSON.stringify({name,data:JSON.parse(fs.readFileSync(p,'utf8'))}));}")
    for line in output.splitlines():
        if not line.startswith('{'):
            continue
        item = json.loads(line)
        path = root / ('artifacts/bad-link/railway-' + item['name'] + '.json')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(item['data'], indent=2) + '\n')
        print(path)
    raise SystemExit()

if not args.expect_revision or not re.fullmatch('[0-9a-f]{40}', args.expect_revision):
    parser.error('--expect-revision requires the full deployed candidate SHA')

bundles = {}
for name, source in [('load', 'tests/load.ts'), ('websocket', 'tests/bad-link-websocket.ts')]:
    target = pathlib.Path('/tmp/arena-bad-link-' + name + '.mjs')
    subprocess.run([str(root / 'node_modules/.bin/esbuild'), source, '--bundle', '--platform=node',
                    '--format=esm', '--packages=external', '--minify', '--outfile=' + str(target)], cwd=root, check=True)
    bundles[name + '.mjs'] = base64.b64encode(target.read_bytes()).decode()

controller = """const fs=require('fs'),{spawnSync}=require('child_process');
(async()=>{
 const origin=ORIGIN,expected=REVISION,dir=DIRECTORY;
 const health=await(await fetch(origin+'/api/health')).json();
 if(health.revision!==expected)throw Error('Deploy the candidate first: '+JSON.stringify({expected,actual:health.revision}));
 if(health.players!==0)throw Error('Other players are connected; an isolated server is required.');
 const results=[];
 for(const name of ['load-0','load-80','websocket']){
   const load=name.startsWith('load');
   const env={...process.env,GAME_URL:origin,LOAD_COUNTS:'2,5,10',LOAD_SECONDS:'30',LOAD_BOTS:'7',LOAD_LATENCY_MS:name==='load-80'?'80':'0',LOAD_REPORT:dir+'/'+name+'.json',BAD_LINK_REPORT:dir+'/'+name+'.json'};
   const child=spawnSync(process.execPath,[dir+'/'+(load?'load':'websocket')+'.mjs'],{stdio:'inherit',env});
   results.push({name,status:child.status});
   fs.writeFileSync(dir+'/status.json',JSON.stringify({done:false,revision:expected,results}));
   if(child.status!==0)throw Error(name+' failed; inspect '+dir+'/run.log');
 }
 fs.writeFileSync(dir+'/status.json',JSON.stringify({done:true,revision:expected,results}));
})().catch(error=>{console.error(error);fs.writeFileSync(DIRECTORY+'/status.json',JSON.stringify({done:true,error:String(error)}));});
""".replace('ORIGIN', json.dumps(args.origin)).replace('REVISION', json.dumps(args.expect_revision)).replace('DIRECTORY', json.dumps(remote))

launcher = """const fs=require('fs'),{spawn}=require('child_process');
const dir=DIRECTORY,bundles=BUNDLES;
fs.mkdirSync(dir,{recursive:true});
// External ws resolves to the application's installed dependency under Node 22.
if(!fs.existsSync(dir+'/node_modules'))fs.symlinkSync('/app/node_modules',dir+'/node_modules','dir');
for(const [name,data] of Object.entries(bundles))fs.writeFileSync(dir+'/'+name,Buffer.from(data,'base64'));
fs.writeFileSync(dir+'/controller.cjs',CONTROLLER);
for(const name of ['status','load-0','load-80','websocket'])fs.rmSync(dir+'/'+name+'.json',{force:true});
fs.writeFileSync(dir+'/status.json',JSON.stringify({done:false}));
const log=fs.openSync(dir+'/run.log','w');
const child=spawn(process.execPath,[dir+'/controller.cjs'],{detached:true,stdio:['ignore',log,log]});
child.unref();console.log(JSON.stringify({pid:child.pid,directory:dir}));
""".replace('DIRECTORY', json.dumps(remote)).replace('BUNDLES', json.dumps(bundles)).replace('CONTROLLER', json.dumps(controller))
print(ssh(launcher))
print('Allow about six minutes, then run: python3 tests/railway-bad-link.py --collect')
