// Карта мира: 3D-глобус с мини-островами игроков.
//
// МИНИ-ОСТРОВА
// ------------
// Вместо спрайтов-точек каждый игрок — маленькая 3D-сцена на поверхности
// сферы: диск травы, 1-3 куба-строения, мини-флаг. Все острова разделяют
// общие геометрии и материалы (создаются один раз), отличается только
// цвет и высота застройки.
//
// LOD по расстоянию до камеры:
//   FAR    (> 4R)  — остров не рисуется (мельче пикселя, экономия)
//   MID    (2.5-4R) — билборд: canvas-текстура с изометрией острова
//   CLOSE  (< 2.5R) — полная 3D-модель: диск + кубы + флаг
//
// ОБЛАКА
// ------
// Отдельная сфера из инстансированных квадов чуть выше поверхности
// планеты. Медленно вращаются. Прозрачность зависит от расстояния
// камеры: подлетаешь — облака тают, отдаляешься — сгущаются.
//
// ПУБЛИЧНОЕ API
// -------------
//   initMap3D(container, { onPointTap, myUserId })
//   setMapPoints(points)
//   flyToPlayer(userId, zoom)
//   setMapCameraToMe()
//   zoomMapBy(factor)
//   setMapRunning(bool)
//   resizeMap3D()
//   disposeMap3D()
//
// Плюс специально для меню:
//   setMapCameraDistance(r)  — мгновенно поставить камеру на радиус r
//   tweenMapCamera(from, to, ms) → Promise  — плавный подлёт

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FLAG_COLORS_HEX, BLOCK_COLORS_HEX } from './config.js';

const WORLD_TO_DEG = 0.01;
const WORLD_CENTER_LON = 10;
const WORLD_CENTER_LAT = 50;

const SPHERE_RADIUS = 100;

const EARTH_TEXTURE_SOURCES = [
  'https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg',
  'https://unpkg.com/three-globe/example/img/earth-day.jpg',
  'https://unpkg.com/three@0.160.0/examples/textures/planets/earth_atmos_2048.jpg',
  'https://cdn.jsdelivr.net/npm/three-globe@2/example/img/earth-blue-marble.jpg',
];

const HIT_RADIUS_PX = 55;

const LOD_FAR = 4.0;
const LOD_MID = 2.5;

// Облака: радиус, количество и размер.
const CLOUD_RADIUS = SPHERE_RADIUS * 1.10;
const CLOUD_COUNT = 60;
const CLOUD_QUAD_SIZE = 40;

let scene = null;
let camera = null;
let renderer = null;
let controls = null;
let sphereMesh = null;
let markersGroup = null;
let cloudsGroup = null;

let container = null;
let onTapCallback = null;
let disposed = false;
let running = false;
let animationId = 0;

const markers = new Map();  // user_id -> { group, billboard, data, level }
let rawPoints = [];
let myUserId = null;

const _projVec = new THREE.Vector3();

// Общие геометрии и материалы для всех мини-островов. Создаются лениво —
// при первом острове. Позволяет не плодить объекты на 100+ игроков.
let GEO_DISC = null;
let GEO_BOX = null;
let GEO_POLE = null;
let MAT_GRASS = null;
let MAT_BUILDING_WOOD = null;
let MAT_BUILDING_IRON = null;

// Текстура облака: генерируется один раз, переиспользуется инстансами.
let CLOUD_TEXTURE = null;

// --- Инициализация --------------------------------------------------------

export function initMap3D(containerEl, { onPointTap, myUserId: myId } = {}) {
  if (scene) return;
  container = containerEl;
  onTapCallback = onPointTap;
  myUserId = myId;

  const w = container.clientWidth || window.innerWidth;
  const h = container.clientHeight || window.innerHeight;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a1430);

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
  renderer.domElement.style.filter = 'saturate(1.35) contrast(1.08)';
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.15;
  controls.rotateSpeed = 0.35;
  controls.zoomSpeed = 0.55;
  controls.minDistance = SPHERE_RADIUS * 1.15;
  controls.maxDistance = SPHERE_RADIUS * 6;
  controls.enablePan = false;
  controls.target.set(0, 0, 0);

  const geo = new THREE.SphereGeometry(SPHERE_RADIUS, 96, 48);
  const mat = new THREE.MeshBasicMaterial({ color: 0x3a5f8a, toneMapped: false });
  sphereMesh = new THREE.Mesh(geo, mat);
  scene.add(sphereMesh);

  loadEarthTexture(mat);

  buildCloudLayer();

  markersGroup = new THREE.Group();
  scene.add(markersGroup);

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  window.addEventListener('resize', onResize);

  running = true;
  animate();
}

// --- Общие ресурсы для мини-островов --------------------------------------

function ensureIslandResources() {
  if (GEO_DISC) return;

  GEO_DISC = new THREE.CylinderGeometry(6, 6, 0.6, 20);
  GEO_BOX = new THREE.BoxGeometry(2.4, 3.0, 2.4);
  GEO_POLE = new THREE.CylinderGeometry(0.22, 0.22, 5.5, 6);

  MAT_GRASS = new THREE.MeshLambertMaterial({ color: 0x3d6a3f });
  MAT_BUILDING_WOOD = new THREE.MeshLambertMaterial({ color: 0xb8834a });
  MAT_BUILDING_IRON = new THREE.MeshLambertMaterial({ color: 0x8e99a3 });
}

// --- Облака --------------------------------------------------------------

function makeCloudTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  // Мягкое пятно: несколько перекрывающихся кругов с радиальным градиентом.
  // Центр плотный, края — прозрачность в ноль.
  const blobs = [
    { x: 64, y: 64, r: 40 },
    { x: 44, y: 70, r: 30 },
    { x: 86, y: 68, r: 32 },
    { x: 62, y: 48, r: 26 },
    { x: 62, y: 82, r: 24 },
  ];
  for (const b of blobs) {
    const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function buildCloudLayer() {
  CLOUD_TEXTURE = makeCloudTexture();

  cloudsGroup = new THREE.Group();
  scene.add(cloudsGroup);

  // Каждое облако — плоский квад, повёрнутый «лицом наружу» от центра сферы.
  // Позиционируем случайно на полусфере сверху, распределение через
  // сферические координаты. Размер рандомный — от 0.7 до 1.4 от базового.
  for (let i = 0; i < CLOUD_COUNT; i++) {
    // Равномерно по сфере (алгоритм Archimedes).
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);

    const x = CLOUD_RADIUS * Math.sin(phi) * Math.cos(theta);
    const y = CLOUD_RADIUS * Math.cos(phi);
    const z = CLOUD_RADIUS * Math.sin(phi) * Math.sin(theta);

    const mat = new THREE.SpriteMaterial({
      map: CLOUD_TEXTURE,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
    });
    const sprite = new THREE.Sprite(mat);
    const size = CLOUD_QUAD_SIZE * (0.7 + Math.random() * 0.8);
    sprite.scale.set(size * 1.6, size, 1);
    sprite.position.set(x, y, z);
    sprite.userData.angle = theta;
    sprite.userData.phi = phi;
    cloudsGroup.add(sprite);
  }
}

// Облака вращаются: медленно облетают планету вокруг оси Y.
function updateClouds(dt) {
  if (!cloudsGroup) return;

  // Вращение всей группы вокруг оси Y — 0.02 рад/сек, полный оборот
  // за ~5 минут. Облака сдвигаются друг относительно друга медленно,
  // как настоящие.
  cloudsGroup.rotation.y += dt * 0.02;

  // Прозрачность зависит от расстояния камеры.
  // camDist < 1.6R — облака не мешают, opacity 0.
  // camDist > 2.4R — облака плотные, opacity 0.6.
  const camDist = camera.position.length();
  const t = Math.max(0, Math.min(1, (camDist - SPHERE_RADIUS * 1.6) / (SPHERE_RADIUS * 0.8)));
  const target = t * 0.6;

  for (const sprite of cloudsGroup.children) {
    // Каждое облако индивидуально плавно тянется к целевому значению —
    // при движении камеры облака «тают» почти одновременно.
    sprite.material.opacity += (target - sprite.material.opacity) * Math.min(1, dt * 2.5);
  }
}

// Публичный API: мгновенно выставить прозрачность (для меню).
export function setCloudOpacity(value) {
  if (!cloudsGroup) return;
  const v = Math.max(0, Math.min(1, value));
  for (const sprite of cloudsGroup.children) {
    sprite.material.opacity = v * 0.85;
  }
  // Отключаем автоматическую логику на время меню.
  cloudsGroup.userData.forced = v;
}

export function releaseCloudOpacity() {
  if (cloudsGroup) cloudsGroup.userData.forced = null;
}

// --- Текстура Земли -------------------------------------------------------

function loadEarthTexture(material) {
  let idx = 0;
  const tryNext = () => {
    if (idx >= EARTH_TEXTURE_SOURCES.length) return;
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
      () => { idx++; tryNext(); },
    );
  };
  tryNext();
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

// Ориентация острова: локальная ось Y должна смотреть наружу от центра.
// Через квотернион из (0,1,0) в нормаль поверхности.
function orientTowardSphereCenter(obj, position) {
  const normal = position.clone().normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(up, normal);
  obj.quaternion.copy(q);
}

// --- Билборд-текстура для среднего LOD ------------------------------------

const islandTexCache = new Map();

function makeIslandBillboard(colorHex, cubes) {
  const key = `b|${colorHex}|${cubes}`;
  if (islandTexCache.has(key)) return islandTexCache.get(key);

  const W = 200, H = 140;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Диск травы внизу.
  const cx = W / 2, cy = H * 0.75;
  ctx.beginPath();
  ctx.ellipse(cx, cy, 62, 22, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#3d6a3f';
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.4)';
  ctx.lineWidth = 3;
  ctx.stroke();

  // Пара кубиков сверху.
  const cubeCount = Math.min(3, Math.max(1, Math.ceil(cubes / 8)));
  for (let i = 0; i < cubeCount; i++) {
    const ox = (i - (cubeCount - 1) / 2) * 36;
    const oy = -i * 4;
    const size = 30;
    // Изометрия: три грани.
    ctx.fillStyle = '#b8834a';
    ctx.beginPath();
    ctx.moveTo(cx + ox, cy - size + oy);
    ctx.lineTo(cx + ox + size * 0.7, cy - size + oy + size * 0.4);
    ctx.lineTo(cx + ox, cy - size + oy + size * 0.8);
    ctx.lineTo(cx + ox - size * 0.7, cy - size + oy + size * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#8f6338';
    ctx.beginPath();
    ctx.moveTo(cx + ox - size * 0.7, cy - size + oy + size * 0.4);
    ctx.lineTo(cx + ox, cy - size + oy + size * 0.8);
    ctx.lineTo(cx + ox, cy + oy + size * 0.8);
    ctx.lineTo(cx + ox - size * 0.7, cy + oy + size * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#d6a062';
    ctx.beginPath();
    ctx.moveTo(cx + ox + size * 0.7, cy - size + oy + size * 0.4);
    ctx.lineTo(cx + ox, cy - size + oy + size * 0.8);
    ctx.lineTo(cx + ox, cy + oy + size * 0.8);
    ctx.lineTo(cx + ox + size * 0.7, cy + oy + size * 0.4);
    ctx.closePath();
    ctx.fill();
  }

  // Флажок: тонкая палка и цветной квадратик.
  const fx = cx + 42;
  ctx.strokeStyle = '#3a3a3a';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(fx, cy - 10);
  ctx.lineTo(fx, cy - 70);
  ctx.stroke();

  ctx.fillStyle = colorHex;
  ctx.beginPath();
  ctx.moveTo(fx, cy - 70);
  ctx.lineTo(fx + 24, cy - 64);
  ctx.lineTo(fx, cy - 54);
  ctx.closePath();
  ctx.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  islandTexCache.set(key, tex);
  return tex;
}

// --- Мини-остров: 3D модель ----------------------------------------------

function buildIsland3D(colorHex, cubes) {
  ensureIslandResources();

  const group = new THREE.Group();

  // Диск травы.
  const disc = new THREE.Mesh(GEO_DISC, MAT_GRASS);
  disc.position.y = 0;
  group.add(disc);

  // Кубы сверху: 1..3 в зависимости от размера острова.
  const cubeCount = Math.min(3, Math.max(1, Math.ceil(cubes / 8)));
  const mat = cubes > 20 ? MAT_BUILDING_IRON : MAT_BUILDING_WOOD;
  for (let i = 0; i < cubeCount; i++) {
    const cube = new THREE.Mesh(GEO_BOX, mat);
    const angle = (i / cubeCount) * Math.PI * 2 + 0.3;
    const r = cubeCount === 1 ? 0 : 1.8;
    cube.position.set(Math.cos(angle) * r, 2.0, Math.sin(angle) * r);
    cube.rotation.y = angle;
    group.add(cube);
  }

  // Флаг: палка + цветной квадратик.
  const pole = new THREE.Mesh(GEO_POLE, MAT_BUILDING_IRON);
  pole.position.set(3.5, 2.75, 0);
  group.add(pole);

  const flagMat = new THREE.MeshBasicMaterial({ color: colorHex, side: THREE.DoubleSide });
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.4), flagMat);
  flag.position.set(4.6, 4.7, 0);
  group.add(flag);

  return group;
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
      // Позиция и ориентация.
      const { lat, lon } = worldToLatLon(p.world_x, p.world_y);
      const pos = latLonToVec3(lat, lon, SPHERE_RADIUS * 1.005);

      // 3D-модель: создаётся лениво. Для одиночных островов это дёшево —
      // общие геометрии шарятся через ensureIslandResources.
      const islandGroup = buildIsland3D(hex, p.cube_count || 0);
      islandGroup.position.copy(pos);
      orientTowardSphereCenter(islandGroup, pos);

      // Подпись с ником — всегда висит над островом, спрайт-билборд.
      const labelTex = makeLabelTexture(p.username, isMine);
      const labelSprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: labelTex,
        transparent: true,
        depthWrite: false,
        depthTest: false,
      }));

      // Билборд для среднего LOD — скрыт по умолчанию, включается в
      // updateMarkerLevels. Здесь только создаём.
      const billboardTex = makeIslandBillboard(css, p.cube_count || 0);
      const billboard = new THREE.Sprite(new THREE.SpriteMaterial({
        map: billboardTex,
        transparent: true,
        depthWrite: false,
        depthTest: false,
      }));

      markersGroup.add(islandGroup);
      markersGroup.add(labelSprite);
      markersGroup.add(billboard);
      billboard.visible = false;

      entry = {
        group: islandGroup,
        label: labelSprite,
        billboard,
        data: p,
        isMine,
        level: 'close',
      };
      markers.set(String(p.user_id), entry);
    } else {
      // Обновляем позицию, если игрок переехал.
      const { lat, lon } = worldToLatLon(p.world_x, p.world_y);
      const newPos = latLonToVec3(lat, lon, SPHERE_RADIUS * 1.005);
      if (!entry.group.position.equals(newPos)) {
        entry.group.position.copy(newPos);
        orientTowardSphereCenter(entry.group, newPos);
      }
      entry.data = p;
    }

    entry.group.visible = true;
    entry.label.visible = true;
  }

  // Удаляем ушедших.
  for (const [id, entry] of markers) {
    if (!seen.has(id)) {
      markersGroup.remove(entry.group);
      markersGroup.remove(entry.label);
      markersGroup.remove(entry.billboard);
      entry.group.traverse((obj) => {
        if (obj.isMesh && obj.geometry !== GEO_DISC && obj.geometry !== GEO_BOX && obj.geometry !== GEO_POLE) {
          obj.geometry.dispose();
        }
      });
      markers.delete(id);
    }
  }

  updateMarkerLevels();
}

// Ник-спрайт: canvas с текстом.
const labelTexCache = new Map();
function makeLabelTexture(username, isMine) {
  const key = `l|${username}|${isMine ? 'm' : ''}`;
  if (labelTexCache.has(key)) return labelTexCache.get(key);

  const FONT_SIZE = 44;
  const PADDING = 24;

  const measureCanvas = document.createElement('canvas');
  const mCtx = measureCanvas.getContext('2d');
  mCtx.font = `700 ${FONT_SIZE}px system-ui,-apple-system,sans-serif`;
  const textWidth = Math.ceil(mCtx.measureText(username).width);
  const W = textWidth + PADDING * 2;
  const H = 72;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.font = `700 ${FONT_SIZE}px system-ui,-apple-system,sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(0,0,0,.95)';
  ctx.strokeText(username, W / 2, H / 2);
  ctx.fillStyle = isMine ? '#fde68a' : '#ffffff';
  ctx.fillText(username, W / 2, H / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  labelTexCache.set(key, tex);
  return tex;
}

// LOD: решает, что показывать для каждого острова в зависимости от
// расстояния камеры.
function updateMarkerLevels() {
  if (!camera || !renderer) return;

  const h = renderer.domElement.clientHeight;
  const vFov = (camera.fov * Math.PI) / 180;
  const k = (2 * Math.tan(vFov / 2)) / h;

  const camDist = camera.position.length();
  const ratio = camDist / SPHERE_RADIUS;
  const camPos = camera.position;

  for (const { group, label, billboard, level } of markers.values()) {
    const objDist = camPos.distanceTo(group.position);
    const ratioLocal = objDist / SPHERE_RADIUS;

    if (ratioLocal > LOD_FAR) {
      // FAR: ничего, слишком мелко.
      group.visible = false;
      billboard.visible = false;
      label.visible = false;
    } else if (ratioLocal > LOD_MID) {
      // MID: билборд с изометрией, без ника.
      group.visible = false;
      billboard.visible = true;
      label.visible = false;

      const size = k * objDist * 90;
      billboard.scale.set(size * 1.43, size, 1);
    } else {
      // CLOSE: полная 3D-модель + ник.
      group.visible = true;
      billboard.visible = false;
      label.visible = true;

      // Размер модели масштабируется так, чтобы остров был «крупным» на
      // экране вне зависимости от зума. 260px ширина на экране при scale=1.
      const islandScale = k * objDist * 2.6;
      group.scale.setScalar(islandScale);

      // Подпись над островом, чуть выше флага.
      const labelDist = objDist * 0.98;
      const labelSize = k * labelDist * 22;
      const labelAspect = label.material.map.image.width / label.material.map.image.height;
      label.scale.set(labelSize * labelAspect, labelSize, 1);

      // Позиция подписи в мировых координатах: смещаем вдоль нормали от
      // центра сферы на несколько единиц вверх от острова. Применяем
      // ту же ориентацию, что у острова.
      const normal = group.position.clone().normalize();
      const upOffset = new THREE.Vector3(0, 10 * islandScale, 0);
      const q = group.quaternion;
      upOffset.applyQuaternion(q);
      label.position.copy(group.position).add(upOffset);
    }
  }
}

// --- Цикл рендера ---------------------------------------------------------

let lastTime = 0;

function animate() {
  if (disposed) return;
  animationId = requestAnimationFrame(animate);
  if (!running) return;

  const t = performance.now() / 1000;
  const dt = Math.min(0.1, t - lastTime);
  lastTime = t;

  controls.update();

  // Облака обновляются, если не в форсированном режиме (меню).
  if (!cloudsGroup?.userData.forced) {
    updateClouds(dt);
  }

  updateMarkerLevels();

  renderer.render(scene, camera);
}

// --- Тап по острову -------------------------------------------------------

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
  for (const [uid, { group, data }] of markers.entries()) {
    if (!group.visible) continue;

    _projVec.copy(group.position).project(camera);
    if (_projVec.z > 1) continue;

    const sx = (_projVec.x * 0.5 + 0.5) * rect.width;
    const sy = (-_projVec.y * 0.5 + 0.5) * rect.height;
    const screenDist = Math.hypot(sx - tapX, sy - tapY);
    if (screenDist > HIT_RADIUS_PX) continue;

    const camDist = camPos.distanceTo(group.position);
    candidates.push({ uid, data, screenDist, camDist });
  }

  if (!candidates.length) return;

  candidates.sort((a, b) => (a.camDist - b.camDist) || (a.screenDist - b.screenDist));
  const chosen = candidates[0];

  if (myUserId && String(chosen.uid) === String(myUserId)) return;
  onTapCallback(chosen.uid, chosen.data.username);
}

// --- Публичное API --------------------------------------------------------

export function flyToPlayer(userId, username, { zoom = 1 } = {}) {
  if (!camera || !controls) return;

  let target = null;
  const m = markers.get(String(userId));
  if (m) {
    target = m.group.position.clone();
  } else {
    for (const p of rawPoints) {
      if (String(p.user_id) === String(userId)) {
        const { lat, lon } = worldToLatLon(p.world_x, p.world_y);
        target = latLonToVec3(lat, lon, SPHERE_RADIUS * 1.005);
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

// Для меню: мгновенно поставить камеру на расстояние distance (в единицах
// радиуса сферы). Используется при показе Play-кнопки — камера отлетает
// далеко, показывая всю планету.
export function setMapCameraDistance(distance) {
  if (!camera || !controls) return;
  const dir = camera.position.clone().normalize();
  camera.position.copy(dir.multiplyScalar(distance));
  camera.lookAt(0, 0, 0);
}

// Для меню: плавный подлёт камеры от текущей позиции до радиуса to.
// Возвращает Promise, который резолвится по завершении анимации.
export function tweenMapCamera(from, to, ms) {
  return new Promise((resolve) => {
    if (!camera || !controls) return resolve();
    const dir = camera.position.clone().normalize();
    const startT = performance.now();
    const step = () => {
      if (disposed) return resolve();
      const k = Math.min(1, (performance.now() - startT) / ms);
      // ease-in-out cubic: медленно в начале и в конце, быстро в середине.
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

export function resizeMap3D() {
  onResize();
}

export function setMapRunning(on) {
  running = on;
  if (on && camera && controls) {
    onResize();
  }
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
  markersGroup = null;
  cloudsGroup = null;
      }
