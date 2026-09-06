"""Run/collect the public 2/5/10-player load matrices from inside Railway.

Run after deploying the candidate, from this Railway-linked checkout. The CLI
must already be authenticated. No browser, deployment or production game-state
mutation is performed by the launcher; the benchmark creates its own rooms.
"""
import argparse
import base64
import json
import pathlib
import re
import shlex
import subprocess

root = pathlib.Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--collect', action='store_true')
parser.add_argument('--expect-revision')
parser.add_argument('--origin', default='https://krunker1-production.up.railway.app')
args = parser.parse_args()


def ssh(script):
    return subprocess.run(['railway', 'ssh', '--', 'node -e ' + shlex.quote(script)],
                          cwd=root, text=True, capture_output=True, check=True).stdout


if args.collect:
    output = ssh("const fs=require('fs');for(const name of ['status','0','80']){const p='/tmp/playtest-load-'+name+'.json';if(fs.existsSync(p))console.log(JSON.stringify({name,data:JSON.parse(fs.readFileSync(p,'utf8'))}));}")
    for line in output.splitlines():
        if not line.startswith('{'):
            continue
        item = json.loads(line)
        path = root / ('artifacts/playtest-fixes/railway-' + item['name'] + '.json')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(item['data'], indent=2) + '\n')
        print(path)
    raise SystemExit()

if not args.expect_revision or not re.fullmatch('[0-9a-f]{40}', args.expect_revision):
    parser.error('--expect-revision requires the full deployed candidate commit SHA')

bundle = pathlib.Path('/tmp/playtest-load-client.mjs')
subprocess.run([str(root / 'node_modules/.bin/esbuild'), 'tests/load.ts', '--bundle',
                '--platform=node', '--format=esm', '--packages=external', '--minify',
                '--outfile=' + str(bundle)], cwd=root, check=True)
controller = """const fs=require('fs'),{spawnSync}=require('child_process');
(async()=>{
const origin=ORIGIN,expected=REVISION;
const health=await(await fetch(origin+'/api/health')).json();
if(health.revision!==expected)throw Error('Deploy the matching candidate first: '+JSON.stringify({expected,actual:health.revision}));
if(health.players!==0)throw Error('Other players are connected; the benchmark requires an isolated server.');
const results=[];
for(const latency of [0,80]){
 const child=spawnSync(process.execPath,['/app/playtest-load-client.mjs'],{stdio:'inherit',env:{...process.env,GAME_URL:origin,LOAD_COUNTS:'2,5,10',LOAD_SECONDS:'30',LOAD_BOTS:'7',LOAD_LATENCY_MS:String(latency),LOAD_REPORT:'/tmp/playtest-load-'+latency+'.json'}});
 results.push({latency,status:child.status});
 fs.writeFileSync('/tmp/playtest-load-status.json',JSON.stringify({done:false,revision:expected,results}));
 if(child.status!==0)throw Error('Load matrix failed; retain the report and inspect /tmp/playtest-load.log.');
}
fs.writeFileSync('/tmp/playtest-load-status.json',JSON.stringify({done:true,revision:expected,results}));
})().catch(e=>{console.error(e);fs.writeFileSync('/tmp/playtest-load-status.json',JSON.stringify({done:true,error:String(e)}));});""".replace('ORIGIN', json.dumps(args.origin)).replace('REVISION', json.dumps(args.expect_revision))
launcher = """const fs=require('fs'),{spawn}=require('child_process');
fs.writeFileSync('/app/playtest-load-client.mjs',Buffer.from(BUNDLE,'base64'));
fs.writeFileSync('/app/playtest-load-controller.cjs',CONTROLLER);
for(const n of ['status','0','80'])fs.rmSync('/tmp/playtest-load-'+n+'.json',{force:true});
fs.writeFileSync('/tmp/playtest-load-status.json',JSON.stringify({done:false}));
const log=fs.openSync('/tmp/playtest-load.log','w');
const child=spawn(process.execPath,['/app/playtest-load-controller.cjs'],{detached:true,stdio:['ignore',log,log]});
child.unref();console.log(JSON.stringify({pid:child.pid}));""".replace('BUNDLE', json.dumps(base64.b64encode(bundle.read_bytes()).decode())).replace('CONTROLLER', json.dumps(controller))
print(ssh(launcher))
print('Allow about four minutes, then run: python3 tests/railway-load.py --collect')
