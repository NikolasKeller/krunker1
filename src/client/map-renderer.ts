import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BOXES, RAMPS } from '../shared/map';
import { box, material } from './models';
function sign(scene:THREE.Object3D,text:string,x:number,y:number,z:number,width:number,height:number,rotation=0,bg='#263c3c',fg='#eae3ce') {
  const canvas=document.createElement('canvas');canvas.width=512;canvas.height=128;const ctx=canvas.getContext('2d')!;ctx.fillStyle=bg;ctx.fillRect(0,0,512,128);ctx.fillStyle=fg;ctx.font='900 65px Arial';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(text,256,67);
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;const mesh=new THREE.Mesh(new THREE.PlaneGeometry(width,height),new THREE.MeshBasicMaterial({map:texture}));mesh.position.set(x,y,z);mesh.rotation.y=rotation;scene.add(mesh);
}
export function buildMap(scene:THREE.Scene){
  const staticGroup=new THREE.Group();
  box(staticGroup,0,-0.25,0,180,0.5,180,0xc2b39a);
  for(const b of BOXES){box(staticGroup,b.x,b.y,b.z,b.w,b.h,b.d,b.color);
    if(b.kind==='building'){
      box(staticGroup,b.x,b.y+b.h/2+0.12,b.z,b.w+0.35,0.24,b.d+0.35,0xf0e6d0);
      box(staticGroup,b.x,b.y-b.h/2+0.3,b.z,b.w+0.05,0.6,b.d+0.05,0xae9d82);
      if(b.w>5){
        for(const x of [-0.28,0.28])for(const s of [-1,1]){
          box(staticGroup,b.x+b.w*x,b.y+0.7,b.z+s*(b.d/2+0.025),1.75,1.85,0.08,0x526669);
          box(staticGroup,b.x+b.w*x,b.y+0.68,b.z+s*(b.d/2+0.075),1.38,1.48,0.04,0x364b50);
          box(staticGroup,b.x+b.w*x,b.y-0.28,b.z+s*(b.d/2+0.18),2.05,0.18,0.4,0xe7d9bc);
          box(staticGroup,b.x+b.w*x,b.y+0.68,b.z+s*(b.d/2+0.11),0.075,1.55,0.04,0x9baca4);
        }
        for(const s of [-1,1])box(staticGroup,b.x+s*(b.w/2+0.05),b.y-0.35,b.z,0.1,2.65,1.75,0x597d7b);
      }
    }
    if(b.kind==='crate'){
      for(const s of [-1,1]){for(const t of [-1,1]){box(staticGroup,b.x+t*(b.w/2-0.15),b.y,b.z+s*(b.d/2+0.025),0.22,b.h,0.08,0x876039);box(staticGroup,b.x,b.y+t*(b.h/2-0.14),b.z+s*(b.d/2+0.05),b.w,0.20,0.12,0xd1a368);}
        const brace=box(staticGroup,b.x,b.y,b.z+s*(b.d/2+0.06),Math.hypot(b.w-0.4,b.h-0.4),0.15,0.10,0xd5a86c);brace.rotation.z=Math.atan2(b.h-0.4,b.w-0.4);
        for(let x=-b.w/2+0.65;x<b.w/2;x+=0.65)box(staticGroup,b.x+x,b.y,b.z+s*(b.d/2+0.015),0.025,b.h-0.2,0.025,0x9c713f);
      }
    }
    if(b.kind==='cover'&&b.h>2){for(let x=-b.w/2+0.3;x<b.w/2;x+=0.6)for(const s of [-1,1])box(staticGroup,b.x+x,b.y,b.z+s*(b.d/2+0.04),0.08,b.h-0.2,0.08,b.color);box(staticGroup,b.x,b.y+b.h/2,b.z,b.w+0.1,0.12,b.d+0.1,0x345559);}
  }
  for(const r of RAMPS){const x0=r.x-r.w/2,x1=r.x+r.w/2,z0=r.z-r.d/2,z1=r.z+r.d/2;
    const h=(x:number,z:number)=>(0.5+(r.axis==='x'?(x-r.x)/r.w:(z-r.z)/r.d)*r.sign)*r.h;
    const v=[x0,h(x0,z0),z0,x0,h(x0,z1),z1,x1,h(x1,z1),z1,x1,h(x1,z0),z0,x0,0,z0,x0,0,z1,x1,0,z1,x1,0,z0];
    const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(v,3));geo.setIndex([0,1,2,0,2,3,4,0,3,4,3,7,1,5,6,1,6,2,4,5,1,4,1,0,3,2,6,3,6,7]);geo.computeVertexNormals();const mesh=new THREE.Mesh(geo,material(r.color));mesh.receiveShadow=true;mesh.castShadow=true;staticGroup.add(mesh);
  }
  // Painted lane markers and a plaza inset help players learn the three routes at a glance.
  for(const s of [-1,1]){box(staticGroup,s*31,0.007,12*s,0.18,0.013,14,0xe4dac0);box(staticGroup,s*21,0.01,-30*s,16,0.02,0.13,0xe4dac0);}
  box(staticGroup,0,0.009,21,5,0.018,6,0xb1a58e);
  for(const x of [-1,1]){box(staticGroup,x*4.55,4.015,0,0.17,0.03,8,0xe4b450);box(staticGroup,x*4.5,4.015,-8,0.13,0.03,6,0xe4b450);}
  // Small architectural accents stay geometric, just like the reference maps.
  for(const [x,z]of [[-32,18],[32,-18],[-28,-34],[28,34]]){
    box(staticGroup,x,2.5,z,0.15,5,0.15,0x65726e);box(staticGroup,x+0.5,4.95,z,1.1,0.15,0.15,0x65726e);box(staticGroup,x+1,4.83,z,0.5,0.13,0.3,0xe9e2c3);
  }
  for(let i=0;i<16;i++){const x=(i%8-3.5)*15,z=i<8?-48:49,h=5+(i*7%9);box(staticGroup,x,h/2,z,10,h,9,0xc3bdad);box(staticGroup,x,h+0.12,z,10.4,0.25,9.4,0xdcd6c5);}
  // Merge static geometry by material so detail does not turn into hundreds of draw calls.
  staticGroup.updateMatrixWorld(true);const batches=new Map<THREE.Material,THREE.BufferGeometry[]>();
  staticGroup.traverse(o=>{if(o instanceof THREE.Mesh){const mat=o.material as THREE.Material,g=o.geometry.clone().applyMatrix4(o.matrixWorld);if(g.index){const n=g.toNonIndexed();g.dispose();if(!batches.has(mat))batches.set(mat,[]);batches.get(mat)!.push(n);}else{if(!batches.has(mat))batches.set(mat,[]);batches.get(mat)!.push(g);}}});
  for(const [mat,geos]of batches){const merged=mergeGeometries(geos);if(!merged)continue;const m=new THREE.Mesh(merged,mat);m.receiveShadow=true;m.castShadow=true;scene.add(m);geos.forEach(g=>g.dispose());}
  sign(scene,'SANDYARD',-19,5.65,-5.94,7.6,1.4,0,'#355b5a');
  sign(scene,'WAREHOUSE 02',19,5.2,20.06,7.5,1.3,0,'#3b5b5b');
  sign(scene,'A  →',-12,2.3,13.94,3,1.15,Math.PI,'#a66348');
  sign(scene,'←  B',20,2.3,-15.94,3,1.15,0,'#426e74');
  sign(scene,'01',-0.5,5.65,1.51,2.1,1.25,0,'#cbbb9b','#f5edda');
}
