import { randomUUID } from 'node:crypto';
import { CLASS_IDS, CLASSES, damageFor, recoilFor, shotDirections, spreadFor, WEAPONS } from '../shared/weapons';
import { STEP, MAX_PLAYERS, type ClassId, type Difficulty, type GameEvent, type Input, type PlayerState, type Team, type WeaponId } from '../shared/types';
import { SPAWNS } from '../shared/map';
import { eyeHeight, move, moveState, neutralInput, validInput } from '../shared/movement';
import { distance, hitPlayer, worldHit } from '../shared/math';
import { History, rewindTime } from './history';
import { checkRound, newRound, startRound } from './round';
import { brain, botInput, type BotBrain } from './bots';
export interface Actor {
  state:PlayerState; queue:Input[]; lastSeq:number; lastInputAt:number; credit:number;
  nextShot:number; recoilIndex:number; lastShot:number; aimTime:number;
  ammo:Record<WeaponId,number>; botBrain?:BotBrain; rtt:number; connected:boolean; pendingClass?:ClassId;
}
const ammo=()=>Object.fromEntries(Object.entries(WEAPONS).map(([id,w])=>[id,w.magazine])) as Record<WeaponId,number>;
export class Room {
  players=new Map<string,Actor>();round=newRound();history=new History();events:GameEvent[]=[];
  host='';difficulty:Difficulty='normal';botCount=5;lastActive=Date.now();
  constructor(public id:string){}
  add(name:string,classId:ClassId,team:Team,bot=false):Actor {
    const id=randomUUID().slice(0,8),c=CLASSES[classId];
    const state:PlayerState={...moveState(),id,name,classId,team,bot,yaw:0,pitch:0,hp:c.hp,maxHp:c.hp,alive:true,kills:0,deaths:0,score:0,weapon:c.weapon,ammo:WEAPONS[c.weapon].magazine,reloadEnd:0,respawnAt:0,protectionEnd:0,ack:0,aiming:false,bloom:0,streak:0,life:0};
    const a:Actor={state,queue:[],lastSeq:0,lastInputAt:Date.now(),credit:1,nextShot:0,recoilIndex:0,lastShot:0,aimTime:0,ammo:ammo(),rtt:0,connected:true,botBrain:bot?brain():undefined};
    this.players.set(id,a);if(!this.host&&!bot)this.host=id;this.spawn(a,Date.now());return a;
  }
  remove(id:string){this.players.delete(id);if(this.host===id)this.host=[...this.players.values()].find(p=>!p.state.bot&&p.connected)?.state.id??'';}
  spawn(a:Actor,now:number){
    if(a.pendingClass){a.state.classId=a.pendingClass;a.pendingClass=undefined;}
    const p=a.state,c=CLASSES[p.classId];
    const enemies=[...this.players.values()].filter(a=>a.state.id!==p.id&&a.state.alive&&(this.round.mode==='ffa'||a.state.team!==p.team)).map(a=>a.state);
    const candidates=SPAWNS.filter((_,i)=>this.round.mode==='ffa'||(p.team==='blue'?i%2===0:i%2===1));
    const spawn=[...candidates].sort((a,b)=>Math.min(100,...enemies.map(e=>distance(b,e)))-Math.min(100,...enemies.map(e=>distance(a,e))))[0];
    Object.assign(p,moveState(spawn.x,spawn.y,spawn.z),{yaw:spawn.yaw,pitch:0,hp:c.hp,maxHp:c.hp,alive:true,weapon:c.weapon,ammo:WEAPONS[c.weapon].magazine,reloadEnd:0,respawnAt:0,protectionEnd:now+1500,aiming:false,bloom:0,life:p.life+1});
    a.ammo=ammo();a.nextShot=now+250;a.recoilIndex=0;a.aimTime=0;a.queue=[];
  }
  fillBots(now:number){
    const humans=[...this.players.values()].filter(a=>!a.state.bot).length;
    const bots=[...this.players.values()].filter(a=>a.state.bot),wanted=Math.max(0,Math.min(this.botCount,MAX_PLAYERS-humans));
    while(bots.length>wanted){const a=bots.pop()!;this.remove(a.state.id);}
    const names=['Kilo','Mochi','Rook','Pixel','Echo','Noodle','Orbit'];
    while(bots.length<wanted){const used=new Set(bots.map(a=>a.state.name));const name=names.find(n=>!used.has(n))??'Bot';const blue=[...this.players.values()].filter(a=>a.state.team==='blue').length;const team=blue>this.players.size/2?'red':'blue';const a=this.add(name,CLASS_IDS[bots.length%4],team,true);a.state.protectionEnd=now+1500;bots.push(a);}
  }
  start(now:number){startRound(this.round,now);this.history.frames=[];for(const a of this.players.values()){Object.assign(a.state,{kills:0,deaths:0,score:0,streak:0});this.spawn(a,now);}this.events.push({type:'notice',text:'ROUND LIVE · GOOD LUCK, HAVE FUN'});}
  enqueue(a:Actor,inputs:unknown,now:number):boolean {
    if(!Array.isArray(inputs)||inputs.length>12)return false;
    for(const input of inputs){if(!validInput(input)||input.seq<=a.lastSeq||input.seq>a.lastSeq+240)return false;a.lastSeq=input.seq;a.queue.push(input);}
    if(a.queue.length>120){a.queue.length=0;return false;}a.lastInputAt=now;return true;
  }
  tick(now:number){
    if(this.round.phase==='results'&&now>=this.round.nextAt)this.start(now);
    for(const a of this.players.values()){
      const p=a.state;a.credit=Math.min(3,a.credit+1);
      if(!p.alive&&this.round.phase==='playing'&&now>=p.respawnAt)this.spawn(a,now);
      if(p.reloadEnd&&now>=p.reloadEnd){p.reloadEnd=0;p.ammo=WEAPONS[p.weapon].magazine;a.ammo[p.weapon]=p.ammo;}
      p.bloom=Math.max(0,p.bloom-WEAPONS[p.weapon].recovery*STEP*(Math.hypot(p.vx,p.vz)<1?1.5:0.75));
      if(now-a.lastShot>450)a.recoilIndex=0;
      if(a.botBrain&&this.round.phase==='playing'&&p.alive)a.queue=[botInput(p,a.botBrain,[...this.players.values()].map(a=>a.state),this.round.mode,this.difficulty,now)];
      let processed=0;
      while(a.queue.length&&a.credit>=1&&processed<3){const i=a.queue.shift()!;a.credit--;processed++;p.ack=i.seq;
        if(this.round.phase!=='playing'||!p.alive)continue;
        p.yaw=i.yaw;p.pitch=i.pitch;
        const weapon=i.slot===1?CLASSES[p.classId].weapon:i.slot===2?'pistol':'knife';
        if(weapon!==p.weapon){a.ammo[p.weapon]=p.ammo;p.weapon=weapon;p.ammo=a.ammo[weapon];p.reloadEnd=0;p.bloom=0;a.aimTime=0;a.nextShot=Math.max(a.nextShot,now+180);a.recoilIndex=0;}
        p.aiming=i.aim;if(i.aim)a.aimTime=Math.min(1,a.aimTime+STEP*1000/(WEAPONS[weapon].scopeTime||1));else a.aimTime=0;
        move(p,i,CLASSES[p.classId].speed*(weapon==='knife'?1.16:1));
        if(i.reload&&weapon!=='knife'&&!p.reloadEnd&&p.ammo<WEAPONS[weapon].magazine)p.reloadEnd=now+WEAPONS[weapon].reload;
        if(i.fire&&!p.reloadEnd&&now>=a.nextShot){if(p.ammo>0||weapon==='knife')this.fire(a,i,now);else if(weapon!=='knife')p.reloadEnd=now+WEAPONS[weapon].reload;}
      }
      if(!processed&&now-a.lastInputAt>250&&p.alive&&this.round.phase==='playing'){const i=neutralInput(p.ack);i.yaw=p.yaw;move(p,i,CLASSES[p.classId].speed);}
    }
    this.history.record(now,[...this.players.values()].map(a=>a.state));
    checkRound(this.round,[...this.players.values()].map(a=>a.state),now);
  }
  fire(a:Actor,i:Input,now:number){
    const p=a.state,w=WEAPONS[p.weapon];a.nextShot=now+w.interval;a.lastShot=now;p.protectionEnd=0;
    if(p.weapon!=='knife')p.ammo--;
    const origin={x:p.x,y:p.y+eyeHeight(p),z:p.z};
    const spread=spreadFor(p.weapon,Math.hypot(p.vx,p.vz),p.bloom,a.aimTime);
    const recoil=recoilFor(p.weapon,a.recoilIndex++);
    const dirs=shotDirections(p.weapon,p.yaw+recoil[1],p.pitch+recoil[0]*0.25,spread,i.seq*137+Math.round(now));
    p.bloom=Math.min(w.maxBloom,p.bloom+w.bloom);
    const hits=new Map<string,{damage:number;zone:'head'|'body'|'legs';point:{x:number;y:number;z:number}}>();
    const time=a.botBrain?now:rewindTime(i.shotTime,now,a.rtt);
    const ends=dirs.map(d=>{
      let nearest=worldHit(origin,d,w.range),target:Actor|undefined,zone:'head'|'body'|'legs'='body';
      for(const other of this.players.values()){
        const q=other.state;if(q.id===p.id||!q.alive||q.protectionEnd>now||(this.round.mode==='tdm'&&q.team===p.team))continue;
        const rewound=this.history.rewind(q.id,time)??q;if(!rewound.alive||rewound.life!==q.life)continue;
        const hit=hitPlayer(origin,d,rewound);if(hit&&hit.distance<nearest){nearest=hit.distance;target=other;zone=hit.zone;}
      }
      const point={x:origin.x+d.x*nearest,y:origin.y+d.y*nearest,z:origin.z+d.z*nearest};
      if(target){const prev=hits.get(target.state.id);hits.set(target.state.id,{damage:(prev?.damage??0)+damageFor(p.weapon,zone,nearest),zone:prev?.zone==='head'?'head':zone,point});}return point;
    });
    this.events.push({type:'shot',shooter:p.id,weapon:p.weapon,origin,ends,seq:i.seq});
    for(const [id,hit] of hits){const q=this.players.get(id)!.state;const actual=Math.min(q.hp,hit.damage);q.hp=Math.max(0,q.hp-hit.damage);
      this.events.push({type:'hit',shooter:p.id,victim:q.id,damage:actual,zone:hit.zone,point:hit.point,from:origin,lethal:q.hp<=0});
      if(q.hp<=0){q.alive=false;q.deaths++;q.streak=0;q.respawnAt=now+2200;q.reloadEnd=0;q.vx=0;q.vy=0;q.vz=0;p.kills++;p.streak++;p.score+=hit.zone==='head'?150:100;if(p.team==='blue')this.round.blue++;else this.round.red++;
        this.events.push({type:'kill',killer:p.id,victim:q.id,killerName:p.name,victimName:q.name,weapon:p.weapon,headshot:hit.zone==='head',team:p.team});}
    }
  }
}
