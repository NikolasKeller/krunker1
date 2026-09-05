import type { ClassId, WeaponId, Vec3 } from './types';
import { direction, random, clamp } from './math';
export interface WeaponStats { name: string; damage: number; head: number; legs: number; interval: number; reload: number; magazine: number; range: number; falloff: number; pellets: number; spread: number; moving: number; bloom: number; maxBloom: number; recovery: number; aimSpread: number; scopeTime: number; recoil: [number,number][]; }
export const WEAPONS: Record<WeaponId,WeaponStats> = {
  sniper: {name:'TRIANGLE .50',damage:110,head:1.5,legs:0.55,interval:1150,reload:1900,magazine:3,range:150,falloff:120,pellets:1,spread:0.028,moving:0.014,bloom:0.01,maxBloom:0.03,recovery:0.05,aimSpread:0.018,scopeTime:180,recoil:[[0.022,0.004],[0.024,-0.006],[0.021,0.002]]},
  rifle: {name:'ASSAULT RIFLE',damage:25,head:1.5,legs:0.8,interval:120,reload:1700,magazine:30,range:110,falloff:38,pellets:1,spread:0.0025,moving:0.009,bloom:0.0018,maxBloom:0.023,recovery:0.032,aimSpread:0.38,scopeTime:120,recoil:[[0.009,-0.001],[0.011,0.003],[0.013,0.004],[0.012,-0.006],[0.013,-0.005],[0.011,0.007]]},
  shotgun: {name:'DOUBLE BARREL',damage:24,head:1.35,legs:0.8,interval:800,reload:1550,magazine:2,range:32,falloff:7,pellets:8,spread:0.073,moving:0.014,bloom:0.016,maxBloom:0.03,recovery:0.06,aimSpread:0.8,scopeTime:100,recoil:[[0.03,-0.006],[0.038,0.008]]},
  smg: {name:'COMPACT SMG',damage:18,head:1.5,legs:0.8,interval:72,reload:1400,magazine:34,range:80,falloff:22,pellets:1,spread:0.009,moving:0.016,bloom:0.0028,maxBloom:0.039,recovery:0.046,aimSpread:0.5,scopeTime:100,recoil:[[0.007,0.004],[0.008,-0.003],[0.009,0.006],[0.011,-0.008],[0.009,0.006]]},
  pistol: {name:'SIDEARM',damage:24,head:1.6,legs:0.8,interval:240,reload:1200,magazine:10,range:80,falloff:28,pellets:1,spread:0.006,moving:0.012,bloom:0.003,maxBloom:0.02,recovery:0.04,aimSpread:0.4,scopeTime:100,recoil:[[0.012,0.002],[0.014,-0.003]]},
  knife: {name:'COMBAT KNIFE',damage:65,head:1,legs:1,interval:450,reload:0,magazine:1,range:2.8,falloff:3,pellets:1,spread:0,moving:0,bloom:0,maxBloom:0,recovery:1,aimSpread:1,scopeTime:0,recoil:[[0,0]]},
};
export const CLASSES: Record<ClassId,{ name:string; role:string; weapon:WeaponId; hp:number; speed:number; color:string; description:string; stats:number[] }> = {
  hunter: {name:'HUNTER',role:'PRECISION',weapon:'sniper',hp:70,speed:1,color:'#ecad56',description:'One shot. Make it count. A lethal upper-body hit, a clean scope, and a quick escape.',stats:[100,22,94]},
  triggerman: {name:'TRIGGERMAN',role:'ALL-ROUNDER',weapon:'rifle',hp:100,speed:1,color:'#bedf57',description:'The original all-rounder. Reliable damage, a steady rhythm, and thirty reasons to keep moving.',stats:[64,65,70]},
  vince: {name:'VINCE',role:'CLOSE QUARTERS',weapon:'shotgun',hp:100,speed:1.04,color:'#ee8d72',description:'Get close. Clear the room. Two barrels of devastating damage and a fast reload.',stats:[97,30,22]},
  runngun: {name:'RUN N GUN',role:'MOBILITY',weapon:'smg',hp:100,speed:1.12,color:'#80c6ce',description:'Never stand still. A blistering fire rate and the fastest feet in the yard.',stats:[43,100,43]},
};
export const CLASS_IDS=Object.keys(CLASSES) as ClassId[];
export function damageFor(w: WeaponId, zone:'head'|'body'|'legs',dist: number) {
  const s=WEAPONS[w];if(dist>s.range)return 0;
  const loss=w==='shotgun'?Math.pow(clamp(1-(dist-s.falloff)/(s.range-s.falloff),0,1),2):clamp(1-(dist-s.falloff)/(s.range-s.falloff)*0.5,0.5,1);
  return Math.max(1,Math.round(s.damage*(zone==='head'?s.head:zone==='legs'?s.legs:1)*loss));
}
export function spreadFor(w: WeaponId,speed:number,bloom:number,aimProgress:number) {
  const s=WEAPONS[w]; return (s.spread+s.moving*clamp(speed/10,0,1.7)+bloom)*(1-(1-s.aimSpread)*clamp(aimProgress,0,1));
}
export function recoilFor(w:WeaponId,index:number):[number,number] {return WEAPONS[w].recoil[index%WEAPONS[w].recoil.length];}
export function shotDirections(w:WeaponId,yaw:number,pitch:number,spread:number,seed:number):Vec3[] {
  const rng=random(seed);return Array.from({length:WEAPONS[w].pellets},()=>{const theta=rng()*Math.PI*2,r=Math.sqrt(rng())*spread;return direction(yaw+Math.cos(theta)*r,pitch+Math.sin(theta)*r);});
}
