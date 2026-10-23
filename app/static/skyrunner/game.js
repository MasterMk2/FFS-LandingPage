(function(){
'use strict';
// ================= World: terrain, island airfield and race course (world.js, shared with the Node tests) =================
var snoise=World.snoise, terrainHeight=World.terrainHeight, groundHeight=World.groundHeight, RWY=World.RWY, COURSE=World.COURSE;
var R2D=180/Math.PI, KT=1.94384, FPM=196.85;

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
var cTmp=new THREE.Color(), cSand=new THREE.Color(0xd8c48c), cGrass=new THREE.Color(0x5e8a3c), cGrass2=new THREE.Color(0x3e6b2b), cRock=new THREE.Color(0x7d6f66), cSnow=new THREE.Color(0xeef0f6), cDeep=new THREE.Color(0x244a6a), cField=new THREE.Color(0x6b8f47);
function makeChunk(){
  var n=SEG*SEG*6, g=new THREE.BufferGeometry();
  g.setAttribute("position",new THREE.BufferAttribute(new Float32Array(n*3),3));
  g.setAttribute("color",new THREE.BufferAttribute(new Float32Array(n*3),3));
  var m=new THREE.Mesh(g,terrainMat); m.userData.cx=NaN; m.userData.cz=NaN; scene.add(m); chunks.push(m); return m;
}
function faceColor(h,slope,x,z){
  var v=snoise(x*0.002,z*0.002)*0.5+0.5;
  if(World.airfieldWeight(x,z)>=1) return cTmp.copy(cField).multiplyScalar(0.9+v*0.14); // mown grass on the airfield island
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
var mode="ring"; // "ring" endless rings | "race" pylon air race | "land" landing on runway 09
// Each mode starts somewhere else: rings high over the origin, the race straight-in to the start gate, the landing
// on the 3 deg glide path with the gear down.
function spawnState(){
  if(mode==="race"){ var sp=COURSE.spawn; return {pos:new THREE.Vector3(sp.x,COURSE.spawnAlt,sp.z), heading:sp.heading, speed:COURSE.spawnSpeed}; }
  if(mode==="land"){ var d=RWY.spawnDist; return {pos:new THREE.Vector3(RWY.thrX-RWY.fx*d, RWY.elev+(d+RWY.aim)*Math.tan(RWY.glide), RWY.thrZ-RWY.fz*d), heading:RWY.heading, speed:RWY.spawnSpeed, gamma:-RWY.glide, gear:true}; }
  var gy=groundHeight(START_POS.x,START_POS.z);
  return {pos:new THREE.Vector3(START_POS.x, Math.max(gy+900, 700), START_POS.z), heading:0, speed:205};
}
function spawnAircraft(){
  var st=spawnState(); fm.reset(st);
  inp.throttle=fm.controls&&typeof fm.controls.throttle==="number"?fm.controls.throttle:0.6;
  inp.pitch=0; inp.roll=0; inp.yaw=0; inp.ab=false; inp.brake=false; inp.gear=!!st.gear;
}

// ================= Aircraft mesh (external view) - built in aircraft.js =================
var jet=SkyrunnerJet.create(scene), acGroup=jet.root; scene.add(acGroup);
var TOD_DARK=[0.55,0.15,1];   // how much the jet's lights stand out at each time of day

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

// ================= Airfield: runway 09 on the island (markings, lights, PAPI, buildings) =================
// Built in runway-local coordinates: x = metres right of the centreline, z = -(metres past the landing threshold).
var field=new THREE.Group(); field.position.set(RWY.thrX,RWY.elev,RWY.thrZ); field.rotation.y=-RWY.heading; scene.add(field);
var PAPI_SET=[3.5,3.1667,2.8333,2.5], papi={pts:null,x:0,z:0,state:-1}; // light settings in deg, inner (next to the runway) first
function rectGeo(rects,y){ // rects [x0,a0,x1,a1] (across, along) -> upward-facing quads at height y
  var pos=new Float32Array(rects.length*18), p=0, i, r, x0, x1, z0, z1;
  for(i=0;i<rects.length;i++){
    r=rects[i]; x0=Math.min(r[0],r[2]); x1=Math.max(r[0],r[2]); z0=-Math.max(r[1],r[3]); z1=-Math.min(r[1],r[3]);
    pos.set([x0,y,z0, x0,y,z1, x1,y,z0, x1,y,z0, x0,y,z1, x1,y,z1],p); p+=18;
  }
  var g=new THREE.BufferGeometry(); g.setAttribute("position",new THREE.BufferAttribute(pos,3)); g.computeVertexNormals(); return g;
}
// runway designators as seven-segment digits: 18 m tall, reading upright from the approach (flip for the far end)
var SEG7={"0":"abcdef","2":"abdeg","7":"abc","9":"abcdfg"};
function digitRects(ch,cx,a0,flip,out){
  var h=18, hw=4.5, t=1.8, s=SEG7[ch], i, r, seg={a:[-hw,h-t,hw,h],b:[hw-t,h/2,hw,h],c:[hw-t,0,hw,h/2],d:[-hw,0,hw,t],e:[-hw,0,-hw+t,h/2],f:[-hw,h/2,-hw+t,h],g:[-hw,h/2-t/2,hw,h/2+t/2]};
  for(i=0;i<s.length;i++){ r=seg[s[i]]; out.push(flip?[cx-r[0],a0-r[1],cx-r[2],a0-r[3]]:[cx+r[0],a0+r[1],cx+r[2],a0+r[3]]); }
}
function pointsObj(list,size){ // list of [x,y,z,r,g,b]; fixed pixel size and no fog, so the lights read from far out
  var n=list.length, pos=new Float32Array(n*3), col=new Float32Array(n*3), i;
  for(i=0;i<n;i++){ pos[i*3]=list[i][0]; pos[i*3+1]=list[i][1]; pos[i*3+2]=list[i][2]; col[i*3]=list[i][3]; col[i*3+1]=list[i][4]; col[i*3+2]=list[i][5]; }
  var g=new THREE.BufferGeometry(); g.setAttribute("position",new THREE.BufferAttribute(pos,3)); g.setAttribute("color",new THREE.BufferAttribute(col,3));
  return new THREE.Points(g,new THREE.PointsMaterial({size:size,sizeAttenuation:false,vertexColors:true,fog:false,transparent:true,depthWrite:false}));
}
(function(){
  var L=RWY.length, Wd=RWY.width, mk=[], k, a, c, lights=[];
  function flat(rects,color,y,off){ var m=new THREE.Mesh(rectGeo(rects,y),new THREE.MeshLambertMaterial({color:color,polygonOffset:true,polygonOffsetFactor:off,polygonOffsetUnits:off*2})); field.add(m); return m; }
  flat([[-Wd/2,0,Wd/2,L]],0x34373d,0.06,-2);                                  // asphalt
  flat([[-215,880,-110,1520],[-110,1160,-Wd/2,1184]],0x7c7f86,0.05,-1);         // apron + taxiway
  mk.push([-Wd/2+0.5,0,-Wd/2+1.4,L],[Wd/2-1.4,0,Wd/2-0.5,L]);                 // edge lines
  for(k=0;k<8;k++){ c=2.6+k*3.3; mk.push([c,6,c+1.8,36],[-c-1.8,6,-c,36],[c,L-36,c+1.8,L-6],[-c-1.8,L-36,-c,L-6]); } // threshold bars
  digitRects("0",-6,44,false,mk); digitRects("9",6,44,false,mk); digitRects("2",6,L-44,true,mk); digitRects("7",-6,L-44,true,mk);
  for(a=80;a<L-110;a+=50) mk.push([-0.45,a,0.45,a+30]);                       // centreline
  [[RWY.aim,60],[L-RWY.aim-60,60]].forEach(function(q){ mk.push([9,q[0],16,q[0]+q[1]],[-16,q[0],-9,q[0]+q[1]]); }); // aiming points
  [150,450,L-172.5,L-472.5].forEach(function(a0){ for(k=0;k<3;k++){ c=9+k*3.3; mk.push([c,a0,c+1.8,a0+22.5],[-c-1.8,a0,-c,a0+22.5]); } }); // touchdown zone
  flat(mk,0xe9ebee,0.08,-3);
  // buildings north of the apron: control tower and three arched hangars
  var wall=new THREE.MeshLambertMaterial({color:0xb9bcc4}), roof=new THREE.MeshPhongMaterial({color:0x7f8794,flatShading:true,shininess:10}), glass=new THREE.MeshLambertMaterial({color:0x1d3550,emissive:0x2a4d70,emissiveIntensity:0.5});
  var tw=new THREE.Mesh(new THREE.BoxGeometry(8,26,8),wall); tw.position.set(-235,13,-1000); field.add(tw);
  var cab=new THREE.Mesh(new THREE.BoxGeometry(12,5,12),glass); cab.position.set(-235,28.5,-1000); field.add(cab);
  var arch=new THREE.CylinderGeometry(1,1,1,14,1,false,-Math.PI/2,Math.PI); arch.rotateX(-Math.PI/2); arch.rotateY(Math.PI/2);
  for(k=0;k<3;k++){
    var hb=new THREE.Mesh(new THREE.BoxGeometry(40,12,55),wall); hb.position.set(-240,6,-(1250+k*70)); field.add(hb);
    var hr=new THREE.Mesh(arch,roof); hr.scale.set(40,9,27.5); hr.position.set(-240,12,-(1250+k*70)); field.add(hr);
  }
  // lights: edges (warm white), threshold (green), runway end (red), approach centreline + crossbar, PAPI
  for(a=0;a<=L;a+=60){ lights.push([-(Wd/2+1.5),0.4,-a,1,0.92,0.75],[Wd/2+1.5,0.4,-a,1,0.92,0.75]); }
  for(c=-Wd/2;c<=Wd/2;c+=4){ lights.push([c,0.4,1.5,0.35,1,0.5],[c,0.4,-(L+1.5),1,0.25,0.2]); }
  for(a=60;a<=900;a+=30) lights.push([0,1,a,1,1,0.9]);
  for(c=-21;c<=21;c+=3) if(c) lights.push([c,1,300,1,1,0.9]);
  field.add(pointsObj(lights,4));
  var pl=[]; for(k=0;k<4;k++) pl.push([-(Wd/2+18+k*9),0.8,-RWY.aim,1,0.2,0.15]);
  papi.pts=pointsObj(pl,7); field.add(papi.pts);
  papi.x=RWY.thrX+RWY.fx*RWY.aim-RWY.rx*(Wd/2+31); papi.z=RWY.thrZ+RWY.fz*RWY.aim-RWY.rz*(Wd/2+31);
})();
// PAPI: each unit shows white above its setting, red below; on the 3 deg path the outer two are white, the inner two red.
function updatePapi(){
  var dx=camera.position.x-papi.x, dz=camera.position.z-papi.z, hd=Math.sqrt(dx*dx+dz*dz);
  if(hd>16000) return;
  var ang=Math.atan2(camera.position.y-RWY.elev-0.8,hd)*R2D, st=0, k;
  for(k=0;k<4;k++) if(ang>PAPI_SET[k]) st|=1<<k;
  if(st===papi.state) return; papi.state=st;
  var col=papi.pts.geometry.attributes.color;
  for(k=0;k<4;k++){ var w=(st>>k)&1; col.setXYZ(k,1,w?1:0.2,w?1:0.15); }
  col.needsUpdate=true;
}

// ================= Air race: pylon gates over the channel (visible in race mode only) =================
var raceGroup=new THREE.Group(); raceGroup.visible=false; scene.add(raceGroup);
var PYL_H=COURSE.pylonHeight, NG=COURSE.gates.length;
var race={step:0,t:0,pen:0,started:false,done:false,prevS:-1,miss:0,hits:0,splits:[],hit:[],pylons:[],tops:null};
var raceBest=null; try{ raceBest=JSON.parse(localStorage.getItem("skyrunner.raceBest")||"null"); if(!raceBest||!(raceBest.t>0)) raceBest=null; }catch(e){ raceBest=null; }
function pylonMat(c){ return new THREE.MeshLambertMaterial({color:c,emissive:c,emissiveIntensity:0.35}); }
var RACE_LOOK={next:[pylonMat(0xffb347),[1,0.7,0.28]], next2:[pylonMat(0x8fd8ff),[0.56,0.85,1]], idle:[pylonMat(0x2f7fd0),[0.18,0.5,0.82]], done:[pylonMat(0x5d6573),[0.36,0.4,0.45]], hit:[pylonMat(0xff5d45),[1,0.36,0.27]]};
(function(){
  var geo=new THREE.CylinderGeometry(1.5,2.6,PYL_H,10), cap=new THREE.CylinderGeometry(1.56,1.56,6,10), capMat=new THREE.MeshLambertMaterial({color:0xf2f4f8}), tops=[];
  COURSE.gates.forEach(function(g){
    var pair=[];
    [[g.ax,g.az],[g.bx,g.bz]].forEach(function(b){
      var m=new THREE.Mesh(geo,RACE_LOOK.idle[0]); m.position.set(b[0],PYL_H/2,b[1]);
      var c=new THREE.Mesh(cap,capMat); c.position.y=PYL_H/2-6; m.add(c);
      raceGroup.add(m); pair.push(m); tops.push([b[0],PYL_H+3,b[1],1,1,1]);
    });
    race.pylons.push(pair);
  });
  race.tops=pointsObj(tops,6); raceGroup.add(race.tops);
})();
function gateS(gi){ return World.gateFrame(gi,fm.pos.x,fm.pos.z).s; }
// colour every pylon by its gate's place in the lap: next (orange), the one after (light blue), later (blue), passed (grey), struck (red)
function raceLook(){
  var col=race.tops.geometry.attributes.color, gi, j, st, look;
  for(gi=0;gi<NG;gi++){
    st=race.step>gi?"done":"idle";
    if(!race.done&&gi===race.step%NG) st="next"; else if(race.step+1<=NG&&gi===(race.step+1)%NG) st="next2";
    for(j=0;j<2;j++){ look=RACE_LOOK[race.hit[gi][j]?"hit":st]; race.pylons[gi][j].material=look[0]; col.setXYZ(gi*2+j,look[1][0],look[1][1],look[1][2]); }
  }
  col.needsUpdate=true;
}
function resetRace(){
  race.step=0; race.t=0; race.pen=0; race.started=false; race.done=false; race.miss=0; race.hits=0; race.splits=[]; race.hit=[];
  for(var gi=0;gi<NG;gi++){ race.hit.push([false,false]); for(var j=0;j<2;j++){ race.pylons[gi][j].scale.y=1; race.pylons[gi][j].position.y=PYL_H/2; } }
  race.prevS=gateS(0); raceLook();
}
function knockPylon(gi,j){ var m=race.pylons[gi][j]; m.scale.y=0.25; m.position.y=PYL_H*0.125; } // deflates like an air-race pylon
function updateRace(dt){
  var gi=race.step%NG, gf=World.gateFrame(gi,fm.pos.x,fm.pos.z), s=gf.s, i, j, msg, pen=COURSE.penalty;
  if(race.started) race.t+=dt;
  if(fm.pos.y<PYL_H+0.5) for(i=0;i<NG;i++) for(j=0;j<2;j++){
    if(race.hit[i][j]) continue;
    var gp=COURSE.gates[i], px=j?gp.bx:gp.ax, pz=j?gp.bz:gp.az, ex=fm.pos.x-px, ez=fm.pos.z-pz;
    if(ex*ex+ez*ez<6.7*6.7){ race.hit[i][j]=true; race.hits++; race.pen+=pen; knockPylon(i,j); raceLook(); showMsg("PYLON HIT  +"+pen+"s",1300); beep(300,0.25,"square"); }
  }
  // gate judgement on crossing its plane. Wide of the judging window it does not count at all: the gate stays next
  // and has to be flown again (so cutting inside a turn apex never pays).
  var v=race.prevS<0&&s>=0?World.gateVerdict(gf.lat,fm.pos.y):undefined;
  if(v===null&&Math.abs(gf.lat)<3000) showMsg("ゲート未通過 — 戻ってくぐり直し",1800);
  if(v){
    if(v==="pass"){ msg=race.step===0?"START":race.step===NG?"FINISH":"GATE "+race.step+"/"+(NG-1); beep(1100,0.1); }
    else { race.pen+=pen; race.miss++; msg=(v==="high"?"TOO HIGH":"MISSED GATE")+"  +"+pen+"s"; beep(300,0.2,"square"); }
    if(race.step===0){ race.started=true; race.t=0; }
    else {
      var tt=race.t+race.pen; race.splits[race.step]=tt;
      if(raceBest&&raceBest.splits&&raceBest.splits[race.step]!=null){ var dd=tt-raceBest.splits[race.step]; msg+="   "+(dd<0?"-":"+")+Math.abs(dd).toFixed(2); }
    }
    if(race.step===NG){ finishRace(); return; }
    race.step++; race.prevS=gateS(race.step%NG); raceLook(); showMsg(msg,1300); return;
  }
  race.prevS=s;
}

// ================= Landing: touchdown capture, scoring =================
var HARD_SINK=3.6; // m/s (~710 fpm): the gear gives way above this
var land={td:null,bounces:0,air:0}, rwyA=0, rwyC=0; // aircraft position in runway terms: m past the threshold, m right of the centreline
var landBest=0; try{ landBest=parseInt(localStorage.getItem("skyrunner.landBest")||"0",10)||0; }catch(e){}
function updateRwyFrame(){ rwyA=World.rwyAlong(fm.pos.x,fm.pos.z)+RWY.length/2; rwyC=World.rwyAcross(fm.pos.x,fm.pos.z); }
function angDiff(a,b){ return Math.atan2(Math.sin(a-b),Math.cos(a-b)); }
// on final for runway 09 with the gear down: the terrain warnings give way to approach callouts there
function inApproach(){ return fm.gearPos>=1&&rwyA>-10000&&rwyA<RWY.length&&Math.abs(rwyC)<450&&Math.abs(angDiff(fm.heading,RWY.heading))<0.8; }
// runs before the crash rules, so a hard landing still reports its touchdown
function landTouch(vsB,wowB){
  if(fm.wow&&!wowB){
    if(!land.td){
      land.td={sink:-vsB,along:rwyA,across:rwyC,bank:fm.bank,ias:fm.ias};
      var fpm=Math.round(-vsB*FPM); showMsg((fpm<=120?"BUTTER!  ":"TOUCHDOWN  ")+fpm+" fpm",1600); beep(fpm<=240?1320:700,0.12);
    } else if(land.air>0.25){ land.bounces++; showMsg("BOUNCE",900); beep(500,0.12,"square"); }
  }
}
function updateLanding(dt){
  land.air=fm.wow?0:land.air+dt;
  if(land.td&&!fm.wow&&fm.pos.y-RWY.elev>50){ land.td=null; land.bounces=0; showMsg("GO AROUND",1400); } // touch-and-go: start over
  if(land.td&&fm.wow===3&&fm.groundSpeed<1) finishLanding();
}
// 100 points: sink rate 40, distance from the aiming point 30, centreline 20, wings level 10; -15 per bounce
function landingScore(td,bounces){
  function lin(v,best,zero){ return clamp((zero-v)/(zero-best),0,1); }
  var p=40*lin(td.sink,0.6,3.0)+30*lin(Math.abs(td.along-RWY.aim),60,500)+20*lin(Math.abs(td.across),2,20)+10*lin(Math.abs(td.bank*R2D),2,8);
  var total=Math.max(0,Math.round(p-15*bounces));
  return {total:total,grade:total>=90?"S":total>=75?"A":total>=55?"B":total>=35?"C":"D"};
}

// ================= Input =================
var keys={}, inp={pitch:0,roll:0,yaw:0,throttle:0.6,ab:false,brake:false,gear:false}, touch={stick:null,thr:null,pitch:0,roll:0,brake:false};
var PREVENT={ArrowUp:1,ArrowDown:1,ArrowLeft:1,ArrowRight:1,Space:1,PageUp:1,PageDown:1,Escape:1};
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
  inp.ab=!!keys.Space; inp.brake=!!keys.KeyB||touch.brake;
  if(touch.stick){ tp=touch.pitch; tr=touch.roll; }
  inp.pitch=approach(inp.pitch,tp,dt*5); inp.roll=approach(inp.roll,tr,dt*7); inp.yaw=approach(inp.yaw,ty,dt*5);
  // B: wheel brakes and speed brake together
  fm.setControls({pitch:inp.pitch,roll:inp.roll,yaw:inp.yaw,throttle:inp.throttle,afterburner:inp.ab,brake:inp.brake?1:0,speedBrake:inp.brake,gear:inp.gear});
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
var warn={pull:false,stall:false,sink:false,gear:false,high:false};
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
function fmtDist(d){ return d>=1000?(d/1000).toFixed(1)+" km":Math.round(d)+" m"; }
// target marker: diamond (+ label) when on screen, an arrow at the edge of the HUD when not (primary only)
function drawMarker(p,label,col,primary,S,cx,cy){
  tmpV3.copy(p).applyMatrix4(camera.matrixWorldInverse);
  var ang, onScreen=false, gx, gy2;
  if(tmpV3.z<0){ tmpV.copy(p).project(camera); if(Math.abs(tmpV.x)<=1&&Math.abs(tmpV.y)<=1){ onScreen=true; gx=(tmpV.x+1)/2*W; gy2=(1-tmpV.y)/2*H; } else ang=Math.atan2(-tmpV.y,tmpV.x); }
  else ang=Math.atan2(-tmpV3.y,tmpV3.x);
  ctx.strokeStyle=col; ctx.fillStyle=col; ctx.lineWidth=2;
  if(onScreen){
    var ds=S*(primary?0.02:0.012); ctx.beginPath(); ctx.moveTo(gx,gy2-ds); ctx.lineTo(gx+ds,gy2); ctx.lineTo(gx,gy2+ds); ctx.lineTo(gx-ds,gy2); ctx.closePath(); ctx.stroke();
    if(label){ ctx.textAlign="center"; ctx.fillText(label,gx,gy2+ds+fs*0.9); }
  } else if(primary){
    var ar=S*0.27, ax=cx+Math.cos(ang)*ar, ay=cy+Math.sin(ang)*ar;
    ctx.save(); ctx.translate(ax,ay); ctx.rotate(ang); ctx.beginPath(); ctx.moveTo(S*0.02,0); ctx.lineTo(-S*0.012,-S*0.014); ctx.lineTo(-S*0.012,S*0.014); ctx.closePath(); ctx.fill(); ctx.restore();
    if(label){ ctx.textAlign="center"; ctx.fillText(label,cx+Math.cos(ang)*(ar-S*0.045),cy+Math.sin(ang)*(ar-S*0.045)); }
  }
  ctx.strokeStyle=HUD_COL; ctx.fillStyle=HUD_COL; ctx.lineWidth=1.5;
}
// runway point (m past the threshold, m right of the centreline) projected to the HUD, or null if behind the camera
function rwyScreen(a,c,out){
  tmpV.set(RWY.thrX+RWY.fx*a+RWY.rx*c,RWY.elev,RWY.thrZ+RWY.fz*a+RWY.rz*c);
  if(tmpV3.copy(tmpV).applyMatrix4(camera.matrixWorldInverse).z>-1) return null;
  tmpV.project(camera); out[0]=(tmpV.x+1)/2*W; out[1]=(1-tmpV.y)/2*H; return out;
}
var RS=[[0,0],[0,0],[0,0],[0,0],[0,0]];
// landing aids: synthetic runway outline + extended centreline, ILS-style deviation scales, radio altitude
function drawLandingAids(S,cx,cy){
  var i, ok=true, corners=[[0,-RWY.width/2],[0,RWY.width/2],[RWY.length,RWY.width/2],[RWY.length,-RWY.width/2],[-3000,0]];
  for(i=0;i<4;i++) if(!rwyScreen(corners[i][0],corners[i][1],RS[i])) ok=false;
  if(ok){
    ctx.save(); ctx.globalAlpha=0.55; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(RS[0][0],RS[0][1]); for(i=1;i<4;i++) ctx.lineTo(RS[i][0],RS[i][1]); ctx.closePath(); ctx.stroke();
    if(rwyScreen(-3000,0,RS[4])&&rwyScreen(0,0,RS[0])){ ctx.setLineDash([6,6]); line(RS[4][0],RS[4][1],RS[0][0],RS[0][1]); }
    ctx.restore();
  }
  var dg=RWY.aim-rwyA;
  if(dg>30&&rwyA>-15000&&Math.abs(angDiff(fm.heading,RWY.heading))<1.6){
    var gsDev=Math.atan2(fm.pos.y-RWY.elev,dg)*R2D-RWY.glide*R2D, locDev=Math.atan2(rwyC,RWY.length-rwyA+300)*R2D, sp=S*0.032, k, gx=cx+S*0.175, ly=cy+S*0.205;
    for(k=-2;k<=2;k++){ if(k){ ctx.beginPath(); ctx.arc(gx,cy+k*sp,S*0.005,0,Math.PI*2); ctx.stroke(); ctx.beginPath(); ctx.arc(cx+k*sp,ly,S*0.005,0,Math.PI*2); ctx.stroke(); } }
    line(gx-S*0.012,cy,gx+S*0.012,cy); line(cx,ly-S*0.012,cx,ly+S*0.012);
    ctx.fillStyle=ACC_COL; ctx.strokeStyle=ACC_COL; var dd=S*0.011, y=cy+clamp(gsDev/0.35,-2.4,2.4)*sp, x=cx-clamp(locDev/0.75,-2.4,2.4)*sp;
    ctx.beginPath(); ctx.moveTo(gx,y-dd); ctx.lineTo(gx+dd,y); ctx.lineTo(gx,y+dd); ctx.lineTo(gx-dd,y); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x,ly-dd); ctx.lineTo(x+dd,ly); ctx.lineTo(x,ly+dd); ctx.lineTo(x-dd,ly); ctx.closePath(); ctx.fill();
    ctx.fillStyle=HUD_COL; ctx.strokeStyle=HUD_COL; ctx.textAlign="center"; ctx.fillText("GS",gx,cy-sp*2.8); ctx.textAlign="right"; ctx.fillText("LOC",cx-sp*2.6,ly);
  }
  var ra=(Math.min(fm.gearPts[1],fm.gearPts[4],fm.gearPts[7])-groundHeight(fm.pos.x,fm.pos.z))*3.28084;
  if(fm.gearPos>=1&&!fm.wow&&ra<200){ ctx.font=Math.round(fs*1.5)+"px "+MONO; ctx.textAlign="right"; ctx.fillText("RA "+Math.max(0,Math.round(ra)),cx-S*0.07,cy+S*0.075); ctx.font=fs+"px "+MONO; }
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
  if(mode==="land"){ // approach speed bug on the speed tape
    var by=cy-(RWY.vApp*KT-iasKt)*S*0.0022, bx2=cx-S*0.31;
    if(Math.abs(by-cy)<S*0.2){ ctx.fillStyle=ACC_COL; ctx.beginPath(); ctx.moveTo(bx2+2,by); ctx.lineTo(bx2+S*0.016,by-S*0.009); ctx.lineTo(bx2+S*0.016,by+S*0.009); ctx.closePath(); ctx.fill(); ctx.fillStyle=HUD_COL; }
  }

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
  ctx.fillText("G   "+(fm.nz||0).toFixed(1),lx,ly+lh);
  ctx.fillText("M   "+(fm.mach||0).toFixed(2),lx,ly+lh*2);
  ctx.fillText("AOA "+(fm.tas>20?(fm.alpha*57.29578).toFixed(1)+"°":"--"),lx,ly+lh*3);
  if(fm.gearPos>0||mode==="land"){
    ctx.fillStyle=fm.gearPos>=1?HUD_COL:WARN_COL;
    ctx.fillText("GEAR "+(fm.gearPos>=1?"DN":fm.gearPos>0?"··":"UP")+(inp.brake?"  BRK":""),lx,ly+lh*4); ctx.fillStyle=HUD_COL;
  }
  ctx.textAlign="right";
  ctx.fillText("VS "+(vsFpm>=0?"+":"")+Math.round(vsFpm/10)*10,rx,ly);
  ctx.fillText("AGL "+Math.max(0,Math.round(aglFt/10)*10),rx,ly+lh);
  ctx.fillText((fm.wow?"GND ":"TAS ")+Math.round((fm.wow?fm.groundSpeed:fm.tas)*1.94384)+" kt",rx,ly+lh*2);
  ctx.fillText(TOD[todIndex].name,rx,ly+lh*3);
  if(mode==="land") ctx.fillText(rwyA<0?"RWY 09 "+fmtDist(-rwyA):"RWY 09",rx,ly+lh*4);

  // --- targets: next ring / next two race gates / aiming point; landing aids ---
  var g=gates[0];
  if(mode==="ring"&&g) drawMarker(g.pos,fmtDist(fm.pos.distanceTo(g.pos)),ACC_COL,true,S,cx,cy);
  else if(mode==="race"&&!race.done){
    var g1=COURSE.gates[race.step%NG], g2=race.step<NG?COURSE.gates[(race.step+1)%NG]:null;
    if(g2) drawMarker(tmpV2.set(g2.x,PYL_H*0.45,g2.z),"","#8fd8ff",false,S,cx,cy);
    drawMarker(tmpV2.set(g1.x,PYL_H*0.45,g1.z),fmtDist(Math.hypot(fm.pos.x-g1.x,fm.pos.z-g1.z)),ACC_COL,true,S,cx,cy);
  } else if(mode==="land"){
    drawLandingAids(S,cx,cy);
    // aiming point marker far out only: closer in it would sit on top of the runway itself
    if(rwyA<-3000) drawMarker(tmpV2.set(RWY.thrX+RWY.fx*RWY.aim,RWY.elev,RWY.thrZ+RWY.fz*RWY.aim),"",ACC_COL,true,S,cx,cy);
  }

  // --- warnings ---
  ctx.textAlign="center"; ctx.font="bold "+Math.round(fs*1.9)+"px "+MONO;
  var wtxt=warn.pull?"PULL UP":warn.sink?"SINK RATE":warn.gear?"GEAR":warn.stall?"STALL":warn.high?"TOO HIGH":"";
  if(wtxt&&blink){ ctx.fillStyle=WARN_COL; ctx.fillText(wtxt,cx,cy+S*0.13); }
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
function fmtTime2(s){ var c=Math.round(s*100); return pad2(Math.floor(c/6000))+":"+pad2(Math.floor(c/100)%60)+"."+pad2(c%100); } // mm:ss.cc
var MODES={
  ring:{chip:["GATES","TIME","BEST"],msg:"オレンジのリングをくぐれ"},
  race:{chip:["NEXT","TIME","PEN","BEST"],msg:"スタートゲートを通過すると計時開始"},
  land:{chip:["RWY 09","VAPP","BEST"],msg:"滑走路 09 へ。PAPI 白 2・赤 2 が正しいパス"}
};
var chipEls=[];
function chipSetup(){
  chip.textContent=""; chipEls=MODES[mode].chip.map(function(l){ var s=document.createElement("span"), b=document.createElement("b"); s.textContent=l+" "; s.appendChild(b); chip.appendChild(s); return b; });
}
function chipValues(){
  if(mode==="race") return [race.step===0?"START":race.step===NG?"FINISH":race.step+"/"+(NG-1), race.started?fmtTime2(race.t):"--:--.--", "+"+race.pen+"s", raceBest?fmtTime2(raceBest.t):"--"];
  if(mode==="land") return [rwyA<0?fmtDist(-rwyA):"ON RWY", Math.round(RWY.vApp*KT)+" kt", landBest?String(landBest):"--"];
  return [String(score.gates), fmtTime(score.time), String(score.best)];
}
function updateChip(){ var v=chipValues(), i; for(i=0;i<chipEls.length;i++) if(chipEls[i].textContent!==v[i]) chipEls[i].textContent=v[i]; }
function startRun(){
  spawnAircraft(); if(mode==="ring") resetGates(); else clearGates(); jet.reset();
  raceGroup.visible=mode==="race"; if(mode==="race") resetRace();
  land.td=null; land.bounces=0; land.air=0;
  score.gates=0; score.miss=0; score.perfect=0; score.time=0;
  paused=false; running=true; started=true;
  overlay.hidden=true; chip.hidden=false; btns.hidden=false; zones.hidden=!(("ontouchstart" in window)||navigator.maxTouchPoints>0);
  $("bGear").hidden=$("bBrake").hidden=mode!=="land";
  lastCx=null; updateChunks(fm.pos.x,fm.pos.z); camUp.set(0,1,0); camera.position.copy(fm.pos); updateRwyFrame(); chipSetup(); updateChip();
  showMsg(MODES[mode].msg,2200);
}
function showResult(kicker,title,stats,note){
  $("rKicker").textContent=kicker; $("rTitle").textContent=title; $("rNote").textContent=note;
  for(var i=0;i<3;i++){ $("rV"+i).textContent=stats[i][0]; $("rL"+i).textContent=stats[i][1]; }
  startCard.hidden=true; result.classList.add("show"); overlay.hidden=false;
}
function stopRun(){ running=false; warn.pull=warn.stall=warn.sink=warn.gear=warn.high=false; touch.brake=false; }
function crash(reason){
  stopRun(); beep(110,0.7,"sawtooth");
  if(mode==="race") showResult("CRASHED — DNF","墜落",[[race.step===0?"START":race.step+"/"+(NG-1),"GATE"],[race.started?fmtTime2(race.t):"--","TIME"],[raceBest?fmtTime2(raceBest.t):"--","BEST"]],
    reason+"。R でスタートゲートの手前からやり直せます。");
  else if(mode==="land"){
    var td=land.td;
    showResult("CRASHED","墜落",[[td?String(Math.round(td.sink*FPM)):"--","SINK fpm"],[td?Math.round(td.along)+" m":"--","TOUCHDOWN"],[landBest?String(landBest):"--","BEST"]],
      reason+"。降下率は 600 fpm 以内に抑え、PAPI の白 2・赤 2 を保って 1000 ft マーカー（スレッショルドから 300 m）付近に接地を。");
  } else showResult("CRASHED","墜落",[[String(score.gates),"GATES"],[fmtTime(score.time),"TIME"],[String(score.best),"BEST"]],
    reason+"。くぐったリング "+score.gates+"（うちど真ん中 "+score.perfect+"）、外したリング "+score.miss+"。同じ場所の上空に戻って、リングも新しく配置されます。");
}
function finishRace(){
  race.done=true; stopRun(); raceLook();
  var total=race.t+race.pen, prev=raceBest, rec=!prev||total<prev.t;
  race.splits[NG]=total;
  if(rec){ raceBest={t:total,splits:race.splits.slice()}; try{ localStorage.setItem("skyrunner.raceBest",JSON.stringify(raceBest)); }catch(e){} }
  beep(1320,0.1); setTimeout(function(){ beep(1760,0.18); },110);
  showResult("FINISH",rec?"新記録":"ゴール",[[fmtTime2(total),"TIME"],["+"+race.pen+"s","PENALTY"],[fmtTime2(raceBest.t),"BEST"]],
    "飛行タイム "+fmtTime2(race.t)+" ＋ ペナルティ "+race.pen+" 秒（ゲート外・高すぎ "+race.miss+" 回、パイロン接触 "+race.hits+" 回）。"+
    (rec&&prev?"これまでのベストを "+(prev.t-total).toFixed(2)+" 秒更新。":rec?"初めての記録です。次からはゲートごとにベストとの差が出ます。":
      total-prev.t<0.005?"ベストと同タイム。":"ベストまであと "+(total-prev.t).toFixed(2)+" 秒。"));
}
function finishLanding(){
  stopRun();
  var td=land.td, sc=landingScore(td,land.bounces), rec=sc.total>landBest;
  if(rec){ landBest=sc.total; try{ localStorage.setItem("skyrunner.landBest",String(landBest)); }catch(e){} }
  beep(1320,0.1); setTimeout(function(){ beep(1760,0.18); },110);
  showResult("LANDED","着陸成功  グレード "+sc.grade,[[String(sc.total),"SCORE"],[String(Math.round(td.sink*FPM)),"SINK fpm"],[String(landBest),"BEST"]],
    "接地点はスレッショルドから "+Math.round(td.along)+" m（目標 "+RWY.aim+" m）、センターラインから "+Math.abs(td.across).toFixed(1)+" m、バンク "+Math.abs(td.bank*R2D).toFixed(1)+"°、接地速度 "+Math.round(td.ias*KT)+" kt、バウンド "+land.bounces+" 回。"+
    (rec?"自己ベスト更新。":""));
}
function openMenu(){
  stopRun(); started=false; paused=false;
  $("bestRing").textContent="BEST "+score.best; $("bestRace").textContent="BEST "+(raceBest?fmtTime2(raceBest.t):"--"); $("bestLand").textContent="BEST "+(landBest||"--");
  result.classList.remove("show"); startCard.hidden=false; overlay.hidden=false; chip.hidden=true; btns.hidden=true; zones.hidden=true;
}
// Crash rules. Gear up: the old 2.5 m CG clearance. Gear down and locked: the tyres may touch only the runway, no
// other part of the airframe may touch at all, and the touchdown sink rate / strut travel must stay within limits.
var BODY_PTS=[[0,-0.85,0,"胴体が地面に接触"],[0,-0.7,6.8,"尾部を擦った（テールストライク）"],[0,-0.3,-7.6,"機首が地面に接触"],[-4.75,-0.15,1.2,"翼端が地面に接触"],[4.75,-0.15,1.2,"翼端が地面に接触"]];
function groundCheck(vsB,wowB){
  var i, p, x, z;
  if(fm.gearPos<1){
    var th=terrainHeight(fm.pos.x,fm.pos.z);
    if(fm.pos.y-Math.max(th,0)<2.5) return th<0?"海に墜落":fm.gearPos>0?"脚が下りきる前に接地":"地面に激突";
    return null;
  }
  for(i=0;i<BODY_PTS.length;i++){ p=BODY_PTS[i]; tmpV.set(p[0],p[1],p[2]).applyQuaternion(fm.q).add(fm.pos); if(tmpV.y<groundHeight(tmpV.x,tmpV.z)) return p[3]; }
  if(!fm.wow) return null;
  for(i=0;i<3;i++) if(fm.gearComp[i]>0){ x=fm.gearPts[3*i]; z=fm.gearPts[3*i+2]; if(!World.onRunway(x,z,1.5)) return terrainHeight(x,z)<0?"海に着水":land.td?"滑走路を逸脱":"滑走路の外に接地"; }
  if(!wowB){
    if(-vsB>HARD_SINK) return "ハードランディングで脚が折れた（降下率 "+Math.round(-vsB*FPM)+" fpm）";
    if(fm.gearComp[0]>0&&!(fm.gearComp[1]>0)&&!(fm.gearComp[2]>0)&&-vsB>1.5) return "前脚から接地して前脚が折れた";
  }
  for(i=0;i<3;i++) if(fm.gearComp[i]>fm.params.gearStroke) return "脚が底づきして折れた";
  return null;
}
function updateWarnings(dt){
  var agl=fm.pos.y-groundHeight(fm.pos.x,fm.pos.z), sink=-fm.vs;
  warn.sink=false; warn.high=false;
  if(fm.wow) warn.pull=false;
  else if(inApproach()){ warn.pull=agl<120&&sink>9; warn.sink=!warn.pull&&agl<350&&sink>7; } // on final: callouts, not terrain alarms
  else if(mode==="race"){ warn.pull=(sink>2&&agl<sink*5)||(agl<12&&sink>0.5); }       // low-level racing: time to impact
  else warn.pull=(agl<170&&sink>7)||(agl<60&&sink>1);
  warn.stall=!!fm.stalled&&!fm.wow&&fm.tas>25;
  warn.gear=mode==="land"&&fm.gearPos<1&&!fm.wow&&agl<300;
  if(mode==="race"&&!race.done){ var g=COURSE.gates[race.step%NG]; warn.high=fm.pos.y>PYL_H&&Math.hypot(fm.pos.x-g.x,fm.pos.z-g.z)<1500; }
  if(warn.pull){ warnT+=dt; if(warnT>=0.5){ warnT=0; beep(720,0.12,"square"); } } else warnT=0.5;
}
function onKey(code){
  if(code==="KeyV") toggleView();
  else if(code==="KeyT") cycleTOD();
  else if(code==="KeyM") setMuted(!audio.muted);
  else if(code==="KeyR"&&started) startRun();
  else if(code==="KeyP"&&running){ paused=!paused; }
  else if(code==="KeyG"&&running) toggleGear();
  else if(code==="Escape"&&started) openMenu();
}
function toggleGear(){
  if(inp.gear&&fm.wow){ showMsg("接地中は脚を上げられません",1200); return; }
  inp.gear=!inp.gear; showMsg(inp.gear?"GEAR DOWN":"GEAR UP",900);
}
function toggleView(){ viewExt=!viewExt; showMsg(viewExt?"外部視点":"HUD視点",800); }
function cycleTOD(){ applyTOD((todIndex+1)%TOD.length); showMsg(TOD[todIndex].name,900); }
function wire(id,fn){ $(id).addEventListener("click",function(){ fn(); this.blur(); }); }
function startMode(m){ mode=m; audioInit(); if(audio.ctx&&audio.ctx.state==="suspended") audio.ctx.resume(); startRun(); }
(function(){ var b=document.querySelectorAll("[data-mode]"), i; for(i=0;i<b.length;i++) b[i].addEventListener("click",function(){ startMode(this.getAttribute("data-mode")); this.blur(); }); })();
wire("bAgain",function(){ startRun(); }); wire("bMenu",openMenu); wire("bMenuTop",openMenu);
wire("bView",toggleView); wire("bTime",cycleTOD); wire("bMute",function(){ setMuted(!audio.muted); }); wire("bReset",function(){ startRun(); });
wire("bGear",function(){ if(running) toggleGear(); });
(function(){ var b=$("bBrake"); function on(e){ e.preventDefault(); touch.brake=true; } function off(){ touch.brake=false; }
  b.addEventListener("pointerdown",on); b.addEventListener("pointerup",off); b.addEventListener("pointercancel",off); b.addEventListener("pointerleave",off); })();
document.addEventListener("visibilitychange",function(){ if(document.hidden&&running) paused=true; });

function frame(t){
  requestAnimationFrame(frame);
  var dt=Math.min((t-lastT)/1000,0.1)||0; lastT=t;
  if(document.hidden) return;
  if(running&&!paused){
    readInputs(dt);
    var vsB=fm.vel.y, wowB=fm.wow; // vel is the state of record (also right after a snapshot restore)
    fm.step(dt); score.time+=dt; updateRwyFrame();
    if(mode==="land") landTouch(vsB,wowB);
    var why=groundCheck(vsB,wowB);
    if(why) crash(why);
    else if(mode==="ring") updateGates();
    else if(mode==="race") updateRace(dt);
    else updateLanding(dt);
    if(running) updateWarnings(dt);
    audioUpdate(); updateChip();
  } else if(audio.ctx&&audio.eng){ audio.eng.gain.setTargetAtTime(0,audio.ctx.currentTime,0.3); audio.wind.gain.setTargetAtTime(0,audio.ctx.currentTime,0.3); audio.wg.gain.setTargetAtTime(0,audio.ctx.currentTime,0.3); }
  acGroup.position.copy(fm.pos); acGroup.quaternion.copy(fm.q); acGroup.visible=viewExt;
  var fwd=tmpV.set(0,0,-1).applyQuaternion(fm.q), up=tmpV2.set(0,1,0).applyQuaternion(fm.q);
  if(viewExt){
    camTarget.copy(fm.pos).addScaledVector(fwd,-15).addScaledVector(up,3.5);
    if(running&&!paused) camera.position.addScaledVector(fm.vel,dt);   // ride along, so the lag below does not grow with airspeed
    camera.position.lerp(camTarget,1-Math.exp(-dt*6)); camUp.lerp(up,1-Math.exp(-dt*3)).normalize(); camera.up.copy(camUp);
    camera.lookAt(tmpV3.copy(fm.pos).addScaledVector(fwd,40));
  } else {
    camera.position.copy(fm.pos).addScaledVector(fwd,2.5).addScaledVector(up,0.9); camera.quaternion.copy(fm.q); camera.up.set(0,1,0);
  }
  sky.position.copy(camera.position); water.position.set(fm.pos.x,0,fm.pos.z); updateChunks(fm.pos.x,fm.pos.z); updatePapi();
  jet.update(fm,running&&!paused?dt:0,{visible:viewExt,engine:running,camera:camera,dark:TOD_DARK[todIndex],time:t/1000});
  renderer.render(scene,camera); drawHUD(t);
}

function boot(data){
  if(data&&MODES[data.mode]) mode=data.mode;
  spawnAircraft(); updateChunks(fm.pos.x,fm.pos.z); chipSetup(); updateChip(); openMenu();
  if(data&&data.tod!=null) applyTOD(data.tod);
  if(data&&data.started){
    startRun();
    if(data.pos){ fm.pos.fromArray(data.pos); fm.q.fromArray(data.q); fm.vel.fromArray(data.vel); }
    if(data.gear!=null){ inp.gear=!!data.gear; fm.setControls({gear:inp.gear}); fm.gearPos=inp.gear?1:0; }
    if(data.score){ score.gates=data.score.gates||0; score.time=data.score.time||0; score.miss=data.score.miss||0; score.perfect=data.score.perfect||0; }
    if(data.race&&mode==="race"){ var r=data.race; race.step=r.step||0; race.t=r.t||0; race.pen=r.pen||0; race.started=!!r.started; race.miss=r.miss||0; race.hits=r.hits||0; race.prevS=gateS(race.step%NG); raceLook(); }
    viewExt=!!data.viewExt; lastCx=null; updateRwyFrame();
  }
  requestAnimationFrame(frame);
}
if(window.claude&&window.claude.hot&&window.claude.hot.snapshot){ window.claude.hot.snapshot(function(){ return {started:started&&running,mode:mode,gear:inp.gear,pos:fm.pos.toArray(),q:fm.q.toArray(),vel:fm.vel.toArray(),score:{gates:score.gates,time:score.time,miss:score.miss,perfect:score.perfect},race:{step:race.step,t:race.t,pen:race.pen,started:race.started,miss:race.miss,hits:race.hits},tod:todIndex,viewExt:viewExt}; }); }
if(window.claude&&window.claude.hot&&window.claude.hot.ready) window.claude.hot.ready(boot); else boot((window.claude&&window.claude.hot&&window.claude.hot.data)||{});
})();
