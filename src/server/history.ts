import { MAX_REWIND_MS, type PlayerState } from '../shared/types';
import { clamp, lerp } from '../shared/math';
export class History {
  frames: {time:number; players:Map<string,PlayerState>}[]=[];
  record(time:number,players:Iterable<PlayerState>) {this.frames.push({time,players:new Map([...players].map(p=>[p.id,{...p}]))});while(this.frames.length>1&&this.frames[0].time<time-MAX_REWIND_MS-100)this.frames.shift();}
  rewind(id:string,time:number):PlayerState|null {
    if(!this.frames.length)return null;
    let a=this.frames[0],b=a;
    for(const f of this.frames){b=f;if(f.time>=time)break;a=f;}
    const p=a.players.get(id),q=b.players.get(id);if(!p&&!q)return null;if(!p)return q?{...q}:null;if(!q||p.life!==q.life)return {...p};
    const t=clamp((time-a.time)/(b.time-a.time||1),0,1);
    return {...p,x:lerp(p.x,q.x,t),y:lerp(p.y,q.y,t),z:lerp(p.z,q.z,t)};
  }
}
export function rewindTime(request:number,now:number,rtt:number) {
  // The connection's measured RTT bounds the client timestamp; future or arbitrarily old shots cannot choose a historical victim.
  return clamp(request,now-Math.min(MAX_REWIND_MS,Math.max(0,rtt)/2+150),now);
}
