// Карта мира: 3D-глобус с маркерами-островами и облачным слоем.
//
// ЧТО ЗДЕСЬ
// ---------
//   * Сфера Земли с текстурой blue-marble.
//   * Сфера облаков — вторая сфера чуть большего радиуса, с текстурой
//     cloud (с альфа-каналом). Медленно вращается вокруг оси Y.
//   * Маркеры островов — спрайты с canvas-иконкой (трава + кубики + флаг).
//     Размер 120px на экране фиксированный, тап через screen-space.
//   * Компактные ники: показываются только при приближении (camDist < 2R)
//     и висят ВЫСОКО над островом, чтобы не перекрывать постройки.
//
// ПЕРЕМЕЩЕНИЕ CANVAS
// ------------------
// Один и тот же canvas можно перенести в другой контейнер — просто
// через appendChild. Это позволяет использовать одну сцену и в меню
// (фоновый глобус), и на карте (полноэкранный режим), не поднимая
// второй WebGL-контекст.
//
// УПРАВЛЕНИЕ ОБЛАКАМИ
// -------------------
// setCloudsVisible(bool) — скрыть/показать облака. Вызывается из
// настроек графики: low = false.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FLAG_COLORS_HEX } from './config.js';

const WORLD_TO_DEG = 0.01;
const WORLD_CENTER_LON = 10;
const WORLD_CENTER_LAT = 50;

const SPHERE_RADIUS = 100;
const CLOUD_RADIUS = SPHERE_RADIUS * 1.005;

const EARTH_TEXTURE_SOURCES = [
  'https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg',
  'https://unpkg.com/three-globe/example/img/earth-day.jpg',
];

const CLOUD_TEXTURE_SOURCES = [
  'https://unpkg.com/three@0.160.0/examples/textures/planets/earth_clouds_1024.png',
  'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/textures/planets/earth_clouds_1024.png',
];

const HIT_RADIUS_PX = 60;

let scene = null;
let camera = null;
let renderer = null;
let controls = null;
let sphereMesh = null;
let cloudMesh = null;
let markersGroup = null;

let container = null;
let onTapCallback = null;
let disposed = false;
let running = false;
let animationId = 0;

const markers = new Map();
let rawPoints = [];
let myUserId = null;

// Текущие настройки видимости, чтобы можно было применить их при
// следующем рендере после setVisible.
let cloudsVisible = true;

const _projVec = new THREE.Vector3();

// --- Инициализация --------------------------------------------------------

export function initMap3D(containerEl, { onPointTap, myUserId: myId } = {}) {
  if (scene) {
    // Уже инициализирован — просто перемещаем canvas в новый контейнер.
    attachTo(containerEl);
    return;
  }
  container = containerEl;
  onTapCallback = onPointTap;
  myUserId = myId;

  const w = container.clientWidth || window.innerWidth;
  const h = container.clientHeight || window.innerHeight;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x060b18);

  camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 10000);
  const startPos = latLonToVec3(WORLD_CENTER_LAT, WORLD_CENTER_LON, SPHERE_RADIUS * 3.0);
  camera.position.copy(startPos);
  camera.lookAt(0, 0, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.touchAction = 'none';
  renderer.domElement.style.filter = 'saturate(1.25) contrast(1.05)';
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.15;
  controls.rotateSpeed = 0.4;
  controls.zoomSpeed = 0.7;
  controls.minDistance = SPHERE_RADIUS * 1.15;
  controls.maxDistance = SPHERE_RADIUS * 5;
  controls.enablePan = false;
  controls.target.set(0, 0, 0);

  // Сфера Земли.
  const earthGeo = new THREE.SphereGeometry(SPHERE_RADIUS, 96, 48);
  const earthMat = new THREE.MeshBasicMaterial({ color: 0x3a5f8a, toneMapped: false });
  sphereMesh = new THREE.Mesh(earthGeo, earthMat);
  scene.add(sphereMesh);
  loadTexture(EARTH_TEXTURE_SOURCES, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    earthMat.map = tex;
    earthMat.color.set(0xffffff);
    earthMat.needsUpdate = true;
  });

  // Сфера облаков: чуть больше Земли, transparent, с альфа-текстурой.
  // NormalBlending — облака и светлее, и тёмнее фона, а не только
  // «добавляются» к нему. Так они выглядят объёмными.
  const cloudGeo = new THREE.SphereGeometry(CLOUD_RADIUS, 64, 32);
  const cloudMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    blending: THREE.NormalBlending,
    toneMapped: false,
  });
  cloudMesh = new THREE.Mesh(cloudGeo, cloudMat);
  scene.add(cloudMesh);
  loadTexture(CLOUD_TEXTURE_SOURCES, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    cloudMat.map = tex;
    cloudMat.needsUpdate = true;
  });

  markersGroup = new THREE.Group();
  scene.add(markersGroup);

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  window.addEventListener('resize', onResize);

  running = true;
  animate();
}

function loadTexture(sources, onLoad) {
  let idx = 0;
  const tryNext = () => {
    if (idx >= sources.length) return;
    const url = sources[idx];
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    loader.load(url, onLoad, undefined, () => { idx++; tryNext(); });
  };
  tryNext();
}

// Перемещает canvas в другой контейнер. Используется при переходе
// «меню → карта» и обратно. Один WebGL контекст, разные хозяева.
export function attachTo(el) {
  if (!renderer || !el) return;
  container = el;
  el.appendChild(renderer.domElement);
  onResize();
}

export function setMapVisible(visible) {
  if (!renderer) return;
  renderer.domElement.style.display = visible ? 'block' : 'none';
}

// --- Координаты ----------------------------------------------------------

function worldToLatLon(wx, wy) {
  return {
    lon: WORLD_CENTER_LON + wx * WORLD_TO_DEG,
    lat: WORLD_CENTER_LAT - wy * WORLD_TO_DEG,
  };
}

function latLonToVec3(lat, lon, radius) {
  const phi = (90 - lat) * Math.PI / 180;
  const theta = (lon + 180) * Math.PI / 180;
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
     radius * Math.cos(phi),
     radius * Math.sin(phi) * Math.sin(theta),
  );
}

// --- Иконка острова -------------------------------------------------------

const islandIconCache = new Map();

function makeIslandIcon(colorHex, cubes, isMine) {
  const cubeBucket = cubes <= 5 ? 's' : cubes <= 20 ? 'm' : 'l';
  const key = `i|${colorHex}|${cubeBucket}|${isMine ? 'm' : ''}`;
  if (islandIconCache.has(key)) return islandIconCache.get(key);

  const W = 240, H = 180;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  if (isMine) {
    const glow = ctx.createRadialGradient(W / 2, H * 0.7, 10, W / 2, H * 0.7, W * 0.55);
    glow.addColorStop(0, 'rgba(253,230,138,.55)');
    glow.addColorStop(1, 'rgba(253,230,138,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
  }

  const cx = W / 2;
  const cy = H * 0.72;

  // Диск травы.
  const discRX = 82, discRY = 26;
  ctx.beginPath();
  ctx.ellipse(cx, cy + 8, discRX, discRY, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#2d5130';
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx, cy, discRX, discRY, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#4a7a4e';
  ctx.fill();
  ctx.strokeStyle = 'rgba(20,35,20,.7)';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Кубики в изометрии.
  const layouts = {
    s: [[0, 0]],
    m: [[-22, 0], [22, 6]],
    l: [[-30, 4], [10, 0], [30, 8]],
  };
  const cubesList = layouts[cubeBucket];
  const cubeSize = 42;

  for (const [ox, oy] of cubesList) {
    const x = cx + ox;
    const y = cy - cubeSize / 2 + oy;
    const isIron = cubeBucket === 'l';
    const topColor = isIron ? '#c9d2da' : '#d9a066';
    const leftColor = isIron ? '#7a848c' : '#a06b3a';
    const rightColor = isIron ? '#8e99a3' : '#b87e46';

    ctx.beginPath();
    ctx.moveTo(x, y - cubeSize * 0.55);
    ctx.lineTo(x + cubeSize * 0.75, y - cubeSize * 0.15);
    ctx.lineTo(x, y + cubeSize * 0.25);
    ctx.lineTo(x - cubeSize * 0.75, y - cubeSize * 0.15);
    ctx.closePath();
    ctx.fillStyle = topColor;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(x - cubeSize * 0.75, y - cubeSize * 0.15);
    ctx.lineTo(x, y + cubeSize * 0.25);
    ctx.lineTo(x, y + cubeSize * 0.85);
    ctx.lineTo(x - cubeSize * 0.75, y + cubeSize * 0.45);
    ctx.closePath();
    ctx.fillStyle = leftColor;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(x + cubeSize * 0.75, y - cubeSize * 0.15);
    ctx.lineTo(x, y + cubeSize * 0.25);
    ctx.lineTo(x, y + cubeSize * 0.85);
    ctx.lineTo(x + cubeSize * 0.75, y + cubeSize * 0.45);
    ctx.closePath();
    ctx.fillStyle = rightColor;
    ctx.fill();

    ctx.strokeStyle = 'rgba(20,15,10,.65)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y - cubeSize * 0.55);
    ctx.lineTo(x + cubeSize * 0.75, y - cubeSize * 0.15);
    ctx.lineTo(x + cubeSize * 0.75, y + cubeSize * 0.45);
    ctx.lineTo(x, y + cubeSize * 0.85);
    ctx.lineTo(x - cubeSize * 0.75, y + cubeSize * 0.45);
    ctx.lineTo(x - cubeSize * 0.75, y - cubeSize * 0.15);
    ctx.closePath();
    ctx.stroke();
  }

  // Флаг.
  const fx = cx + 78;
  const fBaseY = cy + 4;
  const fTopY = cy - 72;
  ctx.strokeStyle = '#3a3a3a';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(fx, fBaseY);
  ctx.lineTo(fx, fTopY);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(fx, fTopY);
  ctx.quadraticCurveTo(fx + 22, fTopY - 3, fx + 40, fTopY + 6);
  ctx.lineTo(fx + 40, fTopY + 30);
  ctx.quadraticCurveTo(fx + 20, fTopY + 22, fx, fTopY + 30);
  ctx.closePath();
  ctx.fillStyle = colorHex;
  ctx.fill();
  ctx.strokeStyle = 'rgba(20,15,10,.55)';
  ctx.lineWidth = 2;
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  islandIconCache.set(key, tex);
  return tex;
}

// --- Ник: компактный, чтобы не перекрывать иконку ------------------------
// Шрифт 26px вместо 38, плашка плотная, высота 38 вместо 56. Ник висит
// на расстоянии 12 единиц от острова — заметно выше кубиков.

const labelTexCache = new Map();

function makeLabelTexture(username, isMine) {
  const key = `l|${username}|${isMine ? 'm' : ''}`;
  if (labelTexCache.has(key)) return labelTexCache.get(key);

  const FONT_SIZE = 26;
  const PADDING_X = 14;
  const HEIGHT = 38;

  const measure = document.createElement('canvas').getContext('2d');
  measure.font = `800 ${FONT_SIZE}px system-ui,-apple-system,sans-serif`;
  const tw = Math.ceil(measure.measureText(username).width);
  const W = tw + PADDING_X * 2;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');

  const radius = HEIGHT / 2;
  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.arcTo(W, 0, W, HEIGHT, radius);
  ctx.arcTo(W, HEIGHT, 0, HEIGHT, radius);
  ctx.arcTo(0, HEIGHT, 0, 0, radius);
  ctx.arcTo(0, 0, W, 0, radius);
  ctx.closePath();
  ctx.fillStyle = isMine ? 'rgba(30,41,59,.92)' : 'rgba(11,16,32,.88)';
  ctx.fill();
  ctx.strokeStyle = isMine ? 'rgba(253,230,138,.75)' : 'rgba(255,255,255,.22)';
  ctx.lineWidth = 1.8;
  ctx.stroke();

  ctx.font = `800 ${FONT_SIZE}px system-ui,-apple-system,sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = isMine ? '#fde68a' : '#ffffff';
  ctx.fillText(username, W / 2, HEIGHT / 2 + 1);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  labelTexCache.set(key, tex);
  return tex;
}

// --- Маркеры --------------------------------------------------------------

export function setMapPoints(points) {
  if (!markersGroup) return;
  rawPoints = points || [];

  const seen = new Set();

  for (const p of rawPoints) {
    seen.add(String(p.user_id));

    const isMine = myUserId && String(p.user_id) === String(myUserId);
    const hex = FLAG_COLORS_HEX[p.flag_color] ?? 0xef4444;
    const css = '#' + hex.toString(16).padStart(6, '0');

    let entry = markers.get(String(p.user_id));

    if (!entry) {
      const iconTex = makeIslandIcon(css, p.cube_count || 0, isMine);
      const iconMat = new THREE.SpriteMaterial({
        map: iconTex, transparent: true, depthWrite: false, depthTest: false,
      });
      const icon = new THREE.Sprite(iconMat);

      const labelTex = makeLabelTexture(p.username, isMine);
      const labelMat = new THREE.SpriteMaterial({
        map: labelTex, transparent: true, depthWrite: false, depthTest: false,
      });
      const label = new THREE.Sprite(labelMat);

      const { lat, lon } = worldToLatLon(p.world_x, p.world_y);
      const basePos = latLonToVec3(lat, lon, SPHERE_RADIUS * 1.01);
      icon.position.copy(basePos);

      const normal = basePos.clone().normalize();
      const up = new THREE.Vector3(0, 14, 0);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
      up.applyQuaternion(q);
      label.position.copy(basePos).add(up);

      markersGroup.add(icon);
      markersGroup.add(label);

      entry = {
        icon, label, data: p, isMine,
        iconAspect: iconTex.image.width / iconTex.image.height,
        labelAspect: labelTex.image.width / labelTex.image.height,
        basePos,
      };
      markers.set(String(p.user_id), entry);
    } else {
      const { lat, lon } = worldToLatLon(p.world_x, p.world_y);
      const newPos = latLonToVec3(lat, lon, SPHERE_RADIUS * 1.01);
      if (!entry.basePos.equals(newPos)) {
        entry.icon.position.copy(newPos);
        const normal = newPos.clone().normalize();
        const up = new THREE.Vector3(0, 14, 0);
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
        up.applyQuaternion(q);
        entry.label.position.copy(newPos).add(up);
        entry.basePos = newPos;
      }
      entry.data = p;
    }

    entry.icon.visible = true;
    // Ник виден только когда остров близко. На дальнем плане иконка
    // мелкая, ник только мешает.
    entry.label.visible = false;
  }

  for (const [id, entry] of markers) {
    if (!seen.has(id)) {
      markersGroup.remove(entry.icon);
      markersGroup.remove(entry.label);
      entry.icon.material.dispose();
      entry.label.material.dispose();
      markers.delete(id);
    }
  }

  updateMarkerSizes();
}

function updateMarkerSizes() {
  const h = renderer.domElement.clientHeight;
  const vFov = (camera.fov * Math.PI) / 180;
  const k = (2 * Math.tan(vFov / 2)) / h;

  const camDist = camera.position.length();
  const showLabels = camDist < SPHERE_RADIUS * 2.0;

  for (const entry of markers.values()) {
    const dist = camera.position.distanceTo(entry.icon.position);

    // Иконка острова: 120 пикселей по высоте.
    const iconPx = 120;
    const iconScale = k * dist * iconPx;
    entry.icon.scale.set(iconScale * entry.iconAspect, iconScale, 1);

    // Компактный ник.
    const labelPx = 20;
    const labelScale = k * dist * labelPx;
    entry.label.scale.set(labelScale * entry.labelAspect, labelScale, 1);

    entry.label.visible = showLabels;
  }
}

// --- Облака ---------------------------------------------------------------

export function setCloudsVisible(visible) {
  cloudsVisible = !!visible;
  if (cloudMesh) cloudMesh.visible = cloudsVisible;
}

// --- Цикл ----------------------------------------------------------------

function animate() {
  if (disposed) return;
  animationId = requestAnimationFrame(animate);
  if (!running) return;

  controls.update();

  // Облака вращаются медленно, 0.015 рад/сек — полный оборот ~7 минут.
  if (cloudMesh && cloudsVisible) {
    cloudMesh.rotation.y += 0.0004;
  }

  updateMarkerSizes();
  renderer.render(scene, camera);
}

// --- Тап ----------------------------------------------------------------

let pointerDown = { x: 0, y: 0, t: 0 };

function onPointerDown(ev) {
  pointerDown = { x: ev.clientX, y: ev.clientY, t: performance.now() };
}

function onPointerUp(ev) {
  if (!onTapCallback) return;
  const dx = ev.clientX - pointerDown.x;
  const dy = ev.clientY - pointerDown.y;
  if (Math.hypot(dx, dy) > 10) return;
  if (performance.now() - pointerDown.t > 500) return;

  const rect = renderer.domElement.getBoundingClientRect();
  const tapX = ev.clientX - rect.left;
  const tapY = ev.clientY - rect.top;
  const camPos = camera.position;

  const candidates = [];
  for (const [uid, entry] of markers.entries()) {
    _projVec.copy(entry.icon.position).project(camera);
    if (_projVec.z > 1) continue;
    const sx = (_projVec.x * 0.5 + 0.5) * rect.width;
    const sy = (-_projVec.y * 0.5 + 0.5) * rect.height;
    const screenDist = Math.hypot(sx - tapX, sy - tapY);
    if (screenDist > HIT_RADIUS_PX) continue;
    candidates.push({ uid, entry, screenDist, camDist: camPos.distanceTo(entry.icon.position) });
  }

  if (!candidates.length) return;
  candidates.sort((a, b) => (a.camDist - b.camDist) || (a.screenDist - b.screenDist));
  const chosen = candidates[0];
  if (chosen.entry.isMine) return;
  onTapCallback(chosen.uid, chosen.entry.data.username);
}

// --- Публичное API -------------------------------------------------------

export function flyToPlayer(userId, username, { zoom = 1 } = {}) {
  if (!camera || !controls) return;
  let target = null;
  const m = markers.get(String(userId));
  if (m) target = m.icon.position.clone();
  else {
    for (const p of rawPoints) {
      if (String(p.user_id) === String(userId)) {
        const { lat, lon } = worldToLatLon(p.world_x, p.world_y);
        target = latLonToVec3(lat, lon, SPHERE_RADIUS * 1.01);
        break;
      }
    }
  }
  if (!target) return;

  const dir = target.clone().normalize();
  const currentDist = camera.position.length();
  const finalDist = Math.max(
    controls.minDistance,
    Math.min(controls.maxDistance, (SPHERE_RADIUS * 2.2) / zoom)
  );
  const endPos = dir.clone().multiplyScalar(finalDist);
  const startPos = camera.position.clone();

  const startT = performance.now();
  const dur = 900;
  const step = () => {
    if (disposed) return;
    const k = Math.min(1, (performance.now() - startT) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    const lerped = startPos.clone().lerp(endPos, e);
    const targetDist = currentDist + (finalDist - currentDist) * e;
    camera.position.copy(lerped.normalize().multiplyScalar(targetDist));
    camera.lookAt(0, 0, 0);
    if (k < 1) requestAnimationFrame(step);
  };
  step();
}

export function setMapCameraToMe() {
  if (!myUserId) return;
  flyToPlayer(String(myUserId), '', { zoom: 1.5 });
}

export function zoomMapBy(factor) {
  if (!camera || !controls) return;
  const dir = camera.position.clone().normalize();
  const currentDist = camera.position.length();
  let newDist = currentDist / factor;
  newDist = Math.max(controls.minDistance, Math.min(controls.maxDistance, newDist));
  const startDist = currentDist;
  const startT = performance.now();
  const dur = 220;
  const step = () => {
    if (disposed) return;
    const k = Math.min(1, (performance.now() - startT) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    const d = startDist + (newDist - startDist) * e;
    camera.position.copy(dir.clone().multiplyScalar(d));
    camera.lookAt(0, 0, 0);
    if (k < 1) requestAnimationFrame(step);
  };
  step();
}

export function setMapCameraDistance(distance) {
  if (!camera || !controls) return;
  const dir = camera.position.clone().normalize();
  camera.position.copy(dir.multiplyScalar(distance));
  camera.lookAt(0, 0, 0);
}

export function tweenMapCamera(from, to, ms) {
  return new Promise((resolve) => {
    if (!camera || !controls) return resolve();
    const dir = camera.position.clone().normalize();
    const startT = performance.now();
    const step = () => {
      if (disposed) return resolve();
      const k = Math.min(1, (performance.now() - startT) / ms);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      const d = from + (to - from) * e;
      camera.position.copy(dir.clone().multiplyScalar(d));
      camera.lookAt(0, 0, 0);
      if (k < 1) requestAnimationFrame(step);
      else resolve();
    };
    step();
  });
}

export function resizeMap3D() { onResize(); }

export function setMapRunning(on) {
  running = on;
  if (on && camera && controls) onResize();
}

function onResize() {
  if (!container || !renderer || !camera) return;
  const w = container.clientWidth || window.innerWidth;
  const h = container.clientHeight || window.innerHeight;
  if (w === 0 || h === 0) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

export function disposeMap3D() {
  disposed = true;
  running = false;
  cancelAnimationFrame(animationId);
  window.removeEventListener('resize', onResize);
  if (renderer) {
    renderer.domElement.removeEventListener('pointerdown', onPointerDown);
    renderer.domElement.removeEventListener('pointerup', onPointerUp);
    renderer.dispose();
    if (renderer.domElement.parentElement) {
      renderer.domElement.parentElement.removeChild(renderer.domElement);
    }
  }
  markers.clear();
  rawPoints = [];
  scene = null;
  camera = null;
  renderer = null;
  controls = null;
  sphereMesh = null;
  cloudMesh = null;
  markersGroup = null;
    }
