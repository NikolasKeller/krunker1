import { BOXES, RAMPS, rampHeight, SPAWNS } from '../shared/map';
import { distance, worldHit, direction, angleLerp } from '../shared/math';
import { neutralInput } from '../shared/movement';
import { WEAPONS } from '../shared/weapons';
import type { Difficulty, Input, PlayerState, Vec3 } from '../shared/types';
const GRID=2, N=35, ORIGIN=-34;
const cell=(x:number,z:number)=>Math.max(0,Math.min(N-1,Math.round((x-ORIGIN)/GRID)))+Math.max(0,Math.min(N-1,Math.round((z-ORIGIN)/GRID)))*N;
const pos=(i:number):Vec3=>({x:ORIGIN+(i%N)*GRID,y:0,z:ORIGIN+Math.floor(i/N)*GRID});
const blocked=new Set<number>();
for(let i=0;i<N*N;i++){const p=pos(i);if(BOXES.some(b=>b.y-b.h/2<2&&Math.abs(p.x-b.x)<b.w/2+0.55&&Math.abs(p.z-b.z)<b.d/2+0.55)||RAMPS.some(r=>{const h=rampHeight(r,p.x,p.z);return h!==null&&h>0.5;}))blocked.add(i);}
export function findPath(from:Vec3,to:Vec3):Vec3[] {
  const start=cell(from.x,from.z);let goal=cell(to.x,to.z);
  if(blocked.has(goal)){let best=Infinity;for(let i=0;i<N*N;i++){if(blocked.has(i))continue;const d=distance(pos(i),to);if(d<best){best=d;goal=i;}}}
  const queue=[start],parent=new Map<number,number>([[start,-1]]);
  for(let cursor=0;cursor<queue.length;cursor++){
    const c=queue[cursor];if(c===goal)break;
    for(const d of [-1,1,-N,N]) {const n=c+d;if(n<0||n>=N*N||Math.abs(n%N-c%N)>1||blocked.has(n)||parent.has(n))continue;parent.set(n,c);queue.push(n);}
  }
  if(!parent.has(goal))return [];
  const path:Vec3[]=[];for(let n=goal;n!==start&&n!==-1;n=parent.get(n)??-1)path.push(pos(n));return path.reverse();
}
export interface BotBrain { target:string; seenAt:number; nextThink:number; path:Vec3[]; waypoint:number; strafe:number; yawError:number; pitchError:number; last:Vec3; stuck:number; roam:number; }
export function brain():BotBrain{return {target:'',seenAt:0,nextThink:0,path:[],waypoint:0,strafe:1,yawError:0,pitchError:0,last:{x:0,y:0,z:0},stuck:0,roam:0};}
export function botInput(p:PlayerState,b:BotBrain,players:Iterable<PlayerState>,mode:string,difficulty:Difficulty,now:number):Input {
  const input=neutralInput(p.ack+1),tune={easy:{reaction:520,error:0.07,speed:0.62},normal:{reaction:340,error:0.042,speed:0.8},hard:{reaction:220,error:0.023,speed:0.95}}[difficulty];
  const enemies=[...players].filter(q=>q.id!==p.id&&q.alive&&(mode==='ffa'||q.team!==p.team));
  const origin={x:p.x,y:p.y+1.55,z:p.z};
  const visible=enemies.filter(q=>{const target={x:q.x,y:q.y+1.05,z:q.z},dist=distance(origin,target);const d={x:(target.x-origin.x)/dist,y:(target.y-origin.y)/dist,z:(target.z-origin.z)/dist};return dist<65&&worldHit(origin,d,dist)>=dist-0.3;}).sort((a,c)=>distance(p,a)-distance(p,c));
  const enemy=visible[0];
  if(enemy?.id!==b.target){b.target=enemy?.id??'';b.seenAt=now;}
  if(now>b.nextThink){
    b.nextThink=now+400+Math.random()*300;b.strafe=Math.random()<0.5?-1:1;
    b.yawError=(Math.random()-0.5)*tune.error*2;b.pitchError=(Math.random()-0.5)*tune.error;
    const nearest=[...enemies].sort((a,c)=>distance(p,a)-distance(p,c))[0];
    if(distance(p,b.last)<0.5)b.stuck++;else b.stuck=0;b.last={x:p.x,y:p.y,z:p.z};
    let destination:Vec3=nearest??SPAWNS[b.roam%SPAWNS.length];
    // Low-health/reloading bots break line of sight behind a nearby cover corner.
    if(enemy&&(p.hp<35||p.reloadEnd>now)){
      const corners=BOXES.filter(c=>c.kind==='crate'||c.kind==='cover').flatMap(c=>[-1,1].map(s=>({x:c.x+s*(c.w/2+1.5),y:0,z:c.z+(c.z-enemy.z>0?1:-1)*(c.d/2+1.5)})));
      destination=corners.sort((a,c)=>distance(p,a)-distance(p,c))[0]??destination;
    }
    if(b.stuck>2||!nearest){b.roam=(b.roam+1)%SPAWNS.length;destination=SPAWNS[b.roam];}
    b.path=findPath(p,destination);b.waypoint=0;
  }
  let aimYaw=p.yaw,aimPitch=0;
  if(enemy){const dx=enemy.x-p.x,dz=enemy.z-p.z,dist=Math.hypot(dx,dz);aimYaw=Math.atan2(-dx,-dz)+b.yawError;aimPitch=Math.atan2(enemy.y+1.1-origin.y,dist)+b.pitchError;input.fire=now-b.seenAt>tune.reaction&&Math.abs(Math.atan2(Math.sin(aimYaw-p.yaw),Math.cos(aimYaw-p.yaw)))<0.16;input.aim=dist>12;}
  while(b.waypoint<b.path.length&&distance({...p,y:0},b.path[b.waypoint])<1.2)b.waypoint++;
  const waypoint=b.path[b.waypoint];
  if(waypoint){const dx=waypoint.x-p.x,dz=waypoint.z-p.z,dist=Math.hypot(dx,dz);const yaw=enemy?aimYaw:Math.atan2(-dx,-dz);if(!enemy)aimYaw=yaw;
    input.forward=(-Math.sin(yaw)*dx-Math.cos(yaw)*dz)/(dist||1)*tune.speed;input.strafe=(Math.cos(yaw)*dx-Math.sin(yaw)*dz)/(dist||1)*tune.speed;}
  if(enemy&&p.reloadEnd<=now&&p.hp>=35){const dist=distance(p,enemy);const preferred=p.weapon==='shotgun'?6:p.weapon==='sniper'?26:15;input.forward=dist>preferred?0.65:dist<preferred-4?-0.35:0;input.strafe=b.strafe*0.5;}
  input.yaw=angleLerp(p.yaw,aimYaw,0.16);input.pitch=p.pitch+(aimPitch-p.pitch)*0.15;
  input.jump=b.stuck>1&&Math.floor(now/650)%2===0;input.reload=p.ammo===0||(!enemy&&p.ammo<WEAPONS[p.weapon].magazine*0.5);input.shotTime=now;
  return input;
}
