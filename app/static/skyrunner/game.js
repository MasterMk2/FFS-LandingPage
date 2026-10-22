(function(){
'use strict';
// ================= Simplex noise (seeded) =================
var F2=0.5*(Math.sqrt(3)-1), G2=(3-Math.sqrt(3))/6;
var perm=new Uint8Array(512), grad2=[[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
(function(){var s=20261023,p=new Uint8Array(256),i,j,t;for(i=0;i<256;i++)p[i]=i;for(i=255;i>0;i--){s=(s*16807)%2147483647;j=s%(i+1);t=p[i];p[i]=p[j];p[j]=t;}for(i=0;i<512;i++)perm[i]=p[i&255];})();
function snoise(x,y){
  var s=(x+y)*F2, i=Math.floor(x+s), j=Math.floor(y+s), t=(i+j)*G2;
  var x0=x-(i-t), y0=y-(j-t), i1=x0>y0?1:0, j1=x0>y0?0:1;
  var x1=x0-i1+G2, y1=y0-j1+G2, x2=x0-1+2*G2, y2=y0-1+2*G2, ii=i&255, jj=j&255, n=0, g, t0, t1, t2;
  t0=0.5-x0*x0-y0*y0; if(t0>0){g=grad2[perm[ii+perm[jj]]&7];t0*=t0;n+=t0*t0*(g[0]*x0+g[1]*y0);}
  t1=0.5-x1*x1-y1*y1; if(t1>0){g=grad2[perm[ii+i1+perm[jj+j1]]&7];t1*=t1;n+=t1*t1*(g[0]*x1+g[1]*y1);}
  t2=0.5-x2*x2-y2*y2; if(t2>0){g=grad2[perm[ii+1+perm[jj+1]]&7];t2*=t2;n+=t2*t2*(g[0]*x2+g[1]*y2);}
  return 70*n;
}
// Terrain: continental shelf + fBm ridges. Below 0 is sea.
function terrainHeight(x,z){
  var h=0, amp=1, f=1/5200, o;
  for(o=0;o<5;o++){ h+=snoise(x*f+o*7.3, z*f-o*3.1)*amp; amp*=0.5; f*=2.05; }
  var cont=snoise(x/22000+100, z/22000-50);
  var y=h*650+cont*520-60;
  if(y>280) y=280+(y-280)*1.7;
  return y;
}
function groundHeight(x,z){ var y=terrainHeight(x,z); return y>0?y:0; }

// ================= Renderer / scene =================
var glc=document.getElementById('gl'), hud=document.getElementById('hud'), ctx=hud.getContext('2d');
var renderer=new THREE.WebGLRenderer({canvas:glc,antialias:true,powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
renderer.outputEncoding=THREE.sRGBEncoding;
var scene=new THREE.Scene();
var camera=new THREE.PerspectiveCamera(70,1,0.5,24000);
var sun=new THREE.DirectionalLight(0xffc08a,1.2); scene.add(sun);
var hemi=new THREE.HemisphereLight(0x7f8fc0,0x4a3528,0.55); scene.add(hemi);
scene.fog=new THREE.Fog(0xe9a07a,900,5200);

// Sky dome: gradient + sun glow, follows the camera
var skyUni={top:{value:new THREE.Color(0x16275e)},horizon:{value:new THREE.Color(0xf0915a)},sunDir:{value:new THREE.Vector3(-0.8,0.12,0.3).normalize()},sunCol:{value:new THREE.Color(0xffd0a0)},glow:{value:1.0}};
var sky=new THREE.Mesh(new THREE.SphereGeometry(9000,24,12),new THREE.ShaderMaterial({
  uniforms:skyUni, side:THREE.BackSide, depthWrite:false, fog:false,
  vertexShader:"varying vec3 vD; void main(){ vD=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }",
  fragmentShader:"uniform vec3 top,horizon,sunDir,sunCol; uniform float glow; varying vec3 vD; void main(){ vec3 d=normalize(vD); float h=clamp(d.y,0.0,1.0); vec3 c=mix(horizon,top,pow(h,0.55)); float s=max(dot(d,sunDir),0.0); c+=sunCol*(pow(s,400.0)*2.2+pow(s,10.0)*0.45)*glow; if(d.y<0.0) c=mix(horizon,top*0.4,clamp(-d.y*3.0,0.0,1.0)); gl_FragColor=vec4(c,1.0); }"
}));
sky.renderOrder=-10; scene.add(sky);

// Water plane follows the aircraft
var water=new THREE.Mesh(new THREE.PlaneGeometry(16000,16000),new THREE.MeshPhongMaterial({color:0x2a5f8f,shininess:90,specular:0x99bbdd,transparent:true,opacity:0.93}));
water.rotation.x=-Math.PI/2; scene.add(water);

// Times of day
var TOD=[
  {name:"夕焼け",top:0x16275e,hor:0xf0915a,fog:0xe9a07a,sunDir:[-0.8,0.12,0.3],sunCol:0xffd0a0,light:0xffc08a,lightI:1.2,hemiS:0x7f8fc0,hemiG:0x4a3528,hemiI:0.55,glow:1.0,water:0x2a5f8f},
  {name:"昼",top:0x2a66c8,hor:0xcfe3f5,fog:0xd6e4f2,sunDir:[0.3,0.8,0.2],sunCol:0xfff4e0,light:0xfff4e0,lightI:1.3,hemiS:0x9ec0ff,hemiG:0x6b7a55,hemiI:0.7,glow:0.8,water:0x1f6fa8},
  {name:"夜",top:0x02040f,hor:0x10203a,fog:0x0d1a30,sunDir:[-0.3,0.35,0.5],sunCol:0x8fa8ff,light:0x8fa8ff,lightI:0.35,hemiS:0x2a3a6a,hemiG:0x101418,hemiI:0.35,glow:0.35,water:0x0a1a30}
];
var todIndex=0;
function applyTOD(i){
  var t=TOD[i]; todIndex=i;
  skyUni.top.value.setHex(t.top); skyUni.horizon.value.setHex(t.hor); skyUni.sunDir.value.set(t.sunDir[0],t.sunDir[1],t.sunDir[2]).normalize(); skyUni.sunCol.value.setHex(t.sunCol); skyUni.glow.value=t.glow;
  scene.fog.color.setHex(t.fog); sun.color.setHex(t.light); sun.intensity=t.lightI; sun.position.copy(skyUni.sunDir.value).multiplyScalar(1000);
  hemi.color.setHex(t.hemiS); hemi.groundColor.setHex(t.hemiG); hemi.intensity=t.hemiI; water.material.color.setHex(t.water);
}
applyTOD(0);

// ================= Terrain chunks (recycled grid) =================
var CHUNK=1600, SEG=36, GRID=7, chunks=[], lastCx=null, lastCz=null;
var terrainMat=new THREE.MeshLambertMaterial({vertexColors:true});
var cTmp=new THREE.Color(), cSand=new THREE.Color(0xd8c48c), cGrass=new THREE.Color(0x5e8a3c), cGrass2=new THREE.Color(0x3e6b2b), cRock=new THREE.Color(0x7d6f66), cSnow=new THREE.Color(0xeef0f6), cDeep=new THREE.Color(0x244a6a);
function makeChunk(){
  var n=SEG*SEG*6, g=new THREE.BufferGeometry();
  g.setAttribute("position",new THREE.BufferAttribute(new Float32Array(n*3),3));
  g.setAttribute("color",new THREE.BufferAttribute(new Float32Array(n*3),3));
  var m=new THREE.Mesh(g,terrainMat); m.userData.cx=NaN; m.userData.cz=NaN; scene.add(m); chunks.push(m); return m;
}
function faceColor(h,slope,x,z){
  var v=snoise(x*0.002,z*0.002)*0.5+0.5;
  if(h<2) cTmp.copy(cDeep);
  else if(h<30) cTmp.copy(cSand).lerp(cGrass,(h-2)/28);
  else if(h<420) cTmp.copy(cGrass).lerp(cGrass2,Math.min((h-30)/390,1)*0.8+v*0.2);
  else if(h<800) cTmp.copy(cGrass2).lerp(cRock,(h-420)/380);
  else cTmp.copy(cRock).lerp(cSnow,Math.min((h-800)/400,1));
  if(slope>0.5 && h>30) cTmp.lerp(cRock,Math.min((slope-0.5)*2,1));
  cTmp.multiplyScalar(0.92+v*0.16);
  return cTmp;
}
function buildChunk(m,cx,cz){
  m.userData.cx=cx; m.userData.cz=cz; m.position.set(cx*CHUNK,0,cz*CHUNK);
  var pos=m.geometry.attributes.position.array, col=m.geometry.attributes.color.array, step=CHUNK/SEG, W=SEG+1;
  var H=new Float32Array(W*W), i, j, p=0, ox=cx*CHUNK, oz=cz*CHUNK;
  for(j=0;j<W;j++)for(i=0;i<W;i++)H[j*W+i]=terrainHeight(ox+i*step,oz+j*step);
  function tri(ax,ay,az,bx,by,bz,qx,qy,qz){
    var ux=bx-ax,uy=by-ay,uz=bz-az,vx=qx-ax,vy=qy-ay,vz=qz-az, ny=uz*vx-ux*vz, nx=uy*vz-uz*vy, nz=ux*vy-uy*vx, len=Math.sqrt(nx*nx+ny*ny+nz*nz)||1;
    var slope=1-ny/len, c=faceColor((ay+by+qy)/3,slope,ox+(ax+bx+qx)/3,oz+(az+bz+qz)/3);
    pos[p]=ax;pos[p+1]=ay;pos[p+2]=az; pos[p+3]=bx;pos[p+4]=by;pos[p+5]=bz; pos[p+6]=qx;pos[p+7]=qy;pos[p+8]=qz;
    col[p]=col[p+3]=col[p+6]=c.r; col[p+1]=col[p+4]=col[p+7]=c.g; col[p+2]=col[p+5]=col[p+8]=c.b; p+=9;
  }
  for(j=0;j<SEG;j++)for(i=0;i<SEG;i++){
    var x0=i*step,z0=j*step,x1=x0+step,z1=z0+step,h00=H[j*W+i],h10=H[j*W+i+1],h01=H[(j+1)*W+i],h11=H[(j+1)*W+i+1];
    tri(x0,h00,z0, x0,h01,z1, x1,h10,z0);
    tri(x1,h10,z0, x0,h01,z1, x1,h11,z1);
  }
  m.geometry.attributes.position.needsUpdate=true; m.geometry.attributes.color.needsUpdate=true;
  m.geometry.computeVertexNormals(); m.geometry.computeBoundingSphere();
}
for(var k=0;k<GRID*GRID;k++) makeChunk();
function updateChunks(px,pz){
  var ccx=Math.floor(px/CHUNK), ccz=Math.floor(pz/CHUNK);
  if(ccx===lastCx && ccz===lastCz) return; lastCx=ccx; lastCz=ccz;
  var half=(GRID-1)/2, need={}, free=[], dx, dz, c, key;
  for(dz=-half;dz<=half;dz++)for(dx=-half;dx<=half;dx++) need[(ccx+dx)+","+(ccz+dz)]=[ccx+dx,ccz+dz];
  for(c=0;c<chunks.length;c++){ key=chunks[c].userData.cx+","+chunks[c].userData.cz; if(need[key]) delete need[key]; else free.push(chunks[c]); }
  for(key in need){ buildChunk(free.pop(), need[key][0], need[key][1]); }
}

// ================= Flight model instance =================
var UP=new THREE.Vector3(0,1,0), tmpV=new THREE.Vector3(), tmpV2=new THREE.Vector3(), tmpQ=new THREE.Quaternion();
var fm=new FlightModel(); fm.groundHeight=groundHeight;
var START_POS=new THREE.Vector3(0,0,0);
function spawnAircraft(){
  var gy=groundHeight(START_POS.x,START_POS.z);
  fm.reset({pos:new THREE.Vector3(START_POS.x, Math.max(gy+900, 700), START_POS.z), heading:0, speed:205});
  inp.throttle=fm.controls&&typeof fm.controls.throttle==="number"?fm.controls.throttle:0.6;
  inp.pitch=0; inp.roll=0; inp.yaw=0; inp.ab=false;
}

// ================= Aircraft mesh (external view) =================
var acGroup=new THREE.Group(); scene.add(acGroup); var abFlame;
(function(){
  var body=new THREE.MeshPhongMaterial({color:0xc9ced8,flatShading:true,shininess:30});
  var dark=new THREE.MeshPhongMaterial({color:0x2b3242,flatShading:true});
  var glass=new THREE.MeshPhongMaterial({color:0x2a4a7a,shininess:120,specular:0xffffff});
  var fus=new THREE.Mesh(new THREE.CylinderGeometry(0.35,0.85,12,8),body); fus.rotation.x=-Math.PI/2; fus.position.z=0.5; acGroup.add(fus);
  var nose=new THREE.Mesh(new THREE.ConeGeometry(0.35,2.2,8),body); nose.rotation.x=-Math.PI/2; nose.position.z=-6.6; acGroup.add(nose);
  var wing=new THREE.Mesh(new THREE.BoxGeometry(9.5,0.14,3.0),body); wing.position.set(0,-0.15,1.2); acGroup.add(wing);
  var wl=new THREE.Mesh(new THREE.BoxGeometry(2.6,0.16,1.3),body); wl.position.set(-2.2,-0.15,-0.9); wl.rotation.y=0.35; acGroup.add(wl);
  var wr=wl.clone(); wr.position.x=2.2; wr.rotation.y=-0.35; acGroup.add(wr);
  var fin=new THREE.Mesh(new THREE.BoxGeometry(0.12,2.4,2.2),body); fin.position.set(0,1.3,5.0); fin.rotation.x=-0.35; acGroup.add(fin);
  var stab=new THREE.Mesh(new THREE.BoxGeometry(4.6,0.1,1.5),body); stab.position.set(0,0.1,5.6); acGroup.add(stab);
  var canopy=new THREE.Mesh(new THREE.SphereGeometry(0.62,10,8),glass); canopy.scale.set(1,0.9,2.4); canopy.position.set(0,0.55,-3.0); acGroup.add(canopy);
  var nozzle=new THREE.Mesh(new THREE.CylinderGeometry(0.55,0.62,1.2,8),dark); nozzle.rotation.x=-Math.PI/2; nozzle.position.z=6.9; acGroup.add(nozzle);
  abFlame=new THREE.Mesh(new THREE.ConeGeometry(0.5,3.6,8),new THREE.MeshBasicMaterial({color:0xffa040,transparent:true,opacity:0.85})); abFlame.rotation.x=Math.PI/2; abFlame.position.z=9.2; abFlame.visible=false; acGroup.add(abFlame);
})();

// ================= Gates =================
var torusGeo=new THREE.TorusGeometry(60,3.5,10,40);
var gateMatNext=new THREE.MeshBasicMaterial({color:0xffb347});
var gateMat=new THREE.MeshBasicMaterial({color:0x58c8ff,transparent:true,opacity:0.5});
var poleMat=new THREE.MeshBasicMaterial({color:0x58c8ff,transparent:true,opacity:0.22});
var gates=[], gateDir=new THREE.Vector3(0,0,-1), GATE_R=60;
var score={gates:0,miss:0,perfect:0,time:0,best:0};
try{ score.best=parseInt(localStorage.getItem("skyrunner.best")||"0",10)||0; }catch(e){}
function clearGates(){ for(var i=0;i<gates.length;i++){ scene.remove(gates[i].mesh); scene.remove(gates[i].pole); gates[i].pole.geometry.dispose(); } gates=[]; }
function spawnGate(){
  var last=gates.length?gates[gates.length-1].pos:null, from=last||fm.pos.clone(), dist;
  if(!last){ gateDir.set(0,0,-1).applyQuaternion(fm.q); gateDir.y=0; gateDir.normalize(); dist=1700; }
  else { gateDir.applyAxisAngle(UP,(Math.random()-0.5)*1.1).normalize(); dist=1100+Math.random()*700; }
  var p=from.clone().addScaledVector(gateDir,dist), gy=groundHeight(p.x,p.z);
  // First gate sits near the aircraft's own altitude; later ones wander within a climb/dive the jet can actually fly.
  p.y=last?THREE.MathUtils.clamp(gy+150+Math.random()*450, from.y-380, from.y+280):from.y+(Math.random()-0.5)*120;
  if(p.y<gy+110) p.y=gy+110;
  var mesh=new THREE.Mesh(torusGeo,gateMat); mesh.position.copy(p); mesh.lookAt(from); scene.add(mesh);
  var ph=p.y-gy, pole=new THREE.Mesh(new THREE.CylinderGeometry(1.2,1.2,ph,6),poleMat); pole.position.set(p.x,gy+ph/2,p.z); scene.add(pole);
  gates.push({mesh:mesh,pole:pole,pos:p,normal:from.clone().sub(p).normalize(),sideLast:1});
  gates[0].mesh.material=gateMatNext;
}
function resetGates(){ clearGates(); gateDir.set(0,0,-1); for(var i=0;i<4;i++) spawnGate(); }
function advanceGate(){ var g=gates.shift(); scene.remove(g.mesh); scene.remove(g.pole); g.pole.geometry.dispose(); spawnGate(); }
function updateGates(){
  var g=gates[0]; if(!g) return;
  var d=tmpV.copy(fm.pos).sub(g.pos), s=d.dot(g.normal), lat=tmpV2.copy(d).addScaledVector(g.normal,-s).length();
  if(g.sideLast>0 && s<=0){
    if(lat<GATE_R){
      score.gates++; if(lat<18){ score.perfect++; showMsg("PERFECT  +1",1200); beep(1320,0.08); setTimeout(function(){beep(1760,0.12);},90); }
      else { showMsg("GATE  +1",900); beep(1100,0.1); }
      if(score.gates>score.best){ score.best=score.gates; try{ localStorage.setItem("skyrunner.best",String(score.best)); }catch(e){} }
    } else { score.miss++; showMsg("MISS",900); beep(300,0.2,"square"); }
    advanceGate(); return;
  }
  if(d.length()>3200){ score.miss++; showMsg("MISS",900); advanceGate(); return; }
  g.sideLast=s;
}

// ================= Input =================
var keys={}, inp={pitch:0,roll:0,yaw:0,throttle:0.6,ab:false}, touch={stick:null,thr:null,pitch:0,roll:0};
var PREVENT={ArrowUp:1,ArrowDown:1,ArrowLeft:1,ArrowRight:1,Space:1,PageUp:1,PageDown:1};
window.addEventListener("keydown",function(e){ if(e.target&&e.target.tagName==="BUTTON"&&e.code==="Space") return; keys[e.code]=true; if(PREVENT[e.code]) e.preventDefault(); if(!e.repeat) onKey(e.code); });
window.addEventListener("keyup",function(e){ keys[e.code]=false; });
window.addEventListener("blur",function(){ keys={}; });
function approach(v,t,r){ return v<t?Math.min(v+r,t):Math.max(v-r,t); }
function readInputs(dt){
  var tp=0,tr=0,ty=0;
  // Keyboard is digital: cap the pull so a held key gives a firm turn (~5 g at corner speed) instead of an instant stall. Touch/mouse stick stays analog to ±1.
  if(keys.ArrowDown||keys.KeyS) tp+=0.55; if(keys.ArrowUp||keys.KeyW) tp-=0.55;
  if(keys.ArrowRight||keys.KeyD) tr+=1; if(keys.ArrowLeft||keys.KeyA) tr-=1;
  if(keys.KeyE) ty+=1; if(keys.KeyQ) ty-=1;
  if(keys.ShiftLeft||keys.ShiftRight||keys.PageUp) inp.throttle=Math.min(1,inp.throttle+dt*0.45);
  if(keys.KeyZ||keys.KeyX||keys.PageDown) inp.throttle=Math.max(0,inp.throttle-dt*0.45);
  inp.ab=!!keys.Space;
  if(touch.stick){ tp=touch.pitch; tr=touch.roll; }
  inp.pitch=approach(inp.pitch,tp,dt*5); inp.roll=approach(inp.roll,tr,dt*7); inp.yaw=approach(inp.yaw,ty,dt*5);
  fm.setControls({pitch:inp.pitch,roll:inp.roll,yaw:inp.yaw,throttle:inp.throttle,afterburner:inp.ab});
}
function clamp(v,a,b){ return v<a?a:v>b?b:v; }
glc.addEventListener("pointerdown",function(e){
  if(!running) return; e.preventDefault(); try{ glc.setPointerCapture(e.pointerId); }catch(err){}
  if(e.clientX<window.innerWidth/2){ if(!touch.stick) touch.stick={id:e.pointerId,x0:e.clientX,y0:e.clientY}; }
  else if(!touch.thr) touch.thr={id:e.pointerId,y0:e.clientY,t0:inp.throttle};
});
glc.addEventListener("pointermove",function(e){
  if(touch.stick&&touch.stick.id===e.pointerId){ touch.roll=clamp((e.clientX-touch.stick.x0)/70,-1,1); touch.pitch=clamp((e.clientY-touch.stick.y0)/80,-1,1); }
  if(touch.thr&&touch.thr.id===e.pointerId){ inp.throttle=clamp(touch.thr.t0+(touch.thr.y0-e.clientY)/220,0,1); }
});
function endPointer(e){ if(touch.stick&&touch.stick.id===e.pointerId){ touch.stick=null; touch.pitch=0; touch.roll=0; } if(touch.thr&&touch.thr.id===e.pointerId) touch.thr=null; }
glc.addEventListener("pointerup",endPointer); glc.addEventListener("pointercancel",endPointer);

// ================= Audio (starts on the launch button) =================
var audio={ctx:null,muted:false};
function audioInit(){
  if(audio.ctx) return;
  try{
    var AC=window.AudioContext||window.webkitAudioContext; if(!AC) return; var c=new AC(); audio.ctx=c;
    var master=c.createGain(); master.gain.value=audio.muted?0:1; master.connect(c.destination); audio.master=master;
    var osc=c.createOscillator(); osc.type="sawtooth"; osc.frequency.value=80;
    var lp=c.createBiquadFilter(); lp.type="lowpass"; lp.frequency.value=300; lp.Q.value=2;
    var eg=c.createGain(); eg.gain.value=0; osc.connect(lp); lp.connect(eg); eg.connect(master); osc.start();
    var whine=c.createOscillator(); whine.type="sine"; whine.frequency.value=640; var wg=c.createGain(); wg.gain.value=0; whine.connect(wg); wg.connect(master); whine.start();
    var buf=c.createBuffer(1,c.sampleRate*2,c.sampleRate), d=buf.getChannelData(0); for(var i=0;i<d.length;i++) d[i]=Math.random()*2-1;
    var ns=c.createBufferSource(); ns.buffer=buf; ns.loop=true; var bp=c.createBiquadFilter(); bp.type="bandpass"; bp.frequency.value=700; bp.Q.value=0.6;
    var ng=c.createGain(); ng.gain.value=0; ns.connect(bp); bp.connect(ng); ng.connect(master); ns.start();
    audio.osc=osc; audio.lp=lp; audio.eng=eg; audio.whine=whine; audio.wg=wg; audio.wind=ng;
  }catch(e){ audio.ctx=null; }
}
function audioUpdate(){
  if(!audio.ctx) return; var t=audio.ctx.currentTime, thr=fm.throttleActual||0, ab=inp.ab?1:0;
  audio.osc.frequency.setTargetAtTime(55+thr*115+ab*45,t,0.2); audio.lp.frequency.setTargetAtTime(220+thr*900+ab*600,t,0.2);
  audio.eng.gain.setTargetAtTime(0.025+thr*0.085+ab*0.06,t,0.15);
  audio.whine.frequency.setTargetAtTime(500+thr*900,t,0.3); audio.wg.gain.setTargetAtTime(0.006+thr*0.018,t,0.2);
  audio.wind.gain.setTargetAtTime(Math.min((fm.ias||0)/330,1.2)*0.1,t,0.15);
}
function beep(freq,dur,type){
  if(!audio.ctx||audio.muted) return;
  try{ var c=audio.ctx, o=c.createOscillator(), g=c.createGain(), t=c.currentTime; o.type=type||"sine"; o.frequency.value=freq; g.gain.setValueAtTime(0.0001,t); g.gain.exponentialRampToValueAtTime(0.18,t+0.01); g.gain.exponentialRampToValueAtTime(0.0001,t+dur); o.connect(g); g.connect(audio.master); o.start(t); o.stop(t+dur+0.02); }catch(e){}
}
function setMuted(m){ audio.muted=m; if(audio.master) audio.master.gain.setTargetAtTime(m?0:1,audio.ctx.currentTime,0.05); var b=document.getElementById("bMute"); if(b.firstChild) b.firstChild.nodeValue=m?"音 OFF":"音"; }

// ================= HUD (2D canvas overlay) =================
var HUD_COL="#8dff9c", WARN_COL="#ff5d45", ACC_COL="#ffb347", MONO='"Share Tech Mono","Consolas",monospace';
var dpr=1, W=1, H=1, fs=12, tmpV3=new THREE.Vector3(), P={x:0,y:0,z:0};
var warn={pull:false,stall:false};
function resize(){ W=window.innerWidth; H=window.innerHeight; dpr=Math.min(window.devicePixelRatio||1,2); renderer.setSize(W,H,false); camera.aspect=W/H; camera.updateProjectionMatrix(); hud.width=Math.round(W*dpr); hud.height=Math.round(H*dpr); }
window.addEventListener("resize",resize); resize();
function line(x1,y1,x2,y2){ ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke(); }
function pad3(n){ n=Math.round(n)%360; if(n<0) n+=360; return (n<10?"00":n<100?"0":"")+n; }
function tape(x,val,pxPerUnit,tick,labelEvery,side,S,cy){
  var Hh=S*0.42, top=cy-Hh/2, range=Hh/2/pxPerUnit, u0=Math.floor((val-range)/tick)*tick, u1=val+range, u, y, isL, len;
  ctx.save(); ctx.beginPath(); ctx.rect(side>0?x-S*0.13:x-S*0.03, top, S*0.16, Hh); ctx.clip();
  line(x,top,x,top+Hh);
  for(u=u0;u<=u1;u+=tick){ if(u<0) continue; y=cy-(u-val)*pxPerUnit; isL=Math.abs(Math.round(u)%labelEvery)<1e-6; len=isL?S*0.02:S*0.011; line(x,y,x-side*len,y); if(isL){ ctx.textAlign=side>0?"right":"left"; ctx.fillText(Math.round(u),x-side*(len+5),y); } }
  ctx.restore();
  var bw=S*0.095, bh=S*0.05, bx=side>0?x+7:x-7-bw;
  ctx.fillStyle="rgba(8,12,24,0.78)"; ctx.fillRect(bx,cy-bh/2,bw,bh); ctx.strokeRect(bx,cy-bh/2,bw,bh);
  ctx.fillStyle=HUD_COL; ctx.beginPath(); ctx.moveTo(x,cy); ctx.lineTo(x+side*7,cy-5); ctx.lineTo(x+side*7,cy+5); ctx.closePath(); ctx.fill();
  ctx.font=Math.round(fs*1.4)+"px "+MONO; ctx.textAlign="center"; ctx.fillText(Math.round(val),bx+bw/2,cy+1); ctx.font=fs+"px "+MONO;
}
function drawHUD(now){
  ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,W,H);
  if(!started) return;
  var cx=W/2, cy=H/2, S=Math.min(W,H), blink=Math.floor(now/250)%2===0;
  fs=Math.max(11,Math.round(S*0.024));
  ctx.lineWidth=1.5; ctx.strokeStyle=HUD_COL; ctx.fillStyle=HUD_COL; ctx.font=fs+"px "+MONO; ctx.textBaseline="middle"; ctx.lineJoin="round"; ctx.lineCap="round";
  ctx.shadowColor="rgba(0,0,0,0.6)"; ctx.shadowBlur=3;
  var pitchDeg=fm.pitch*57.29578, bank=fm.bank, hdg=fm.heading*57.29578, ppd=S*0.011;
  var iasKt=fm.ias*1.94384, altFt=fm.pos.y*3.28084, vsFpm=fm.vs*196.85, aglFt=(fm.pos.y-groundHeight(fm.pos.x,fm.pos.z))*3.28084;

  // --- pitch ladder (rotates with bank, slides with pitch) ---
  ctx.save(); ctx.beginPath(); ctx.rect(cx-S*0.24,cy-S*0.3,S*0.48,S*0.6); ctx.clip();
  ctx.translate(cx,cy); ctx.rotate(-bank); ctx.translate(0,pitchDeg*ppd);
  ctx.lineWidth=2; line(-S*0.34,0,-S*0.06,0); line(S*0.06,0,S*0.34,0); ctx.lineWidth=1.5;
  var d, y, hw=S*0.07, gap=S*0.045, td;
  for(d=-90; d<=90; d+=10){
    if(d===0) continue; y=-d*ppd; if(Math.abs(y+pitchDeg*ppd)>S*0.4) continue;
    ctx.setLineDash(d<0?[5,5]:[]); line(-hw-gap,y,-gap,y); line(gap,y,hw+gap,y); ctx.setLineDash([]);
    td=d>0?1:-1; line(-hw-gap,y,-hw-gap,y+td*S*0.012); line(hw+gap,y,hw+gap,y+td*S*0.012);
    ctx.textAlign="right"; ctx.fillText(Math.abs(d),-hw-gap-6,y); ctx.textAlign="left"; ctx.fillText(Math.abs(d),hw+gap+6,y);
  }
  ctx.restore();

  // --- bank scale ---
  var R=S*0.3, marks=[-60,-45,-30,-20,-10,0,10,20,30,45,60], i, a, r, len;
  ctx.save(); ctx.translate(cx,cy);
  for(i=0;i<marks.length;i++){ a=marks[i]; r=a*Math.PI/180; len=(a%30===0)?S*0.018:S*0.01; line(Math.sin(r)*R,-Math.cos(r)*R,Math.sin(r)*(R+len),-Math.cos(r)*(R+len)); }
  ctx.rotate(-bank); ctx.beginPath(); ctx.moveTo(0,-R+2); ctx.lineTo(-S*0.01,-R+S*0.024); ctx.lineTo(S*0.01,-R+S*0.024); ctx.closePath(); ctx.fill();
  ctx.restore();

  // --- waterline symbol (fixed) ---
  ctx.lineWidth=2; var w=S*0.028;
  ctx.beginPath(); ctx.moveTo(cx-w*1.7,cy); ctx.lineTo(cx-w*0.8,cy); ctx.lineTo(cx-w*0.4,cy+w*0.45); ctx.lineTo(cx,cy); ctx.lineTo(cx+w*0.4,cy+w*0.45); ctx.lineTo(cx+w*0.8,cy); ctx.lineTo(cx+w*1.7,cy); ctx.stroke();

  // --- flight path vector (where the velocity actually points) ---
  if(fm.vel.lengthSq()>4){
    tmpV3.copy(fm.vel).normalize(); tmpV.copy(fm.pos).addScaledVector(tmpV3,300).project(camera);
    if(tmpV.z<1){
      var fx=clamp((tmpV.x+1)/2*W,cx-S*0.22,cx+S*0.22), fy=clamp((1-tmpV.y)/2*H,cy-S*0.28,cy+S*0.28), fr=S*0.012;
      ctx.beginPath(); ctx.arc(fx,fy,fr,0,Math.PI*2); ctx.stroke(); line(fx-fr,fy,fx-fr*2.4,fy); line(fx+fr,fy,fx+fr*2.4,fy); line(fx,fy-fr,fx,fy-fr*1.9);
    }
  }
  ctx.lineWidth=1.5;

  // --- speed / altitude tapes ---
  tape(cx-S*0.31,iasKt,S*0.0022,10,50,1,S,cy);
  tape(cx+S*0.31,altFt,S*0.00045,100,500,-1,S,cy);

  // --- heading tape ---
  var hy=cy-S*0.39, hw2=S*0.22, ppdH=S*0.0045, h0=Math.floor((hdg-hw2/ppdH)/5)*5, h1=hdg+hw2/ppdH, hh, x, is10, hn, lbl;
  ctx.save(); ctx.beginPath(); ctx.rect(cx-hw2,hy-S*0.05,hw2*2,S*0.06); ctx.clip();
  line(cx-hw2,hy,cx+hw2,hy);
  for(hh=h0;hh<=h1;hh+=5){ x=cx+(hh-hdg)*ppdH; is10=((hh%10)+10)%10===0; hn=((hh%360)+360)%360; line(x,hy,x,hy-(is10?S*0.016:S*0.009)); if(is10){ ctx.textAlign="center"; lbl=hn===0?"N":hn===90?"E":hn===180?"S":hn===270?"W":String(hn/10); ctx.fillText(lbl,x,hy-S*0.03); } }
  ctx.restore();
  ctx.beginPath(); ctx.moveTo(cx,hy+1); ctx.lineTo(cx-5,hy+8); ctx.lineTo(cx+5,hy+8); ctx.closePath(); ctx.fill();
  var hbw=S*0.08, hbh=S*0.045; ctx.fillStyle="rgba(8,12,24,0.78)"; ctx.fillRect(cx-hbw/2,hy+9,hbw,hbh); ctx.strokeRect(cx-hbw/2,hy+9,hbw,hbh); ctx.fillStyle=HUD_COL;
  ctx.font=Math.round(fs*1.3)+"px "+MONO; ctx.textAlign="center"; ctx.fillText(pad3(hdg),cx,hy+9+hbh/2+1); ctx.font=fs+"px "+MONO;

  // --- data blocks ---
  var lx=cx-S*0.44, rx=cx+S*0.44, ly=cy+S*0.25, lh=fs*1.5;
  ctx.textAlign="left";
  ctx.fillText("THR "+Math.round((fm.throttleActual||0)*100)+"%"+(inp.ab?"  AB":""),lx,ly);
  ctx.fillText("G   "+(fm.gLoad||0).toFixed(1),lx,ly+lh);
  ctx.fillText("M   "+(fm.mach||0).toFixed(2),lx,ly+lh*2);
  ctx.fillText("AOA "+(fm.alpha*57.29578).toFixed(1)+"°",lx,ly+lh*3);
  ctx.textAlign="right";
  ctx.fillText("VS "+(vsFpm>=0?"+":"")+Math.round(vsFpm/10)*10,rx,ly);
  ctx.fillText("AGL "+Math.max(0,Math.round(aglFt/10)*10),rx,ly+lh);
  ctx.fillText("TAS "+Math.round(fm.tas*1.94384)+" kt",rx,ly+lh*2);
  ctx.fillText(TOD[todIndex].name,rx,ly+lh*3);

  // --- next gate marker ---
  var g=gates[0];
  if(g){
    tmpV3.copy(g.pos).applyMatrix4(camera.matrixWorldInverse);
    var dist=fm.pos.distanceTo(g.pos), dl=dist>=1000?(dist/1000).toFixed(1)+" km":Math.round(dist)+" m", ang, onScreen=false, gx, gy2;
    if(tmpV3.z<0){ tmpV.copy(g.pos).project(camera); if(Math.abs(tmpV.x)<=1&&Math.abs(tmpV.y)<=1){ onScreen=true; gx=(tmpV.x+1)/2*W; gy2=(1-tmpV.y)/2*H; } else ang=Math.atan2(-tmpV.y,tmpV.x); }
    else ang=Math.atan2(-tmpV3.y,tmpV3.x);
    ctx.strokeStyle=ACC_COL; ctx.fillStyle=ACC_COL; ctx.lineWidth=2;
    if(onScreen){
      var ds=S*0.02; ctx.beginPath(); ctx.moveTo(gx,gy2-ds); ctx.lineTo(gx+ds,gy2); ctx.lineTo(gx,gy2+ds); ctx.lineTo(gx-ds,gy2); ctx.closePath(); ctx.stroke();
      ctx.textAlign="center"; ctx.fillText(dl,gx,gy2+ds+fs*0.9);
    } else {
      var ar=S*0.27, ax=cx+Math.cos(ang)*ar, ay=cy+Math.sin(ang)*ar;
      ctx.save(); ctx.translate(ax,ay); ctx.rotate(ang); ctx.beginPath(); ctx.moveTo(S*0.02,0); ctx.lineTo(-S*0.012,-S*0.014); ctx.lineTo(-S*0.012,S*0.014); ctx.closePath(); ctx.fill(); ctx.restore();
      ctx.textAlign="center"; ctx.fillText(dl,cx+Math.cos(ang)*(ar-S*0.045),cy+Math.sin(ang)*(ar-S*0.045));
    }
    ctx.strokeStyle=HUD_COL; ctx.fillStyle=HUD_COL; ctx.lineWidth=1.5;
  }

  // --- warnings ---
  ctx.textAlign="center"; ctx.font="bold "+Math.round(fs*1.9)+"px "+MONO;
  if(warn.pull&&blink){ ctx.fillStyle=WARN_COL; ctx.fillText("PULL UP",cx,cy+S*0.13); }
  if(warn.stall&&!warn.pull&&blink){ ctx.fillStyle=WARN_COL; ctx.fillText("STALL",cx,cy+S*0.13); }
  if(paused){ ctx.fillStyle=ACC_COL; ctx.fillText("PAUSED",cx,cy-S*0.13); }
  if(touch.stick){ ctx.strokeStyle="rgba(141,255,156,0.5)"; ctx.beginPath(); ctx.arc(touch.stick.x0,touch.stick.y0,70,0,Math.PI*2); ctx.stroke(); ctx.beginPath(); ctx.arc(touch.stick.x0+touch.roll*70,touch.stick.y0+touch.pitch*80,14,0,Math.PI*2); ctx.stroke(); }
  ctx.fillStyle=HUD_COL; ctx.font=fs+"px "+MONO; ctx.shadowBlur=0;
}

// ================= Game loop / UI wiring =================
var running=false, started=false, paused=false, lastT=0, viewExt=false, warnT=0, msgT=null;
var camUp=new THREE.Vector3(0,1,0), camTarget=new THREE.Vector3();
var $=function(id){ return document.getElementById(id); };
var overlay=$("overlay"), startCard=$("start"), result=$("result"), chip=$("chip"), btns=$("btns"), zones=$("zones");
function showMsg(t,ms){ var el=$("msg"); el.textContent=t; el.classList.add("show"); clearTimeout(msgT); msgT=setTimeout(function(){ el.classList.remove("show"); },ms||1000); }
function pad2(n){ return (n<10?"0":"")+n; }
function fmtTime(s){ s=Math.floor(s); return pad2(Math.floor(s/60))+":"+pad2(s%60); }
function updateChip(){ $("cGates").textContent=score.gates; $("cTime").textContent=fmtTime(score.time); $("cBest").textContent=score.best; }
function startRun(){
  spawnAircraft(); resetGates();
  score.gates=0; score.miss=0; score.perfect=0; score.time=0;
  paused=false; running=true; started=true;
  overlay.hidden=true; chip.hidden=false; btns.hidden=false; zones.hidden=!(("ontouchstart" in window)||navigator.maxTouchPoints>0);
  lastCx=null; updateChunks(fm.pos.x,fm.pos.z); camUp.set(0,1,0); camera.position.copy(fm.pos); updateChip();
  showMsg("オレンジのリングをくぐれ",1800);
}
function crash(){
  running=false; beep(110,0.7,"sawtooth");
  $("rGates").textContent=score.gates; $("rTime").textContent=fmtTime(score.time); $("rBest").textContent=score.best;
  $("rNote").textContent="くぐったリング "+score.gates+"（うちど真ん中 "+score.perfect+"）、外したリング "+score.miss+"。同じ場所の上空に戻って、リングも新しく配置されます。";
  startCard.hidden=true; result.classList.add("show"); overlay.hidden=false;
}
function onKey(code){
  if(code==="KeyV") toggleView();
  else if(code==="KeyT") cycleTOD();
  else if(code==="KeyM") setMuted(!audio.muted);
  else if(code==="KeyR"&&started) startRun();
  else if(code==="KeyP"&&running){ paused=!paused; }
}
function toggleView(){ viewExt=!viewExt; showMsg(viewExt?"外部視点":"HUD視点",800); }
function cycleTOD(){ applyTOD((todIndex+1)%TOD.length); showMsg(TOD[todIndex].name,900); }
function wire(id,fn){ $(id).addEventListener("click",function(){ fn(); this.blur(); }); }
wire("bGo",function(){ audioInit(); if(audio.ctx&&audio.ctx.state==="suspended") audio.ctx.resume(); startRun(); });
wire("bAgain",function(){ startRun(); });
wire("bView",toggleView); wire("bTime",cycleTOD); wire("bMute",function(){ setMuted(!audio.muted); }); wire("bReset",function(){ startRun(); });
document.addEventListener("visibilitychange",function(){ if(document.hidden&&running) paused=true; });

function frame(t){
  requestAnimationFrame(frame);
  var dt=Math.min((t-lastT)/1000,0.1)||0; lastT=t;
  if(document.hidden) return;
  if(running&&!paused){
    readInputs(dt); fm.step(dt); score.time+=dt; updateGates();
    var gy=groundHeight(fm.pos.x,fm.pos.z), agl=fm.pos.y-gy;
    if(agl<2.5){ crash(); }
    warn.pull=running&&((agl<170&&fm.vs<-7)||(agl<60&&fm.vs<-1)); warn.stall=!!fm.stalled;
    if(warn.pull){ warnT+=dt; if(warnT>=0.5){ warnT=0; beep(720,0.12,"square"); } } else warnT=0.5;
    audioUpdate(); updateChip();
  } else if(audio.ctx&&audio.eng){ audio.eng.gain.setTargetAtTime(0,audio.ctx.currentTime,0.3); audio.wind.gain.setTargetAtTime(0,audio.ctx.currentTime,0.3); audio.wg.gain.setTargetAtTime(0,audio.ctx.currentTime,0.3); }
  acGroup.position.copy(fm.pos); acGroup.quaternion.copy(fm.q); acGroup.visible=viewExt; abFlame.visible=viewExt&&inp.ab&&running;
  var fwd=tmpV.set(0,0,-1).applyQuaternion(fm.q), up=tmpV2.set(0,1,0).applyQuaternion(fm.q);
  if(viewExt){
    camTarget.copy(fm.pos).addScaledVector(fwd,-30).addScaledVector(up,8);
    camera.position.lerp(camTarget,1-Math.exp(-dt*6)); camUp.lerp(up,1-Math.exp(-dt*3)).normalize(); camera.up.copy(camUp);
    camera.lookAt(tmpV3.copy(fm.pos).addScaledVector(fwd,40));
  } else {
    camera.position.copy(fm.pos).addScaledVector(fwd,2.5).addScaledVector(up,0.9); camera.quaternion.copy(fm.q); camera.up.set(0,1,0);
  }
  sky.position.copy(camera.position); water.position.set(fm.pos.x,0,fm.pos.z); updateChunks(fm.pos.x,fm.pos.z);
  renderer.render(scene,camera); drawHUD(t);
}

function boot(data){
  spawnAircraft(); updateChunks(fm.pos.x,fm.pos.z); updateChip();
  if(data&&data.tod!=null) applyTOD(data.tod);
  if(data&&data.started){ startRun(); if(data.pos){ fm.pos.fromArray(data.pos); fm.q.fromArray(data.q); fm.vel.fromArray(data.vel); } if(data.score){ score.gates=data.score.gates||0; score.time=data.score.time||0; score.miss=data.score.miss||0; score.perfect=data.score.perfect||0; } viewExt=!!data.viewExt; lastCx=null; }
  requestAnimationFrame(frame);
}
if(window.claude&&window.claude.hot&&window.claude.hot.snapshot){ window.claude.hot.snapshot(function(){ return {started:started&&running,pos:fm.pos.toArray(),q:fm.q.toArray(),vel:fm.vel.toArray(),score:{gates:score.gates,time:score.time,miss:score.miss,perfect:score.perfect},tod:todIndex,viewExt:viewExt}; }); }
if(window.claude&&window.claude.hot&&window.claude.hot.ready) window.claude.hot.ready(boot); else boot((window.claude&&window.claude.hot&&window.claude.hot.data)||{});
})();
