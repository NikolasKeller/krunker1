import type { WeaponId } from '../shared/types';
export class AudioEngine {
  context?:AudioContext;gain?:GainNode;volume=Number(localStorage.getItem('arena-volume')??0.35);private noise?:AudioBuffer;
  unlock(){if(!this.context){this.context=new AudioContext();this.gain=this.context.createGain();this.gain.gain.value=this.volume;this.gain.connect(this.context.destination);this.noise=this.context.createBuffer(1,this.context.sampleRate,this.context.sampleRate);const data=this.noise.getChannelData(0);for(let i=0;i<data.length;i++)data[i]=Math.random()*2-1;}void this.context.resume();}
  setVolume(v:number){this.volume=v;if(this.gain)this.gain.gain.value=v;localStorage.setItem('arena-volume',String(v));}
  tone(freq:number,length:number,volume:number,type:OscillatorType='sine',end=freq,delay=0){const ctx=this.context;if(!ctx||!this.gain)return;const o=ctx.createOscillator(),g=ctx.createGain(),t=ctx.currentTime+delay;o.type=type;o.frequency.setValueAtTime(freq,t);o.frequency.exponentialRampToValueAtTime(Math.max(15,end),t+length);g.gain.setValueAtTime(volume,t);g.gain.exponentialRampToValueAtTime(0.001,t+length);o.connect(g);g.connect(this.gain);o.start(t);o.stop(t+length);}
  burst(length:number,volume:number,cutoff:number){const ctx=this.context;if(!ctx||!this.gain||!this.noise)return;const s=ctx.createBufferSource(),g=ctx.createGain(),f=ctx.createBiquadFilter();s.buffer=this.noise;f.type='lowpass';f.frequency.value=cutoff;g.gain.setValueAtTime(volume,ctx.currentTime);g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+length);s.connect(f);f.connect(g);g.connect(this.gain);s.start();s.stop(ctx.currentTime+length);}
  shot(w:WeaponId,distance=0){const v=1/(1+distance*0.09);if(w==='knife'){this.burst(0.1,0.22*v,1600);return;}const bass=w==='sniper'?65:w==='shotgun'?80:w==='smg'?160:110;this.tone(bass*2,0.16,0.7*v,'triangle',bass/2);this.burst(w==='sniper'?0.23:w==='shotgun'?0.18:0.08,0.52*v,2500);if(w==='sniper')this.tone(320,0.08,0.07*v,'square',95,0.18);}
  hit(head=false,lethal=false){this.tone(head?1900:1250,0.055,0.25,'sine',850);this.tone(lethal?2400:1750,0.085,0.18,'triangle',lethal?1600:1100,0.035);}
  reload(){this.burst(0.045,0.18,4500);this.tone(250,0.04,0.08,'square',160);}
  step(){this.burst(0.05,0.065,600);}
  hurt(){this.tone(130,0.15,0.18,'triangle',48);}
  spawn(){this.tone(480,0.12,0.13,'sine',700);this.tone(750,0.15,0.09,'sine',1000,0.1);}
}
