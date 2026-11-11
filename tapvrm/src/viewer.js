// TapVRM viewer — readable source. Build: npm run build → web/app.js
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { createTalker } from './talk.js';

const $ = id => document.getElementById(id);
const canvas = $('stage');
const BUILTIN = { url: './classmate.vrm', name: '課堂機器人（內建）' };

// ───────── scene ─────────
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
} catch (error) {
  $('model').textContent = '這個瀏覽器無法啟動 WebGL 2，請改用有圖形加速的瀏覽器。';
  throw error;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.enablePan = false;
scene.add(new THREE.HemisphereLight(0xffffff, 0x85ada9, 2.0));
const key = new THREE.DirectionalLight(0xffeedb, 2.4);
key.position.set(2, 3, 4); scene.add(key);
const rim = new THREE.DirectionalLight(0x80c6ff, 1.6);
rim.position.set(-1, 1, -1); scene.add(rim);
const floor = new THREE.Mesh(new THREE.CircleGeometry(0.6, 48),
  new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18 }));
floor.rotation.x = -Math.PI / 2; scene.add(floor);

function applyTheme() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--stage').trim() || '#12333b';
  scene.background = new THREE.Color(bg);
}
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

function size() {
  const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(size).observe(canvas); size();

// ───────── VRM loading ─────────
const loader = new GLTFLoader();
loader.register(parser => new VRMLoaderPlugin(parser));
let vrm = null, requestId = 0, rest = {}, axis = 1; // axis = -1 for VRM 0.x (its normalized bones face the other way)
const BONES = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm'];

async function load(url, name) {
  const id = ++requestId;
  $('model').textContent = '正在載入 ' + name + '…';
  try {
    const gltf = await loader.loadAsync(url);
    const next = gltf.userData.vrm;
    if (!next) throw Error('檔案裡找不到 VRM 資料，請確認是 .vrm 檔');
    if (id !== requestId) { VRMUtils.deepDispose(next.scene); return false; }
    VRMUtils.removeUnnecessaryVertices?.(gltf.scene);
    VRMUtils.combineSkeletons?.(gltf.scene);
    VRMUtils.rotateVRM0(next);
    next.scene.traverse(o => { o.frustumCulled = false; });
    if (vrm) { scene.remove(vrm.scene); VRMUtils.deepDispose(vrm.scene); }
    vrm = next; scene.add(vrm.scene);
    rest = {};
    axis = vrm.meta?.metaVersion === '0' ? -1 : 1;
    for (const b of BONES) {
      const node = vrm.humanoid.getNormalizedBoneNode(b);
      if (node) rest[b] = node.quaternion.clone();
    }
    vrm.update(0); vrm.scene.updateMatrixWorld(true);
    frameCamera();
    $('model').textContent = name + ' · VRM ' + (vrm.meta?.metaVersion ?? '');
    for (const b of ['tap', 'shake', 'save']) $(b).disabled = false;
    return true;
  } catch (error) {
    if (id === requestId) $('model').textContent = '載入失敗：' + error.message;
    return false;
  }
}

function frameCamera() {
  const box = new THREE.Box3().setFromObject(vrm.scene);
  const mid = box.getCenter(new THREE.Vector3());
  const height = Math.max(0.5, box.max.y - box.min.y);
  const target = new THREE.Vector3(mid.x, box.min.y + height * 0.62, mid.z);
  camera.position.set(target.x, target.y + height * 0.05, target.z + height * 1.9);
  controls.target.copy(target);
  controls.minDistance = height * 0.4; controls.maxDistance = height * 5;
  controls.update();
  floor.scale.setScalar(Math.max(0.6, height * 0.45));
  floor.position.y = box.min.y + 0.001;
}

// Remember the viewer's own VRM between visits (per-browser only).
const DB = 'tapvrm', STORE = 'avatar';
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function saveAvatar(file) {
  try {
    const db = await idb();
    db.transaction(STORE, 'readwrite').objectStore(STORE).put({ blob: file, name: file.name }, 'last');
  } catch {}
}
async function loadSavedAvatar() {
  try {
    const db = await idb();
    return await new Promise(res => {
      const q = db.transaction(STORE).objectStore(STORE).get('last');
      q.onsuccess = () => res(q.result || null); q.onerror = () => res(null);
    });
  } catch { return null; }
}
async function forgetAvatar() {
  try { const db = await idb(); db.transaction(STORE, 'readwrite').objectStore(STORE).delete('last'); } catch {}
}

async function useFile(file) {
  if (!file) return;
  if (!/\.vrm$/i.test(file.name)) { $('model').textContent = '請選擇 .vrm 檔（目前是 ' + file.name + '）'; return; }
  const url = URL.createObjectURL(file);
  try {
    if (await load(url, file.name)) { saveAvatar(file); $('reset').hidden = false; }
  } finally { URL.revokeObjectURL(url); }
}
$('avatar').onchange = e => { useFile(e.target.files[0]); e.target.value = ''; };
$('reset').onclick = async () => { await forgetAvatar(); $('reset').hidden = true; load(BUILTIN.url, BUILTIN.name); };
let dragDepth = 0;
addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  useFile(e.dataTransfer.files[0]);
});

// ───────── reaction model ─────────
// A damped spring per axis; taps add an impulse, tilt sets a slow target.
const spring = { pitch: 0, roll: 0, vp: 0, vr: 0 };
const lean = { roll: 0, pitch: 0, tRoll: 0, tPitch: 0 };
let surprise = 0, blinkKick = 0, sleepy = 0, count = 0, misses = 0, happy = 0;
let sensorLive = false, lastHitAt = performance.now(), hitTimes = [];

// ───────── talking ─────────
const pref = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v === '1'; } catch { return d; } };
const keep = (k, v) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch {} };
$('talk').checked = pref('tapvrm-talk', true); $('voice').checked = pref('tapvrm-voice', true);
$('talk').onchange = () => keep('tapvrm-talk', $('talk').checked);
$('voice').onchange = () => { keep('tapvrm-voice', $('voice').checked); if (!$('voice').checked) speechSynthesis?.cancel(); updateSoundHint(); };
const talker = createTalker({
  bubble: $('bubble'),
  isOn: () => $('talk').checked && !!vrm,
  wantsVoice: () => $('voice').checked,
  onSpeak: (kind, text) => { $('said').textContent = '「' + text + '」'; },
  serverVoice: () => streamOpen,
});
let streamOpen = false;
function updateSoundHint() {
  $('soundHint').hidden = streamOpen || !($('voice').checked && 'speechSynthesis' in window && navigator.userActivation && !navigator.userActivation.hasBeenActive);
}
addEventListener('pointerdown', () => setTimeout(updateSoundHint, 0), { once: true });
addEventListener('keydown', () => setTimeout(updateSoundHint, 0), { once: true });
updateSoundHint();
const headPos = new THREE.Vector3();
function placeBubble() {
  const b = $('bubble'), head = vrm?.humanoid.getNormalizedBoneNode('head');
  if (!head) return;
  head.getWorldPosition(headPos); headPos.y += 0.22;
  headPos.project(camera);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const x = Math.max(110, Math.min(w - 110, (headPos.x + 1) / 2 * w + 40));
  const y = Math.max(40, Math.min(h - 40, (1 - headPos.y) / 2 * h));
  b.style.left = x + 'px'; b.style.top = y + 'px';
}

function threshold() { return Number($('gate').value); }

function react(amp, source, dir) {
  const hit = amp >= threshold() && !!vrm;
  if (hit) count++;
  logEvent(amp, source, hit);
  pushMarker(amp, hit);
  if (!hit) return;
  const k = Math.min(1, Math.max(0.2, amp / 0.3));
  let roll = (Math.random() - 0.5) * 0.4;
  if (dir && $('useDir').checked) {
    const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    roll = Math.max(-1, Math.min(1, dir[0] / len * 1.6));
  }
  const now = performance.now();
  lastHitAt = now;
  hitTimes = hitTimes.filter(x => now - x < 2500); hitTimes.push(now);
  if (hitTimes.length >= 3 && talker.say('combo')) hitTimes = [];
  else talker.say(amp >= 0.25 ? 'strong' : amp >= 0.12 ? 'medium' : 'light');
  if (amp < 0.12) happy = 1;
  spring.vp += 9 * k;            // recoil backwards
  spring.vr += 7 * k * roll;     // sideways if the tap had a lateral component
  blinkKick = 1;
  if (amp > 0.2) surprise = 1;
  $('count').textContent = count;
}

let blinkTimer = 2 + Math.random() * 3, blinkPhase = 0;
function animate(dt, t) {
  if (!vrm) return;
  // spring: ω≈12 rad/s, ζ≈0.25 → a few visible wobbles
  for (const [x, v] of [['pitch', 'vp'], ['roll', 'vr']]) {
    const a = -140 * spring[x] - 6 * spring[v];
    spring[v] += a * dt; spring[x] += spring[v] * dt;
  }
  lean.roll += (lean.tRoll - lean.roll) * Math.min(1, dt * 4);
  lean.pitch += (lean.tPitch - lean.pitch) * Math.min(1, dt * 4);

  const breathe = Math.sin(t * 1.6) * 0.02;
  const set = (bone, x, y, z) => {
    const node = vrm.humanoid.getNormalizedBoneNode(bone);
    if (!node || !rest[bone]) return;
    node.quaternion.copy(rest[bone]).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(x * axis, y, z * axis)));
  };
  const p = spring.pitch, r = spring.roll;
  set('hips', 0, 0, lean.roll * 0.35);
  set('spine', -p * 0.35 + breathe + lean.pitch * 0.4, 0, r * 0.25 + lean.roll * 0.3);
  set('chest', -p * 0.25 + breathe, 0, r * 0.2 + lean.roll * 0.2);
  set('neck', -p * 0.3, 0, r * 0.3);
  set('head', -p * 0.55 + sleepy * 0.35, Math.sin(t * 0.5) * 0.05, r * 0.45 - lean.roll * 0.4);
  // arms relaxed down instead of T-pose, swinging a little with the hit
  set('leftUpperArm', 0, 0, -1.2 + p * 0.25 + Math.sin(t * 1.6) * 0.02);
  set('rightUpperArm', 0, 0, 1.2 - p * 0.25 - Math.sin(t * 1.6) * 0.02);
  set('leftLowerArm', 0, -0.25, 0);
  set('rightLowerArm', 0, 0.25, 0);

  // eyes: idle blinks, tap blink, sleepy when the lid is nearly closed
  blinkTimer -= dt;
  if (blinkTimer < 0) { blinkPhase = 1; blinkTimer = 2.5 + Math.random() * 3.5; }
  blinkPhase = Math.max(0, blinkPhase - dt * 7);
  blinkKick = Math.max(0, blinkKick - dt * 4);
  surprise = Math.max(0, surprise - dt * 1.2);
  const em = vrm.expressionManager;
  if (em) {
    const idle = Math.sin(blinkPhase * Math.PI);
    if (em.getExpression('blink')) em.setValue('blink', Math.min(1, Math.max(idle, blinkKick, sleepy * 0.75) * (1 - surprise)));
    const talk = talker.mouth(t);
    happy = Math.max(0, happy - dt * 0.8);
    if (em.getExpression('surprised')) em.setValue('surprised', surprise);
    if (em.getExpression('happy')) em.setValue('happy', happy * 0.8 * (1 - surprise));
    if (em.getExpression('aa')) em.setValue('aa', Math.min(1, Math.max(talk, em.getExpression('surprised') ? 0 : surprise * 0.8)));
  }
}

// ───────── live sensor stream ─────────
const STATES = {
  idle: ['未連接', 'off'], authorizing: ['等待授權', 'wait'], connecting: ['連接中', 'wait'],
  live: ['實機感測中', 'on'], denied: ['未授權', 'off'], error: ['錯誤', 'bad'],
  replay: ['回放中', 'on'], offline: ['服務離線', 'bad'],
};
function setState(state, msg) {
  if (state === 'live' && !sensorLive) setTimeout(() => talker.say('hello'), 800);
  sensorLive = state === 'live';
  const [label, cls] = STATES[state] || [state, 'off'];
  $('chip').textContent = label; $('chip').className = 'chip ' + cls;
  $('hint').textContent = msg || ({
    live: '輕敲機殼或桌面試試。傾斜筆電，分身也會跟著歪。',
    idle: '按「連接感測器」，macOS 會跳出密碼視窗。',
    offline: '本機服務沒有在跑。請點兩下 TapVRM.command 啟動；按鈕模擬仍可使用。',
    replay: '正在重播 events.jsonl。',
  }[state] || '');
  $('connect').hidden = !['idle', 'denied', 'error'].includes(state);
  $('readouts').hidden = state !== 'live';
}

let baseline = null, lastG = null;
function onFrame(f) {
  pushWave(f.d);
  lastG = f.g;
  if (!baseline) baseline = f.g;
  if ($('tilt').checked && baseline) {
    const ang = g => [Math.atan2(g[0], -g[2]), Math.atan2(g[1], -g[2])];
    const [r0, p0] = ang(baseline), [r1, p1] = ang(f.g);
    const clamp = v => Math.max(-0.5, Math.min(0.5, v));
    lean.tRoll = clamp(r1 - r0); lean.tPitch = clamp(p1 - p0);
  } else { lean.tRoll = lean.tPitch = 0; }
  $('tiltVal').textContent = (lean.tRoll * 180 / Math.PI).toFixed(0) + '° / ' + (lean.tPitch * 180 / Math.PI).toFixed(0) + '°';
  if (typeof f.lid === 'number') {
    $('lidVal').textContent = f.lid.toFixed(0) + '°';
    sleepy = Math.max(0, Math.min(1, (75 - f.lid) / 45));
  } else { $('lidVal').textContent = '—'; sleepy = 0; }
  $('dynVal').textContent = f.d.toFixed(3) + ' g';
  situations(f);
}

// Ambient situations from the raw sensor frames (independent of the display toggles).
let tiltSince = 0, tilted = false, lidClosed = false, avgD = 0, floorD = 0.01, typingFor = 0;
function situations(f) {
  const now = performance.now();
  const ang = g => [Math.atan2(g[0], -g[2]), Math.atan2(g[1], -g[2])];
  const [r0, p0] = ang(baseline), [r1, p1] = ang(f.g);
  const deg = Math.hypot(r1 - r0, p1 - p0) * 180 / Math.PI;
  if (deg > 12) {
    tiltSince ||= now;
    if (now - tiltSince > 600) { tilted = true; talker.say(deg > 30 ? 'tiltBig' : 'tilt'); }
  } else {
    tiltSince = 0;
    if (tilted && deg < 5) { tilted = false; talker.say('level'); }
  }
  if (typeof f.lid === 'number') {
    if (!lidClosed && f.lid < 40) { lidClosed = true; talker.say('lidLow'); }
    else if (lidClosed && f.lid > 70) { lidClosed = false; talker.say('lidOpen'); }
  }
  // Sustained small vibration well above this desk's own noise floor → probably typing.
  avgD += (f.d - avgD) * 0.03;
  floorD = Math.min(floorD + 0.00002, Math.max(0.001, avgD));
  const busy = avgD > Math.max(0.01, floorD * 3) && f.d < threshold() && now - lastHitAt > 3000;
  typingFor = busy ? typingFor + 1 : Math.max(0, typingFor - 2);
  if (typingFor > 30 * 4) { typingFor = 0; talker.say('typing'); }
  if (now - lastHitAt > 45000 && talker.quietFor() > 45) talker.say('bored');
}
$('calibrate').onclick = () => { baseline = lastG; };

function connectStream() {
  if (location.protocol === 'file:') { setState('offline'); return; }
  const es = new EventSource('/api/stream');
  es.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'f') onFrame(m);
    else if (m.t === 'tap') react(m.amp, m.src === 'replay' ? '回放' : '實機', m.dir);
    else if (m.t === 'status') setState(m.state, m.msg);
  };
  es.onopen = () => { streamOpen = true; updateSoundHint(); };
  es.onerror = () => { streamOpen = false; setState('offline'); updateSoundHint(); };
}
$('quit').onclick = async () => {
  try { await fetch('/api/quit', { method: 'POST', headers: { 'X-TapVRM': '1' } }); } catch {}
  document.body.innerHTML = '<p style="padding:40px;font-size:20px">TapVRM 已結束，感測器也一併關閉。可以關掉這個分頁了。</p>';
};
$('connect').onclick = () => {
  fetch('/api/sensor/start', { method: 'POST', headers: { 'X-TapVRM': '1' } }).catch(() => setState('offline'));
};

// ───────── waveform meter ─────────
const wave = $('wave'), wctx = wave.getContext('2d');
const N = 240, samples = new Float32Array(N), markers = [];
let head = 0;
const SPAN = N / 30; // seconds shown (sensor frames arrive at ~30 Hz)
function pushWave(v) { samples[head] = v; head = (head + 1) % N; }
function pushMarker(amp, hit) { markers.push({ amp, hit, at: performance.now() }); if (markers.length > 30) markers.shift(); }
const MAXG = 0.5, ys = v => Math.sqrt(Math.min(1, v / MAXG)); // sqrt scale shows small vibrations too
function drawWave() {
  const dpr = Math.min(devicePixelRatio, 2), w = wave.clientWidth, h = wave.clientHeight;
  if (wave.width !== w * dpr) { wave.width = w * dpr; wave.height = h * dpr; }
  const css = getComputedStyle(document.documentElement);
  wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  wctx.clearRect(0, 0, w, h);
  const y = v => h - 4 - ys(v) * (h - 10);
  wctx.strokeStyle = css.getPropertyValue('--warn'); wctx.setLineDash([4, 4]); wctx.lineWidth = 1;
  wctx.beginPath(); wctx.moveTo(0, y(threshold())); wctx.lineTo(w, y(threshold())); wctx.stroke(); wctx.setLineDash([]);
  wctx.strokeStyle = css.getPropertyValue('--accent'); wctx.lineWidth = 1.5; wctx.beginPath();
  for (let i = 0; i < N; i++) {
    const v = samples[(head + i) % N], x = i / (N - 1) * w;
    i ? wctx.lineTo(x, y(v)) : wctx.moveTo(x, y(v));
  }
  wctx.stroke();
  for (const m of markers) {
    const age = (performance.now() - m.at) / 1000 / SPAN;
    if (age >= 1) continue;
    const x = (1 - age) * w - 5;
    wctx.fillStyle = m.hit ? css.getPropertyValue('--accent') : css.getPropertyValue('--muted');
    wctx.beginPath(); wctx.arc(x, y(m.amp), m.hit ? 4 : 3, 0, Math.PI * 2); wctx.fill();
  }
}

// ───────── UI ─────────
function logEvent(amp, source, hit) {
  if (!hit) misses++;
  const li = document.createElement('li');
  const time = new Date().toLocaleTimeString('zh-TW', { hour12: false });
  li.innerHTML = `<span>${time}</span><span>${source}</span><b>${amp.toFixed(3)} g</b><span class="${hit ? 'hit' : 'miss'}">${hit ? '回應' : '低於門檻'}</span>`;
  $('log').prepend(li);
  while ($('log').children.length > 7) $('log').lastChild.remove();
  $('event').textContent = `${source}　${amp.toFixed(3)} g　${hit ? '已回應 ' + count + ' 次' : '低於門檻'}`;
}
$('gate').oninput = () => { $('value').textContent = threshold().toFixed(2); try { localStorage.setItem('tapvrm-gate', $('gate').value); } catch {} };
try { const g = localStorage.getItem('tapvrm-gate'); if (g) { $('gate').value = g; $('value').textContent = Number(g).toFixed(2); } } catch {}
$('tap').onclick = () => react(0.11, '按鈕模擬');
$('shake').onclick = () => react(0.31, '按鈕模擬');

$('save').onclick = () => {
  renderer.render(scene, camera);
  const out = document.createElement('canvas'); out.width = 1440; out.height = 900;
  const ctx = out.getContext('2d'); ctx.fillStyle = '#102d34'; ctx.fillRect(0, 0, 1440, 900);
  const scale = Math.min(850 / canvas.width, 860 / canvas.height), w = canvas.width * scale, h = canvas.height * scale;
  ctx.drawImage(canvas, (850 - w) / 2, (900 - h) / 2, w, h);
  ctx.fillStyle = '#a4ecbb'; ctx.font = '600 29px system-ui'; ctx.fillText('VRM  /  觸碰實驗', 875, 300);
  ctx.fillStyle = '#ffffff'; ctx.font = '500 28px system-ui'; ctx.fillText($('model').textContent, 875, 375, 520);
  ctx.fillText('觸發門檻　' + $('value').textContent + ' g　·　回應 ' + count + ' 次', 875, 435, 520);
  ctx.fillText('感測器　' + $('chip').textContent, 875, 495, 520);
  ctx.fillStyle = '#ffd6a1'; ctx.fillText($('event').textContent, 875, 565, 520);
  out.toBlob(blob => {
    if (!blob) return;
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = 'VRM-touch-experiment.png'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  });
};

// ───────── main loop ─────────
let prevT = performance.now();
function frame() {
  const nowT = performance.now(), dt = Math.min(0.05, (nowT - prevT) / 1000), t = nowT / 1000; prevT = nowT;
  animate(dt, t);
  vrm?.update(dt);
  controls.update();
  placeBubble();
  renderer.render(scene, camera);
  drawWave();
  requestAnimationFrame(frame);
}

(async () => {
  const saved = await loadSavedAvatar();
  let ok = false;
  if (saved?.blob) {
    const url = URL.createObjectURL(saved.blob);
    ok = await load(url, saved.name);
    URL.revokeObjectURL(url);
    $('reset').hidden = !ok;
  }
  if (!ok) await load(BUILTIN.url, BUILTIN.name);
})();
setState('idle');
connectStream();
frame();

// Console hook for experiments: tapvrm.react(0.3, '手動'), tapvrm.onFrame({d:0, g:[0.3,0,-0.95]})
window.tapvrm = { react, onFrame, say: k => talker.say(k) };
