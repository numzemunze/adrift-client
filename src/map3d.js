// Карта мира: 3D-глобус с реальными островами игроков.
//
// ДВУХУРОВНЕВЫЙ LOD
// -----------------
//   ДАЛЕКО (camDist > 1.7R)  — иконка-спрайт с изометрией. Один draw call
//                              на игрока, дёшево, но силуэт приблизительный.
//   БЛИЗКО (camDist < 1.7R)  — настоящая 3D-модель, собранная из кубиков
//                              игрока (эндпоинт /islands/map/cubes).
//
// Кубы запрашиваются лениво: только для игроков, попавших в близкую зону.
// Кэш на 30 секунд — за это время постройки обычно не меняются.
//
// СБОРКА МОДЕЛИ
// -------------
// Все кубы одного острова собираются в одну BufferGeometry через
// mergeGeometries, цвет задаётся vertex attributes. Один меш на остров,
// один draw call, до 60 кубиков внутри — рисуется быстро.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FLAG_COLORS_HEX, BLOCK_COLORS_HEX } from './config.js';

const WORLD_TO_DEG = 0.01;
const WORLD_CENTER_LON = 10;
const WORLD_CENTER_LAT = 50;

const SPHERE_RADIUS = 100;

// Пороги LOD (в радиусах сферы).
const CLOSE_DIST = 1.7;      // ближе — показываем 3D-модели
const LABEL_DIST = 2.4;      // ближе — показываем ники

// Масштаб игрового мира на поверхности глобуса. Остров занимает
// [-32..32] игровых клеток = 64 клетки. При 0.5 это 32 единицы на
// сфере радиуса 100 — остров читается крупно, но не «прилипает»
// к другим.
const CUBE_SCALE = 0.5;

// Рабочие URL для текстуры Земли. Первый — из three.js examples,
// проверенно рабочий, остальные — на случай падения CDN.
const EARTH_TEXTURE_SOURCES = [
  'https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg',
  'https://raw.githubusercontent.com/mrdoob/three.js/r160/examples/textures/planets/earth_atmos_2048.jpg',
  'https://unpkg.com/three@0.160.0/examples/textures/planets/earth_atmos_2048.jpg',
];

const HIT_RADIUS_PX = 60;

let scene = null;
let camera = null;
let renderer = null;
let controls = null;
let sphereMesh = null;
let markersGroup = null;

let container = null;
let onTapCallback = null;
let onNeedCubes = null;
let disposed = false;
let running = false;
let animationId = 0;

// user_id → {
//   icon, label, group,       // объекты сцены
//   data, isMine, basePos,    // данные
//   cubes, cubesFetched,      // 3D-модель
//   iconAspect, labelAspect,
// }
const markers = new Map();
let rawPoints = [];
let myUserId = null;

// Очередь на загрузку кубов: собираем user_id, для которых нужны
// модели, и раз в 200мс отправляем один батч-запрос.
const pendingCubeIds = new Set();
let cubeFetchTimer = null;

const _projVec = new THREE.Vector3();

// --- Инициализация --------------------------------------------------------

export function initMap3D(containerEl, { onPointTap, onNeedCubes: needCubes, myUserId: myId } = {}) {
  if (scene) {
    attachTo(containerEl);
    return;
  }
  container = containerEl;
  onTapCallback = onPointTap;
  onNeedCubes = needCubes;
  myUserId = myId;

  const w = container.clientWidth || window.innerWidth;
  const h = container.clientHeight || window.innerHeight;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05081a);

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
  renderer.domElement.style.filter = 'saturate(1.15) contrast(1.08)';
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.15;
  controls.rotateSpeed = 0.4;
  controls.zoomSpeed = 0.7;
  controls.minDistance = SPHERE_RADIUS * 1.15;
  controls.maxDistance = SPHERE_RADIUS * 4;
  controls.enablePan = false;
  controls.target.set(0, 0, 0);

  // Сфера Земли. MeshBasicMaterial — не зависит от освещения, цвет
  // текстуры показывается как есть. Так избегаем багов с шейдерами.
  const earthGeo = new THREE.SphereGeometry(SPHERE_RADIUS, 96, 48);
  const earthMat = new THREE.MeshBasicMaterial({ color: 0x2a4a7a, toneMapped: false });
  sphereMesh = new THREE.Mesh(earthGeo, earthMat);
  scene.add(sphereMesh);

  loadEarthTexture(earthMat);

  // Свет для 3D-моделей островов. Ambient — чтобы тени не были чёрными,
  // directional — чтобы у кубиков читались грани.
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(200, 300, 100);
  scene.add(sun);

  markersGroup = new THREE.Group();
  scene.add(markersGroup);

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  window.addEventListener('resize', onResize);

  running = true;
  animate();
}

function loadEarthTexture(material) {
  let idx = 0;
  const tryNext = () => {
    if (idx >= EARTH_TEXTURE_SOURCES.length) {
      console.warn('map3d: все источники текстуры Земли недоступны');
      return;
    }
    const url = EARTH_TEXTURE_SOURCES[idx];
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    loader.load(
      url,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
        material.map = tex;
        material.color.set(0xffffff);
        material.needsUpdate = true;
      },
      undefined,
      () => { console.warn('map3d: 404 на', url); idx++; tryNext(); },
    );
  };
  tryNext();
}

// Переместить canvas в другой контейнер. Используется для перехода
// «меню ↔ карта».
export function attachTo(el) {
  if (!renderer || !el) return;
  container = el;
  el.appendChild(renderer.domElement);
  onResize();
}

export function setMapVisible(visible) {
  if (renderer) renderer.domElement.style.display = visible ? 'block' : 'none';
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

// Квотернион, поворачивающий локальную ось +Y в направление нормали
// в данной точке сферы. Нужен, чтобы остров «стоял» на поверхности
// как надо, а не был приклеен плоско.
function surfaceQuaternion(position) {
  const normal = position.clone().normalize();
  return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
}

// --- Иконка острова (для далёкого LOD) -----------------------------------

const islandIconCache = new Map();

// Иконка: диск травы, кубики постройки в изометрии, флаг ПО ЦЕНТРУ
// позади построек. Флаг больше не смещён вбок — он стоит за кубиками
// по оси X, полотнище развевается вправо и видно над постройками.
function makeIslandIcon(colorHex, cubes, isMine) {
  const bucket = cubes <= 5 ? 's' : cubes <= 20 ? 'm' : 'l';
  const key = `i|${colorHex}|${bucket}|${isMine ? 'm' : ''}`;
  if (islandIconCache.has(key)) return islandIconCache.get(key);

  const W = 240, H = 200;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  if (isMine) {
    const glow = ctx.createRadialGradient(W/2, H*0.7, 10, W/2, H*0.7, W*0.55);
    glow.addColorStop(0, 'rgba(253,230,138,.55)');
    glow.addColorStop(1, 'rgba(253,230,138,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
  }

  const cx = W / 2;
  const cy = H * 0.72;

  // --- Флаг: палка идёт из-за кубиков по центру ---
  // Рисуем ДО кубиков, чтобы постройки её частично перекрыли.
  const poleX = cx + 4;
  const poleBaseY = cy + 2;
  const poleTopY = cy - 96;

  ctx.strokeStyle = '#2c2c2c';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(poleX, poleBaseY);
  ctx.lineTo(poleX, poleTopY);
  ctx.stroke();

  // --- Диск травы ---
  const discRX = 84, discRY = 26;
  ctx.beginPath();
  ctx.ellipse(cx, cy + 8, discRX, discRY, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#2d5130';
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx, cy, discRX, discRY, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#4a7a4e';
  ctx.fill();
  ctx.strokeStyle = 'rgba(20,35,20,.75)';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // --- Кубики ---
  const layouts = {
    s: [[0, 0]],
    m: [[-22, 0], [22, 8]],
    l: [[-32, 8], [4, 0], [34, 14]],
  };
  const list = layouts[bucket];
  const cubeSize = 46;
  const isIron = bucket === 'l';

  for (const [ox, oy] of list) {
    const x = cx + ox;
    const y = cy - cubeSize / 2 + oy;
    const topColor = isIron ? '#c9d2da' : '#e0b07a';
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

    ctx.strokeStyle = 'rgba(20,15,10,.7)';
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

  // --- Полотнище флага поверх построек ---
  ctx.beginPath();
  ctx.moveTo(poleX, poleTopY);
  ctx.quadraticCurveTo(poleX + 30, poleTopY - 4, poleX + 52, poleTopY + 10);
  ctx.lineTo(poleX + 52, poleTopY + 40);
  ctx.quadraticCurveTo(poleX + 28, poleTopY + 28, poleX, poleTopY + 40);
  ctx.closePath();
  ctx.fillStyle = colorHex;
  ctx.fill();
  ctx.strokeStyle = 'rgba(20,15,10,.6)';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  islandIconCache.set(key, tex);
  return tex;
}

// --- Ник: компактная плашка ----------------------------------------------

const labelTexCache = new Map();

function makeLabelTexture(username, isMine) {
  const key = `l|${username}|${isMine ? 'm' : ''}`;
  if (labelTexCache.has(key)) return labelTexCache.get(key);

  const FONT_SIZE = 26;
  const PAD_X = 14;
  const H = 38;

  const m = document.createElement('canvas').getContext('2d');
  m.font = `800 ${FONT_SIZE}px system-ui,-apple-system,sans-serif`;
  const tw = Math.ceil(m.measureText(username).width);
  const W = tw + PAD_X * 2;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const r = H / 2;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(W, 0, W, H, r);
  ctx.arcTo(W, H, 0, H, r);
  ctx.arcTo(0, H, 0, 0, r);
  ctx.arcTo(0, 0, W, 0, r);
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
  ctx.fillText(username, W / 2, H / 2 + 1);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  labelTexCache.set(key, tex);
  return tex;
}

// --- 3D-модель острова из кубиков игрока --------------------------------

function buildIslandMesh(cubes) {
  const geoms = [];

  for (const c of cubes) {
    const sx = (c.size_x || 1) * CUBE_SCALE;
    const sy = (c.size_y || 1) * CUBE_SCALE;
    const sz = (c.size_z || 1) * CUBE_SCALE;

    const g = new THREE.BoxGeometry(sx, sy, sz);
    const col = new THREE.Color(BLOCK_COLORS_HEX[c.color] || 0xc9a06a);

    // Закрашиваем vertex colors — так один material может рисовать
    // кубы разных цветов без переключения.
    const count = g.attributes.position.count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      colors[i * 3]     = col.r;
      colors[i * 3 + 1] = col.g;
      colors[i * 3 + 2] = col.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    // Позиция: центр куба в локальных координатах острова. Ось Y — вверх,
    // X/Z — стороны. Игровые координаты 0..64 при CUBE_SCALE=0.5 дают
    // 0..32 — остров шириной 32 единицы.
    const px = (c.x + (c.size_x || 1) / 2) * CUBE_SCALE;
    const py = (c.y + (c.size_y || 1) / 2) * CUBE_SCALE;
    const pz = (c.z + (c.size_z || 1) / 2) * CUBE_SCALE;
    g.translate(px, py, pz);

    geoms.push(g);
  }

  // Диск травы под кубами.
  const discGeo = new THREE.CylinderGeometry(17, 17, 0.8, 32);
  const discCol = new THREE.Color(0x3d6a3f);
  const dCount = discGeo.attributes.position.count;
  const dColors = new Float32Array(dCount * 3);
  for (let i = 0; i < dCount; i++) {
    dColors[i * 3]     = discCol.r;
    dColors[i * 3 + 1] = discCol.g;
    dColors[i * 3 + 2] = discCol.b;
  }
  discGeo.setAttribute('color', new THREE.BufferAttribute(dColors, 3));
  discGeo.translate(0, -0.4, 0);
  geoms.push(discGeo);

  if (geoms.length === 0) return null;

  // mergeGeometries: объединяет все кубы в одну геометрию. Один draw call.
  // Если merge не сработал (несовместимые атрибуты) — вернём null,
  // клиент откатится на иконку.
  let merged;
  try {
    merged = mergeGeometries(geoms, false);
  } catch (e) {
    console.warn('map3d: mergeGeometries failed', e);
    return null;
  }
  if (!merged) return null;

  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(merged, mat);
  return mesh;
}

// --- Маркеры --------------------------------------------------------------

export function setMapPoints(points) {
  if (!markersGroup) return;
  rawPoints = points || [];

  const seen = new Set();

  for (const p of rawPoints) {
    const uid = String(p.user_id);
    seen.add(uid);

    const isMine = myUserId && uid === String(myUserId);
    const hex = FLAG_COLORS_HEX[p.flag_color] ?? 0xef4444;
    const css = '#' + hex.toString(16).padStart(6, '0');

    let entry = markers.get(uid);

    if (!entry) {
      const iconTex = makeIslandIcon(css, p.cube_count || 0, isMine);
      const icon = new THREE.Sprite(new THREE.SpriteMaterial({
        map: iconTex, transparent: true, depthWrite: false, depthTest: false,
      }));

      const labelTex = makeLabelTexture(p.username, isMine);
      const label = new THREE.Sprite(new THREE.SpriteMaterial({
        map: labelTex, transparent: true, depthWrite: false, depthTest: false,
      }));

      const { lat, lon } = worldToLatLon(p.world_x, p.world_y);
      const basePos = latLonToVec3(lat, lon, SPHERE_RADIUS * 1.005);

      const q = surfaceQuaternion(basePos);

      icon.position.copy(basePos);
      // Ник — на 10 единиц выше вдоль нормали.
      const up = new THREE.Vector3(0, 10, 0).applyQuaternion(q);
      label.position.copy(basePos).add(up);

      // Группа для 3D-модели. Пустая, пока не загрузим кубы.
      const group = new THREE.Group();
      group.position.copy(basePos);
      group.quaternion.copy(q);
      group.visible = false;

      markersGroup.add(icon);
      markersGroup.add(label);
      markersGroup.add(group);

      entry = {
        uid, icon, label, group,
        data: p, isMine, basePos,
        iconAspect: iconTex.image.width / iconTex.image.height,
        labelAspect: labelTex.image.width / labelTex.image.height,
        cubes: null, cubesFetched: false,
      };
      markers.set(uid, entry);
    } else {
      const { lat, lon } = worldToLatLon(p.world_x, p.world_y);
      const newPos = latLonToVec3(lat, lon, SPHERE_RADIUS * 1.005);
      if (!entry.basePos.equals(newPos)) {
        entry.basePos.copy(newPos);
        entry.icon.position.copy(newPos);
        const q = surfaceQuaternion(newPos);
        const up = new THREE.Vector3(0, 10, 0).applyQuaternion(q);
        entry.label.position.copy(newPos).add(up);
        entry.group.position.copy(newPos);
        entry.group.quaternion.copy(q);
      }
      entry.data = p;
    }
  }

  // Убираем исчезнувших.
  for (const [uid, entry] of markers) {
    if (!seen.has(uid)) {
      markersGroup.remove(entry.icon);
      markersGroup.remove(entry.label);
      markersGroup.remove(entry.group);
      entry.icon.material.dispose();
      entry.label.material.dispose();
      if (entry.group.children[0]) {
        entry.group.children[0].geometry.dispose();
        entry.group.children[0].material.dispose();
      }
      markers.delete(uid);
    }
  }

  updateMarkerLOD();
}

// Принимает данные от бэкенда, строит 3D-модели. Вызывается из
// index.html когда /islands/map/cubes вернул результат.
export function setMapCubes(userId, cubes) {
  const entry = markers.get(String(userId));
  if (!entry) return;

  // Убираем старую модель, если была (на случай обновления).
  if (entry.cubes) {
    const oldMesh = entry.group.children[0];
    if (oldMesh) {
      entry.group.remove(oldMesh);
      oldMesh.geometry.dispose();
      oldMesh.material.dispose();
    }
  }

  const mesh = buildIslandMesh(cubes || []);
  if (mesh) {
    entry.group.add(mesh);
    entry.cubes = cubes;
  } else {
    entry.cubes = [];
  }
  entry.cubesFetched = true;
}

// LOD-решение: иконка или 3D. Иконка дешевле, 3D точнее.
function updateMarkerLOD() {
  const h = renderer.domElement.clientHeight;
  const vFov = (camera.fov * Math.PI) / 180;
  const k = (2 * Math.tan(vFov / 2)) / h;

  const camPos = camera.position;
  const camDist = camPos.length();

  for (const entry of markers.values()) {
    const dist = camPos.distanceTo(entry.basePos);
    const ratio = dist / SPHERE_RADIUS;

    const isClose = ratio < CLOSE_DIST;
    const showLabel = ratio < LABEL_DIST;

    // Иконка — всегда видна, но не пересекается с моделью.
    entry.icon.visible = !isClose;
    entry.label.visible = showLabel;

    // 3D-модель: видима только когда загружена и камера близко.
    entry.group.visible = isClose && !!entry.cubes;

    // Запрашиваем кубы, если близко и ещё нет.
    if (isClose && !entry.cubesFetched) {
      queueCubeFetch(entry.uid);
    }

    // Размеры иконки и подписи — фиксированные на экране.
    if (!isClose) {
      const iconPx = 120;
      const s = k * dist * iconPx;
      entry.icon.scale.set(s * entry.iconAspect, s, 1);
    }

    if (showLabel) {
      const labelPx = 20;
      const ls = k * dist * labelPx;
      entry.label.scale.set(ls * entry.labelAspect, ls, 1);
    }
  }
}

// Очередь на загрузку кубов. Батчим несколько игроков в один запрос,
// чтобы при движении камеры не летело 50 HTTP-запросов в секунду.
function queueCubeFetch(userId) {
  if (!onNeedCubes) return;
  if (pendingCubeIds.has(userId)) return;
  pendingCubeIds.add(userId);

  if (cubeFetchTimer) return;
  cubeFetchTimer = setTimeout(() => {
    const ids = [...pendingCubeIds];
    pendingCubeIds.clear();
    cubeFetchTimer = null;
    if (ids.length > 0) {
      try { onNeedCubes(ids); } catch (e) { console.warn('onNeedCubes failed', e); }
    }
  }, 150);
}

// --- Цикл ----------------------------------------------------------------

function animate() {
  if (disposed) return;
  animationId = requestAnimationFrame(animate);
  if (!running) return;

  controls.update();
  updateMarkerLOD();
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
    _projVec.copy(entry.basePos).project(camera);
    if (_projVec.z > 1) continue;
    const sx = (_projVec.x * 0.5 + 0.5) * rect.width;
    const sy = (-_projVec.y * 0.5 + 0.5) * rect.height;
    const screenDist = Math.hypot(sx - tapX, sy - tapY);
    if (screenDist > HIT_RADIUS_PX) continue;
    candidates.push({ uid, entry, screenDist, camDist: camPos.distanceTo(entry.basePos) });
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
  const entry = markers.get(String(userId));
  let target = null;
  if (entry) target = entry.basePos.clone();
  if (!target) return;

  const dir = target.clone().normalize();
  const currentDist = camera.position.length();
  const finalDist = Math.max(
    controls.minDistance,
    Math.min(controls.maxDistance, (SPHERE_RADIUS * 1.6) / zoom)
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
  let newDist = Math.max(
    controls.minDistance,
    Math.min(controls.maxDistance, currentDist / factor)
  );
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

// Заглушка для совместимости — облака убраны.
export function setCloudsVisible(_v) {}
export function setCloudOpacity(_v) {}

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
  markersGroup = null;
      }
