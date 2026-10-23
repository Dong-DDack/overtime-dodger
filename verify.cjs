'use strict';
// Development-only tests; the delivered index.html has no dependency on this file.
// Run: node verify.cjs
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(`${__dirname}/index.html`,'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(script); // Syntax-check the complete shipped script, including UI/audio/rendering.
const core = script.slice(0,script.indexOf('// CORE_END'));
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${core}\nglobalThis.api={EscapeGame,DIRECTIONS,REQUESTS,actionPose,skeleton,blendPose,solveLimb,walkingPose,GAME_RULES,DIFFICULTY_CONFIG,loadRecord,saveRecord,validRecord};`,sandbox);
const {EscapeGame,DIRECTIONS,GAME_RULES,DIFFICULTY_CONFIG,loadRecord,saveRecord} = sandbox.api;
let passed = 0;
const checks = [];
function check(name,test) { test(); passed++; checks.push(name); console.log(`PASS ${String(passed).padStart(2,'0')} ${name}`); }
function memoryStorage(value = null) {
  return { value, getItem() { return this.value; }, setItem(key,next) { assert.equal(key,'escape_1800_best'); this.value = next; } };
}
function runPerfect(game) {
  let maxObjects = 0;
  while (game.state === 'playing') {
    game.update(10);
    maxObjects = Math.max(maxObjects,game.obstacles.length);
    const next = game.obstacles[0];
    if (next && Math.abs(next.hitAt-game.elapsed) <= 5) game.input(DIRECTIONS[next.direction]);
  }
  return maxObjects;
}
check('Single file: no external URLs, assets, libraries, network APIs or imports',() => {
  assert(!/<(?:script|img|audio|video|link|iframe)\b[^>]*(?:src|href)\s*=/i.test(html));
  assert(!/https?:\/\/|@import\b|\bfetch\s*\(|XMLHttpRequest|WebSocket|import\s*\(/.test(html));
});
check('Initial state / default record',() => {
  const g = new EscapeGame(); assert.equal(g.state,'waiting'); assert.equal(g.elapsed,0); assert.equal(g.misses,0);
  const loaded = loadRecord(memoryStorage()); assert.equal(loaded.record.bestTime,0); assert.equal(loaded.record.clearCount,0);
});
check('Perfect run reaches exactly 30 seconds, finishes once, empties obstacles',() => {
  const events = []; const g = new EscapeGame(e => events.push(e)); g.reset();
  const max = runPerfect(g);
  assert.equal(g.state,'success'); assert.equal(g.elapsed,30000); assert.equal(g.misses,0);
  assert.equal(g.hits,37); assert.equal(g.obstacles.length,0); assert(max <= 4);
  assert.equal(events.filter(e=>e.type==='success').length,1);
  g.update(100000); g.input('ArrowLeft'); assert.equal(events.filter(e=>e.type==='success').length,1);
});
check('Third miss ends immediately at deadline, even for a large simulation delta',() => {
  const events=[]; const g=new EscapeGame(e=>events.push(e)); g.reset(); g.update(30000);
  assert.equal(g.state,'failure'); assert.equal(g.misses,3); assert.equal(g.elapsed,3750+DIFFICULTY_CONFIG.HIT_WINDOW_MS);
  assert.equal(events.filter(e=>e.type==='hit').length,3); assert.equal(events.filter(e=>e.type==='failure').length,1);
});
check('All four directions: one correct input produces one dodge',() => {
  for(let i=0;i<4;i++) {
    const events=[]; const g=new EscapeGame(e=>events.push(e),()=>i/4+.01); g.reset(); g.update(2250);
    assert(g.input(DIRECTIONS[i])); assert.equal(g.hits,1); assert.equal(g.inputs,1); assert.equal(events.length,1);
  }
});
check('Wrong direction consumes only one obstacle and one life',() => {
  const g=new EscapeGame(()=>{},()=>0); g.reset(); g.update(2250);
  g.input('ArrowRight'); assert.equal(g.misses,1); assert.equal(g.hits,0);
  g.input('ArrowRight'); assert.equal(g.misses,1);
});
check('Hit window boundary is inclusive and determined by the one config variable',() => {
  for (const offset of [-DIFFICULTY_CONFIG.HIT_WINDOW_MS,DIFFICULTY_CONFIG.HIT_WINDOW_MS]) {
    const g=new EscapeGame(()=>{},()=>0); g.reset(); g.update(2250+offset); assert(g.input('ArrowLeft')); assert.equal(g.hits,1);
  }
  const early=new EscapeGame(()=>{},()=>0); early.reset(); early.update(2250-DIFFICULTY_CONFIG.HIT_WINDOW_MS-1);
  assert(!early.input('ArrowLeft')); assert.equal(early.hits,0); assert.equal(early.obstacles[0].id,0);
});
check('100 rapid keys consume immediately without input backlog or duplicate hits',() => {
  const events=[]; const g=new EscapeGame(e=>events.push(e),()=>0); g.reset(); g.update(2250);
  for(let i=0;i<100;i++)g.input('ArrowLeft');
  assert.equal(g.inputs,100); assert.equal(g.hits,1); assert.equal(events.length,1);
  g.update(500); assert.equal(g.hits,1); assert.equal(g.misses,0);
});
check('Pause freezes elapsed time, obstacles and judgments; resume continues normally',() => {
  const g=new EscapeGame(); g.reset(); g.update(1800); const snapshot=JSON.stringify(g.obstacles);
  assert(g.pause()); const time=g.elapsed; g.update(600000); assert(!g.input('ArrowLeft'));
  assert.equal(g.elapsed,time); assert.equal(JSON.stringify(g.obstacles),snapshot); assert.equal(g.misses,0);
  assert(g.resume()); g.update(10); assert.equal(g.elapsed,time+10); assert.equal(g.isPaused,false);
});
check('Restart completely resets per-run state and obstacle IDs',() => {
  const g=new EscapeGame(); g.reset(); runPerfect(g); g.reset();
  for(const key of ['elapsed','misses','hits','perfects','combo','maxCombo','inputs','nextId'])assert.equal(g[key],0);
  assert.equal(g.state,'playing'); assert.equal(g.isPaused,false); assert.equal(g.obstacles.length,0); assert.equal(g.nextHit,2250);
});
check('Malformed JSON and invalid schemas are repaired in storage',() => {
  for(const value of ['','broken','{','null','[]','42','"str"','{}','{"bestTime":-1,"clearCount":0}','{"bestTime":31,"clearCount":0}','{"bestTime":"8","clearCount":2}','{"bestTime":8,"clearCount":1.5}','{"bestTime":8,"clearCount":-1}','{"bestTime":1e400,"clearCount":0}']) {
    const s=memoryStorage(value); const loaded=loadRecord(s);
    assert.equal(loaded.record.bestTime,0); assert.equal(loaded.record.clearCount,0);
    assert.equal(s.value,'{"bestTime":0,"clearCount":0}');
  }
});
check('Denied localStorage reads/writes do not throw or block gameplay',() => {
  const s={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}};
  assert.equal(loadRecord(s).available,false); assert.equal(loadRecord(null).available,false);
  assert.equal(saveRecord(s,{bestTime:30,clearCount:1}),false);
});
check('Valid best record persists and is copied without arbitrary fields',() => {
  const s=memoryStorage('{"bestTime":12.5,"clearCount":2,"extra":999}'); const loaded=loadRecord(s);
  assert.equal(loaded.record.bestTime,12.5); assert.equal(loaded.record.clearCount,2); assert(!('extra' in loaded.record));
  assert(saveRecord(s,{bestTime:30,clearCount:3})); assert.equal(loadRecord(s).record.clearCount,3);
});
check('20 consecutive successful runs = 10 simulated minutes; bounded memory and 20 clears',() => {
  let clears=0; let max=0; const g=new EscapeGame(e=>{if(e.type==='success')clears++;});
  for(let i=0;i<20;i++){g.reset();max=Math.max(max,runPerfect(g)); assert.equal(g.obstacles.length,0);}
  assert.equal(clears,20); assert(max<=4); console.log(`  peak live obstacle objects: ${max}; simulated play time: 600 seconds`);
});
check('Alternative B difficulty (200ms) runs without modifying any other parameter',() => {
  const b={}; vm.createContext(b); vm.runInContext(`${core.replace('HIT_WINDOW_MS: 300','HIT_WINDOW_MS: 200')}\nglobalThis.Game=EscapeGame;`,b);
  const g=new b.Game();g.reset();runPerfect(g);assert.equal(g.state,'success');assert.equal(g.hits,37);
});
// UI integration harness uses the shipped IIFE with a deterministic virtual clock and DOM/audio doubles.
function makeUI() {
  let now=0;let hidden=false;let focused=true;let queuedFrame;let playSound=0;let gainValue=.13;let audio;
  const handlers={};const elements={};const add=(scope,event,fn)=>{handlers[scope+event]=fn;};
  const ids=Array.from(html.matchAll(/\bid="([^"]+)"/g),match=>match[1]);
  ids.forEach(id=>{elements[id]={textContent:'',style:{},dataset:{},attributes:{},hidden:id==='overlay'?false:undefined,disabled:false,addEventListener(event,fn){add(id,event,fn);},setAttribute(key,value){this.attributes[key]=value;},blur(){},focus(){}};});
  elements.scene.getContext=()=>null;
  const guides=Array.from({length:4},()=>({classList:{toggle(){}}}));
  const store=memoryStorage();
  const document={getElementById:id=>elements[id],querySelectorAll:()=>guides,get hidden(){return hidden;},hasFocus:()=>focused,addEventListener:(e,f)=>add('document',e,f),removeEventListener(){},fullscreenElement:null};
  document.documentElement={requestFullscreen(){document.fullscreenElement=this;handlers.documentfullscreenchange();return Promise.resolve();}};
  document.exitFullscreen=()=>{document.fullscreenElement=null;handlers.documentfullscreenchange();return Promise.resolve();};
  class FakeAudio {
    constructor(){audio=this;this.state='running';this.currentTime=0;this.destination={};}
    createGain(){return {gain:{get value(){return gainValue;},set value(v){gainValue=v;},setValueAtTime(v){gainValue=v;},cancelScheduledValues(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}};}
    createOscillator(){playSound++;return {frequency:{setValueAtTime(){}},connect(){},disconnect(){},start(){},stop(){}};}
    close(){return Promise.resolve();}
  }
  const window={localStorage:store,AudioContext:FakeAudio,matchMedia:()=>({matches:false,addEventListener:(e,f)=>add('media',e,f),removeEventListener(){}}),addEventListener:(e,f)=>add('window',e,f),removeEventListener(){}};
  const c={document,window,performance:{now:()=>now},requestAnimationFrame:f=>{queuedFrame=f;return 1;},cancelAnimationFrame(){}};
  vm.createContext(c);vm.runInContext(script,c);
  return {elements,handlers,document,step(ms){now+=ms;queuedFrame(now);},click(id){return handlers[id+'click']();},key(key,repeat=false){handlers.windowkeydown({key,repeat,preventDefault(){}});},up(key){handlers.windowkeyup({key});},hide(){hidden=true;handlers.documentvisibilitychange();},show(){hidden=false;},blur(){focused=false;handlers.windowblur();},focus(){focused=true;},get soundCount(){return playSound;},get gain(){return gainValue;},get audio(){return audio;},now:()=>now};
}
check('Real UI handlers: repeat and held-key duplicates ignored, keyup unlocks new input',() => {
  const ui=makeUI();ui.click('start');
  // At 2250ms a first obstacle exists; reading the real cue determines the required key.
  for(let i=0;i<9;i++)ui.step(250);
  const cue=ui.elements.cue.textContent;const key=DIRECTIONS[['←','↑','→','↓'].indexOf(cue[0])];
  ui.key(key);const feedback=ui.elements.feedback.textContent;assert(feedback.includes('1 COMBO'));
  for(let i=0;i<100;i++){ui.key(key,true);ui.key(key);}
  assert.equal(ui.elements.feedback.textContent,feedback);assert.equal(ui.soundCount,1);
  ui.up(key);ui.key(key);assert.equal(ui.soundCount,1);
});
check('Real UI: blur/visibility pause, 60-second gap ignored, explicit resume rebases clock',() => {
  for(const mode of ['blur','hide']) {
    const ui=makeUI();ui.click('start');ui.step(100);const remaining=ui.elements.remaining.textContent;
    ui[mode]();assert(ui.elements.status.textContent.includes('일시정지'));
    ui.step(60000);assert.equal(ui.elements.remaining.textContent,remaining);
    ui.focus();ui.show();ui.step(100);assert(ui.elements.status.textContent.includes('일시정지'));
    ui.click('pause');ui.step(100);assert.equal(ui.elements.remaining.textContent,'29.8');assert.equal(ui.elements.lives.textContent,'라이프 3 / 3 · 미스 0 / 3');
  }
});
check('Real UI: manual pause and long main-thread stall produce no catch-up misses',() => {
  const ui=makeUI();ui.click('start');ui.step(100);ui.click('pause');ui.step(600000);ui.click('start');ui.step(100);
  assert.equal(ui.elements.remaining.textContent,'29.8');ui.step(1000);assert(ui.elements.status.textContent.includes('일시정지'));assert.equal(ui.elements.remaining.textContent,'29.8');
});
check('Real UI: mute immediately sets master GainNode to zero; motion toggle is immediate',() => {
  const ui=makeUI();ui.click('start');ui.click('mute');assert.equal(ui.gain,0);assert.equal(ui.elements.mute.attributes['aria-pressed'],'true');
  ui.click('mute');assert.equal(ui.gain,.13);ui.click('motion');assert.equal(ui.elements.motion.attributes['aria-pressed'],'true');
});
check('Real UI: loss result and restart button return a fully fresh run',() => {
  const ui=makeUI();ui.click('start');for(let i=0;i<43;i++)ui.step(100);
  assert(ui.elements.status.textContent.includes('失敗')||ui.elements.status.textContent.includes('실패'));
  for(let i=0;i<12;i++)ui.step(100);assert.equal(ui.elements.overlay.hidden,false);
  assert.equal(ui.elements.start.textContent,'다시 시작 →');ui.click('start');
  assert.equal(ui.elements.clock.textContent,'17:59:30');assert.equal(ui.elements.lives.textContent,'라이프 3 / 3 · 미스 0 / 3');assert.equal(ui.elements.remaining.textContent,'30.0');
});
check('Right coworker requires Left, left coworker requires Right; pose moves AWAY from origin',() => {
  const {REQUESTS,actionPose}=sandbox.api;
  assert(REQUESTS[0].includes('오른쪽 동료'));assert(actionPose(0,80,false).offsetX<0);
  assert(REQUESTS[2].includes('왼쪽 동료'));assert(actionPose(2,80,false).offsetX>0);
  assert(html.includes('encounterDirection===2'));assert(html.includes('encounterDirection===0'));
});
check('Guard pose remains visible and documents rebound upward and outward',() => {
  const {actionPose}=sandbox.api;const early=actionPose(1,650*.34,false),late=actionPose(1,650*.8,false);
  assert(early.blocking);assert(late.blocking);assert(late.paperX>early.paperX);assert(late.paperY<early.paperY);
  const reducedA=actionPose(1,0,true),reducedB=actionPose(1,500,true);
  assert.equal(reducedA.paperX,reducedB.paperX);assert.equal(reducedA.paperY,reducedB.paperY);
  assert(actionPose(0,100,true).offsetX<0);assert(actionPose(3,100,true).duck>0);
});
check('Fullscreen enter/exit and Escape-style external exit sync the button state',() => {
  const enter=makeUI();enter.click('fullscreen');assert(enter.document.fullscreenElement);assert.equal(enter.elements.fullscreen.attributes['aria-pressed'],'true');
  enter.document.exitFullscreen();assert.equal(enter.elements.fullscreen.attributes['aria-pressed'],'false');
  const exit=makeUI();exit.document.fullscreenElement=exit.document.documentElement;exit.click('fullscreen');assert.equal(exit.document.fullscreenElement,null);
});
check('Unsupported fullscreen recovers without throwing or disturbing gameplay',() => {
  const ui=makeUI();delete ui.document.documentElement.requestFullscreen;ui.click('start');ui.click('fullscreen');
  assert(ui.elements.announcement.textContent.includes('F11'));assert(ui.elements.status.textContent.includes('진행중'));
});
check('All five tempos complete 30-second runs with increasing note counts and faster travel',() => {
  const expectedBPM=[60,80,100,120,150],counts=[28,37,46,55,68];let previousBeat=Infinity;
  for(let level=0;level<5;level++){
    const g=new EscapeGame();g.reset(level);
    assert.equal(g.difficulty.bpm,expectedBPM[level]);assert(g.beatMs<previousBeat);previousBeat=g.beatMs;
    assert.equal(g.approachMs,g.beatMs*2.4);assert(runPerfect(g)<=4);
    assert.equal(g.state,'success');assert.equal(g.elapsed,30000);assert.equal(g.hits,counts[level]);assert.equal(g.misses,0);
    g.reset();assert.equal(g.difficultyIndex,level);
  }
});
check('Fast overlapping windows judge the nearest note only, independent of key direction',() => {
  const g=new EscapeGame(()=>{},()=>0);g.reset(4);g.update(2500);
  assert.equal(g.obstacles[0].direction,0);assert.equal(g.obstacles[1].direction,1);
  g.input('ArrowUp');assert.equal(g.hits,1);assert.equal(g.misses,0);assert.equal(g.obstacles[0].id,0);
  g.update(51);assert.equal(g.misses,1);assert.equal(g.hits,1);
});
check('UI difficulty selection applies on start, remains on restart, and is locked during pause',() => {
  const ui=makeUI();ui.elements.difficulty.value='4';ui.handlers.difficultychange();
  assert(ui.elements.status.textContent.includes('150 BPM'));ui.click('start');assert(ui.elements.status.textContent.includes('Lv.5'));
  ui.click('pause');assert.equal(ui.elements['difficulty-row'].hidden,true);assert.equal(ui.elements.difficulty.disabled,true);
  ui.elements.difficulty.value='0';ui.handlers.difficultychange();ui.click('pause');assert(ui.elements.status.textContent.includes('150 BPM'));
  for(let i=0;i<36;i++)ui.step(100);assert(ui.elements.status.textContent.includes('실패'));
  for(let i=0;i<12;i++)ui.step(100);assert.equal(ui.elements['difficulty-row'].hidden,false);
  ui.click('start');assert(ui.elements.status.textContent.includes('150 BPM'));assert.equal(ui.elements.remaining.textContent,'30.0');
});
check('Native select arrow navigation is not intercepted and invalid levels use the safe default',() => {
  const ui=makeUI();let prevented=false;
  ui.handlers.windowkeydown({key:'ArrowDown',target:ui.elements.difficulty,repeat:false,preventDefault(){prevented=true;}});
  assert.equal(prevented,false);
  for(const index of [-1,5,NaN,'4',null]){const g=new EscapeGame();g.reset(index);assert.equal(g.difficultyIndex,1);}
});
check('Every action starts and ends at the neutral joint pose without teleporting',() => {
  const {actionPose,skeleton}=sandbox.api;const neutral=skeleton(actionPose(-1,0,false));
  for(let direction=0;direction<4;direction++)for(const age of [0,650]) {
    const actual=skeleton(actionPose(direction,age,false));
    for(const part of ['hip','shoulder','head'])assert(Math.hypot(actual[part].x-neutral[part].x,actual[part].y-neutral[part].y)<.0001);
    for(const part of ['leftArm','rightArm','leftLeg','rightLeg'])assert(Math.hypot(actual[part].end.x-neutral[part].end.x,actual[part].end.y-neutral[part].end.y)<.0001);
  }
});
check('Leading foot plants before weight transfer; support foot stays grounded throughout dodge',() => {
  const {actionPose}=sandbox.api;
  for(const direction of [0,2]) {
    const lead=direction===0?'left':'right',support=direction===0?'right':'left';
    const step=actionPose(direction,650*.38,false),weight=actionPose(direction,650*.55,false);
    assert(Math.abs(step.hipX)<Math.abs(weight.hipX));assert.equal(step[lead+'FootY'],60);
    assert.equal(step[lead+'FootX'],weight[lead+'FootX']);
    for(let age=0;age<=650;age+=5){const p=actionPose(direction,age,false);assert.equal(p[support+'FootY'],60);assert.equal(p[support+'FootX'],direction===0?18:-18);}
  }
});
check('Knees and elbows preserve bone lengths and remain finite through all action frames',() => {
  const {actionPose,skeleton}=sandbox.api;
  for(let d=0;d<4;d++)for(let age=0;age<=650;age+=2){
    const rig=skeleton(actionPose(d,age,false));
    for(const name of ['leftArm','rightArm','leftLeg','rightLeg']){
      const bone=rig[name],arm=name.endsWith('Arm');
      assert(Math.abs(Math.hypot(bone.joint.x-bone.root.x,bone.joint.y-bone.root.y)-(arm?25:32))<.00001);
      assert(Math.abs(Math.hypot(bone.end.x-bone.joint.x,bone.end.y-bone.joint.y)-(arm?25:33))<.00001);
      if(!arm){const pose=actionPose(d,age,false),side=name.startsWith('left')?'left':'right';assert(Math.hypot(bone.end.x-pose[side+'FootX'],bone.end.y-pose[side+'FootY'])<.001);}
    }
  }
});
check('Guard raises arms, absorbs collision, then releases documents; reduced motion is static',() => {
  const {actionPose}=sandbox.api;
  const ready=actionPose(1,0,false),raised=actionPose(1,650*.28,false),impact=actionPose(1,650*.45,false),release=actionPose(1,650*.7,false);
  assert(raised.leftHandY<ready.leftHandY-50);assert.equal(raised.paperX,480);
  assert(impact.recoil>.9);assert(impact.hipY>raised.hipY);assert(release.paperX>impact.paperX);assert(release.paperY<impact.paperY);
  for(let direction=0;direction<4;direction++)assert.equal(JSON.stringify(actionPose(direction,20,true)),JSON.stringify(actionPose(direction,500,true)));
});
check('Interrupted actions blend current joints rather than snapping back to the center',() => {
  const {actionPose,blendPose,skeleton}=sandbox.api;const from=actionPose(0,330,false),to=actionPose(1,0,false);
  assert.equal(JSON.stringify(skeleton(blendPose(from,to,0))),JSON.stringify(skeleton(from)));
  assert.equal(JSON.stringify(skeleton(blendPose(from,to,1))),JSON.stringify(skeleton(to)));
});
check('Exit gait keeps both feet within leg reach and planted feet stationary during stance',()=>{
  const {walkingPose,skeleton}=sandbox.api;
  for(let distance=0;distance<=449;distance+=.25){
    const pose=walkingPose(distance,1,false,true),rig=skeleton(pose);
    for(const side of ['left','right']){const foot=rig[side+'Leg'].end;assert(Math.hypot(foot.x-pose[side+'FootX'],foot.y-pose[side+'FootY'])<.001);}
  }
  for(const distance of [1,10,20,30]){
    const a=walkingPose(distance,1,false,true),b=walkingPose(distance+1,1,false,true);
    assert(Math.abs(distance+a.leftFootX-(distance+1+b.leftFootX))<.00001);
    assert.equal(a.leftFootY,60);assert.equal(b.leftFootY,60);
  }
});
check('Player selection supports both appearances and native keyboard navigation; pause locks selection',()=>{
  const ui=makeUI();
  for(const [value,label] of [['young_male','젊은 남성'],['young_female','젊은 여성']]){
    ui.elements.character.value=value;ui.handlers.characterchange();assert(ui.elements.announcement.textContent.includes(label));
  }
  let prevented=false;ui.handlers.windowkeydown({key:'ArrowDown',target:ui.elements.character,repeat:false,preventDefault(){prevented=true;}});assert.equal(prevented,false);
  ui.click('start');ui.click('pause');assert.equal(ui.elements.character.disabled,true);assert.equal(ui.elements['character-row'].hidden,true);
});
console.log(`\n${passed}/${passed} checks passed. Browser layout and real 10-minute soak are separate manual checks.`);
