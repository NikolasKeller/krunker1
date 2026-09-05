import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { WebSocketServer, WebSocket } from 'ws';
import { Room, type Actor } from './simulation';
import { CLASS_IDS } from '../shared/weapons';
import { MAX_PLAYERS, TICK_RATE, type ClientMessage, type PlayerPatch, type PlayerState, type ServerMessage } from '../shared/types';
interface Connection { ws:WebSocket;room?:Room;actor?:Actor;token?:string;baseline:Map<string,PlayerState>;snapshot:number;messages:number;strikes:number;pingAt:number;pongAt:number; }
export function createGameServer() {
  const rooms=new Map<string,Room>();
  const sessions=new Map<string,{room:Room;actor:Actor;expires:number;connection?:Connection}>();
  const connections=new Set<Connection>();
  const stats={tickRate:0,tickMs:0,peakTickMs:0,ticks:0,bytesOut:0,players:0,rooms:0};
  const root=path.resolve('dist/client');
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url??'/', 'http://localhost');
    if(url.pathname==='/api/health'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({ok:true,...stats,configuredTickRate:TICK_RATE,rooms:rooms.size,players:[...connections].filter(c=>c.actor).length}));return;}
    if(url.pathname==='/api/rooms'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify([...rooms.values()].map(r=>({id:r.id,players:[...r.players.values()].filter(a=>!a.state.bot).length,phase:r.round.phase,mode:r.round.mode}))));return;}
    try {
      let requestPath:string;try{requestPath=decodeURIComponent(url.pathname);}catch{res.writeHead(400);res.end();return;}
      let file=path.resolve(root,'.'+requestPath);if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
      if(!path.extname(file))file=path.join(root,'index.html');
      const info=await stat(file);if(!info.isFile())throw new Error('Not a file');
      const body=await readFile(file),mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2','.ttf':'font/ttf','.png':'image/png','.json':'application/json'};
      res.writeHead(200,{'content-type':mime[path.extname(file)]??'application/octet-stream','cache-control':file.includes('/assets/')?'public, max-age=31536000, immutable':'no-cache','x-content-type-options':'nosniff'});res.end(body);
    }catch{res.writeHead(404,{'content-type':'text/plain'});res.end('Client not built. Development: http://localhost:5173 · Production: npm run build && npm start');}
  });
  const wss=new WebSocketServer({server,path:'/ws',maxPayload:16384,perMessageDeflate:false});
  function send(c:Connection,m:ServerMessage){if(c.ws.readyState===WebSocket.OPEN&&c.ws.bufferedAmount<256000){const data=JSON.stringify(m);c.ws.send(data);stats.bytesOut+=Buffer.byteLength(data);}}
  wss.on('connection',ws=>{
    if(connections.size>=256){ws.close(1013,'Server full');return;}
    const c:Connection={ws,baseline:new Map(),snapshot:0,messages:0,strikes:0,pingAt:Date.now(),pongAt:Date.now()};connections.add(c);
    ws.on('pong',()=>{c.pongAt=Date.now();if(c.actor)c.actor.rtt=Math.min(1000,c.pongAt-c.pingAt);});
    ws.on('error',()=>{});
    ws.on('message',data=>{
      if(++c.messages>200){ws.close(1008,'Message rate exceeded');return;}
      let m:ClientMessage;try{m=JSON.parse(data.toString());}catch{ws.close(1008,'Invalid JSON');return;}if(!m||typeof m!=='object')return;
      const now=Date.now();
      if(m.type==='ping'){if(Number.isFinite(m.time))send(c,{type:'pong',time:m.time,serverTime:now});return;}
      if(m.type==='join'&&!c.actor){
        if(!CLASS_IDS.includes(m.classId)||!['blue','red'].includes(m.team))return;
        const id=String(m.room??'YARD-01').toUpperCase().replace(/[^A-Z0-9-]/g,'').slice(0,18)||'YARD-01';
        if(m.token&&sessions.has(m.token)){
          const s=sessions.get(m.token)!;if(s.room.id===id&&s.expires>now){if(s.connection&&s.connection!==c){s.connection.actor=undefined;s.connection.ws.close(4000,'Session resumed');}c.room=s.room;c.actor=s.actor;c.token=m.token;s.actor.connected=true;s.actor.queue=[];s.actor.lastSeq=s.actor.state.ack;s.expires=Infinity;s.connection=c;if(!s.room.host)s.room.host=s.actor.state.id;if(s.room.round.phase==='playing')s.room.spawn(s.actor,now);}
        }
        if(!c.actor){
          if(!rooms.has(id)){if(rooms.size>=32){send(c,{type:'error',message:'All rooms are busy. Try again shortly.'});return;}rooms.set(id,new Room(id));}
          const r=rooms.get(id)!;
          if([...r.players.values()].filter(a=>!a.state.bot).length>=MAX_PLAYERS){send(c,{type:'error',message:'This room is full. Join a different room.'});return;}
          const bot=[...r.players.values()].find(a=>a.state.bot);if(r.players.size>=MAX_PLAYERS&&bot)r.remove(bot.state.id);
          const name=String(m.name??'Guest').replace(/[<>\x00-\x1f]/g,'').trim().slice(0,16)||'Guest';
          c.room=r;c.actor=r.add(name,m.classId,m.team);c.token=randomBytes(24).toString('hex');sessions.set(c.token,{room:r,actor:c.actor,expires:Infinity,connection:c});r.fillBots(now);
          r.events.push({type:'notice',text:`${name} joined the yard`});
        }
        c.room!.lastActive=now;send(c,{type:'welcome',id:c.actor.state.id,token:c.token!,room:c.room!.id,host:c.room!.host,serverTime:now});snapshot(c,true);return;
      }
      const r=c.room,a=c.actor;if(!r||!a)return;
      if(m.type==='input'){if(!r.enqueue(a,m.inputs,now)&&++c.strikes>10)ws.close(1008,'Invalid input');}
      if(m.type==='sync')snapshot(c,true);
      if(m.type==='class'&&CLASS_IDS.includes(m.classId)&&['blue','red'].includes(m.team)){
        if(r.round.phase!=='playing'){a.state.classId=m.classId;a.state.team=m.team;r.spawn(a,now);}else{a.pendingClass=m.classId;}
      }
      if(m.type==='configure'&&r.host===a.state.id&&r.round.phase!=='playing'){
        if(m.mode==='ffa'||m.mode==='tdm')r.round.mode=m.mode;
        if(['easy','normal','hard'].includes(m.difficulty??''))r.difficulty=m.difficulty!;
        if(Number.isInteger(m.bots))r.botCount=Math.max(0,Math.min(7,m.bots!));r.fillBots(now);
      }
      if(m.type==='start'&&r.host===a.state.id&&r.round.phase==='lobby')r.start(now);
    });
    ws.on('close',()=>{connections.delete(c);if(c.actor){c.actor.connected=false;c.actor.queue=[];c.actor.state.alive=false;c.actor.state.hp=0;c.actor.state.respawnAt=Date.now()+20000;if(c.token){const s=sessions.get(c.token);if(s){s.expires=Date.now()+20000;s.connection=undefined;}}if(c.room?.host===c.actor.state.id)c.room.host=[...c.room.players.values()].find(a=>!a.state.bot&&a.connected)?.state.id??'';}});
  });
  let snapshotId=0;
  function snapshot(c:Connection,force=false){
    if(!c.room||!c.actor)return;if(c.ws.bufferedAmount>256000){c.baseline.clear();return;}
    const full=force||!c.baseline.size||snapshotId%60===0,patches:PlayerPatch[]=[],removed:string[]=[];
    for(const a of c.room.players.values()){
      const p={...a.state};for(const key of ['x','y','z','vx','vy','vz','yaw','pitch','bloom'] as const)p[key]=Math.round(p[key]*10000)/10000;
      const before=c.baseline.get(p.id);if(full||!before)patches.push(p);else{const patch:PlayerPatch={id:p.id};for(const key of Object.keys(p) as (keyof PlayerState)[])if(p[key]!==before[key])(patch as Record<string,unknown>)[key]=p[key];if(Object.keys(patch).length>1)patches.push(patch);}c.baseline.set(p.id,p);
    }
    for(const id of c.baseline.keys())if(!c.room.players.has(id)){removed.push(id);c.baseline.delete(id);}
    send(c,{type:'snapshot',n:snapshotId,base:full?0:c.snapshot,time:Date.now(),full,players:patches,removed,round:c.room.round,host:c.room.host,difficulty:c.room.difficulty,bots:c.room.botCount});c.snapshot=snapshotId;
  }
  let tick=0,lastStats=performance.now(),count=0,total=0,peak=0,next=performance.now(),timer:ReturnType<typeof setTimeout>;
  function loop(){const begin=performance.now(),now=Date.now();
    for(const r of rooms.values())if([...r.players.values()].some(a=>!a.state.bot&&a.connected))r.tick(now);
    if(tick++%3===0){snapshotId++;for(const c of connections)snapshot(c);for(const r of rooms.values()){if(r.events.length){for(const c of connections)if(c.room===r)send(c,{type:'events',events:r.events});r.events=[];}}}
    const elapsed=performance.now()-begin;count++;total+=elapsed;peak=Math.max(peak,elapsed);stats.ticks++;
    if(begin-lastStats>=1000){stats.tickRate=+(count*1000/(begin-lastStats)).toFixed(1);stats.tickMs=+(total/count).toFixed(3);stats.peakTickMs=+peak.toFixed(3);count=0;total=0;peak=0;lastStats=begin;
      for(const c of connections){c.messages=0;if(now-c.pongAt>15000)c.ws.terminate();else if(now-c.pingAt>2000){c.pingAt=now;c.ws.ping();}}
      for(const [token,s]of sessions)if(s.expires<now){s.room.remove(s.actor.state.id);s.room.fillBots(now);sessions.delete(token);}
      for(const [id,r]of rooms){if([...r.players.values()].some(a=>!a.state.bot))r.lastActive=now;else if(now-r.lastActive>30000)rooms.delete(id);}
    }
    next+=1000/TICK_RATE;if(next<performance.now()-100)next=performance.now();timer=setTimeout(loop,Math.max(0,next-performance.now()));
  }
  timer=setTimeout(loop,0);
  return {server,rooms,stats,close:async()=>{clearTimeout(timer);for(const c of connections)c.ws.terminate();await new Promise<void>(resolve=>wss.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=createGameServer();const port=Number(process.env.PORT??3000);app.server.listen(port,'0.0.0.0',()=>console.log(`Arena server http://localhost:${port} · ${TICK_RATE} Hz · WebSocket /ws`));
  for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{void app.close().then(()=>process.exit(0));});
}
