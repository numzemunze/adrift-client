// Карта мира: 3D-глобус с настоящим дневным/ночным циклом.
//
// СИСТЕМА КООРДИНАТ
// -----------------
// world_x, world_y с сервера ∈ [-2000, 2000]. (0, 0) = Берлин, 10°E 50°N.
// 1 единица = 0.01°. Полный мир — 40°×40° вокруг Германии.
//
// ОСВЕЩЕНИЕ
// ---------
// Солнце движется по реальному UTC: в 12:00 UTC подсолнечная точка на
// долготе 0°, в 15:00 — на 45°W, в 9:00 — на 45°E. Широта подсолнечной
// точки фиксирована 0 (упрощение — на самом деле она гуляет ±23.5° по
// сезону, но для визуала это неважно).
//
// Shader смешивает две текстуры: дневную (earth-blue-marble — яркие
// континенты) и ночную (earth-night — огни городов). Коэффициент смеси
// зависит от скалярного произведения нормали к поверхности и направления
// на солнце. Полоса терминатора размыта smoothstep'ом, иначе был бы
// резкий переход — некрасиво.
//
// ТЕКСТУРЫ
// --------
// Загружаются с jsdelivr (три-globe). Если хочешь офлайн — положи файлы
// в assets/ и замени URL в EARTH_TEXTURE_SOURCES_DAY/NIGHT.
// Первая успешная загрузка фиксируется, остальные источники не пробуются.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FLAG_COLORS_HEX } from './config.js';

const WORLD_TO_DEG = 0.01;
const WORLD_CENTER_LON = 10;    // 10°E
const WORLD_CENTER_LAT = 50;    // 50°N

const SPHERE_RADIUS = 100;

// Дневная текстура: синие океаны, зелёные континенты, без облаков.
// Blue marble — самая насыщенная из доступных на jsdelivr.
const EARTH_TEXTURE_SOURCES_DAY = [
  'https://cdn.jsdelivr.net/npm/three-globe@2/example/img/earth-blue-marble.jpg',
  'https://cdn.jsdelivr.net/npm/three-globe@2/example/img/earth-day.jpg',
  'https://unpkg.com/three@0.160.0/examples/textures/planets/earth_atmos_2048.jpg',
];

// Ночная текстура: чёрные континенты, жёлтые огни городов.
const EARTH_TEXTURE_SOURCES_NIGHT = [
  'https://cdn.jsdelivr.net/npm/three-globe@2/example/img/earth-night.jpg',
];

let scene = null;
let camera = null;
let renderer = null;
let controls = null;
let sphereMesh = null;
let markersGroup = null;
let raycaster = null;
let pointerNdc = null;

let container = null;
let onTapCallback = null;
let disposed = false;
let running = false;
let animationId = 0;

// user_id -> { sprite, data }
const markers = new Map();
let myUserId = null;

// Uniform'ы шейдера, чтобы обновлять sunDirection без пересоздания материала.
let uniforms = null;

// --- Инициализация --------------------------------------------------------

export function initMap3D(containerEl, { onPointTap, myUserId: myId } = {}) {
  if (scene) return;
  container = containerEl;
  onTapCallback = onPointTap;
  myUserId = myId;

  const w = container.clientWidth || window.innerWidth;
  const h = container.clientHeight || window.innerHeight;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x03050d);

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
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.5;
  controls.zoomSpeed = 0.7;
  controls.minDistance = SPHERE_RADIUS * 1.05;
  controls.maxDistance = SPHERE_RADIUS * 6;
  controls.enablePan = false;
  controls.target.set(0, 0, 0);

  // Шар с кастомным шейдером день/ночь.
  const geo = new THREE.SphereGeometry(SPHERE_RADIUS, 128, 64);

  uniforms = {
    dayTexture:   { value: null },
    nightTexture: { value: null },
    sunDirection: { value: new THREE.Vector3(1, 0, 0) },
    // Минимальная яркость тёмной стороны: 0 = чистый чёрный, 1 = нет тени.
    // 0.08 даёт слегка видимые континенты в ночи — красиво и читаемо.
    nightFloor:   { value: 0.08 },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      varying vec3 vNormal;
      varying vec2 vUv;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D dayTexture;
      uniform sampler2D nightTexture;
      uniform vec3 sunDirection;
      uniform float nightFloor;
      varying vec3 vNormal;
      varying vec2 vUv;

      void main() {
        // cos угла между нормалью и солнцем. 1 = прямо под солнцем,
        // 0 = терминатор, -1 = глубокая ночь.
        float cosAngle = dot(normalize(vNormal), normalize(sunDirection));

        // Плавный переход через терминатор. smoothstep(-0.15, 0.25) —
        // полоса шириной ~25° на карте, это соответствует реальной
        // суточной полосе рассвета/заката.
        float dayAmount = smoothstep(-0.15, 0.25, cosAngle);

        vec3 dayColor = texture2D(dayTexture, vUv).rgb;
        vec3 nightColor = texture2D(nightTexture, vUv).rgb;

        // На тёмной стороне ночная текстура почти чёрная, но её видно
        // благодаря nightFloor — добавляем минимальный уровень.
        vec3 nightLit = max(nightColor, vec3(nightFloor));

        vec3 color = mix(nightLit, dayColor, dayAmount);

        // Атмосферное свечение по краю диска: чем ближе нормаль к
        // перпендикуляру к лучу зрения, тем ярче голубой ореол.
        // Расчёт: viewDir — от точки к камере, halo сильнее на лимбе.
        vec3 viewDir = normalize(cameraPosition - vNormal * 100.0);
        float limb = 1.0 - abs(dot(normalize(vNormal), viewDir));
        float atmosphere = pow(limb, 3.0) * 0.35 * dayAmount;
        color += vec3(0.3, 0.55, 1.0) * atmosphere;

        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });

  sphereMesh = new THREE.Mesh(geo, mat);
  scene.add(sphereMesh);

  loadTextures();

  markersGroup = new THREE.Group();
  scene.add(markersGroup);

  raycaster = new THREE.Raycaster();
  pointerNdc = new THREE.Vector2();

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  window.addEventListener('resize', onResize);

  updateSunDirection();

  running = true;
  animate();
}

function loadTextures() {
  loadOne(EARTH_TEXTURE_SOURCES_DAY, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    uniforms.dayTexture.value = tex;
  });

  loadOne(EARTH_TEXTURE_SOURCES_NIGHT, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    uniforms.nightTexture.value = tex;
  });
}

function loadOne(sources, onLoad) {
  let idx = 0;
  const tryNext = () => {
    if (idx >= sources.length) {
      // Ни одна текстура не загрузилась. Оставляем uniforms пустыми:
      // шейдер вернёт чёрный шар. Это лучше, чем упасть.
      return;
    }
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    loader.load(sources[idx], onLoad, undefined, () => { idx++; tryNext(); });
  };
  tryNext();
}

// --- Положение солнца -----------------------------------------------------

// Направление солнца в координатах сцены.
//
// Подсолнечная точка: 12:00 UTC — долгота 0°, каждые 24 часа проходит
// 360°, то есть по 15° за час. В 15:00 — на 45°W, в 9:00 — на 45°E.
//
// Широта упрощена до 0° (экватор). Реальная гуляет ±23.5° по сезону,
// но визуально это не критично, а честная формула требует equation of
// time и наклона земной оси — overkill для карты игры.
function updateSunDirection() {
  if (!uniforms) return;
  const now = new Date();
  const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60;
  const sunLon = (12 - utcHours) * 15;

  const pos = latLonToVec3(0, sunLon, SPHERE_RADIUS * 10);
  uniforms.sunDirection.value.copy(pos).normalize();
}

// --- Позиционирование -----------------------------------------------------

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

// --- Маркеры --------------------------------------------------------------

const markerTextureCache = new Map();

function makeMarkerTexture(colorHex, isMine) {
  const key = colorHex + (isMine ? '_mine' : '');
  if (markerTextureCache.has(key)) return markerTextureCache.get(key);

  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2;
  const cy = size / 2;

  if (isMine) {
    const glow = ctx.createRadialGradient(cx, cy, size * 0.2, cx, cy, size * 0.5);
    glow.addColorStop(0, 'rgba(253,230,138,.6)');
    glow.addColorStop(1, 'rgba(253,230,138,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size, size);
  }

  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.32, 0, Math.PI * 2);
  ctx.fillStyle = colorHex;
  ctx.fill();

  ctx.lineWidth = size * 0.06;
  ctx.strokeStyle = isMine ? '#fde68a' : 'rgba(255,255,255,.9)';
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx - size * 0.08, cy - size * 0.1, size * 0.12, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,.4)';
  ctx.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  markerTextureCache.set(key, tex);
  return tex;
}

export function setMapPoints(points) {
  if (!markersGroup) return;

  const seen = new Set();

  for (const p of points) {
    seen.add(String(p.user_id));

    const isMine = myUserId && String(p.user_id) === String(myUserId);
    const colorHex = FLAG_COLORS_HEX[p.flag_color] ?? 0xef4444;
    const cssColor = '#' + colorHex.toString(16).padStart(6, '0');

    let entry = markers.get(String(p.user_id));

    if (!entry) {
      const tex = makeMarkerTexture(cssColor, isMine);
      const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        depthTest: true,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.userData.user_id = p.user_id;
      sprite.userData.username = p.username;

      const { lat, lon } = worldToLatLon(p.world_x, p.world_y);
      sprite.position.copy(latLonToVec3(lat, lon, SPHERE_RADIUS * 1.015));

      markersGroup.add(sprite);
      entry = { sprite, data: p, isMine };
      markers.set(String(p.user_id), entry);
    } else {
      const { lat, lon } = worldToLatLon(p.world_x, p.world_y);
      const newPos = latLonToVec3(lat, lon, SPHERE_RADIUS * 1.015);
      if (!entry.sprite.position.equals(newPos)) {
        entry.sprite.position.copy(newPos);
      }
      entry.data = p;
    }

    entry.sprite.visible = true;
  }

  for (const [id, entry] of markers) {
    if (!seen.has(id)) {
      markersGroup.remove(entry.sprite);
      entry.sprite.material.dispose();
      markers.delete(id);
    }
  }
}

function updateMarkerScales() {
  const h = renderer.domElement.clientHeight;
  const vFov = (camera.fov * Math.PI) / 180;
  const k = (2 * Math.tan(vFov / 2)) / h;

  for (const { sprite, isMine } of markers.values()) {
    const distance = camera.position.distanceTo(sprite.position);
    const desiredPx = isMine ? 24 : 18;
    const scale = k * distance * desiredPx;
    sprite.scale.set(scale, scale, 1);
  }
}

// --- Цикл рендера ---------------------------------------------------------

let lastSunUpdate = 0;

function animate() {
  if (disposed) return;
  animationId = requestAnimationFrame(animate);
  if (!running) return;

  // Обновляем солнце раз в минуту — оно всё равно не быстрое.
  const t = performance.now();
  if (t - lastSunUpdate > 60000) {
    updateSunDirection();
    lastSunUpdate = t;
  }

  controls.update();
  updateMarkerScales();
  renderer.render(scene, camera);
}

// --- Тап по маркеру -------------------------------------------------------

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
  pointerNdc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointerNdc, camera);

  const sprites = [...markers.values()].map(e => e.sprite);
  const hits = raycaster.intersectObjects(sprites, false);
  if (hits.length === 0) return;

  const hit = hits[0].object;
  const uid = hit.userData.user_id;
  const uname = hit.userData.username;

  if (myUserId && String(uid) === String(myUserId)) return;

  onTapCallback(uid, uname);
}

// --- Публичное API --------------------------------------------------------

export function setMapCameraToMe() {
  if (!camera || !controls) return;
  const mine = markers.get(String(myUserId));
  if (!mine) return;

  const dir = mine.sprite.position.clone().normalize();
  const distance = SPHERE_RADIUS * 1.6;
  const targetPos = dir.multiplyScalar(distance);

  const startPos = camera.position.clone();
  const startT = performance.now();
  const dur = 600;

  const step = () => {
    if (disposed) return;
    const k = Math.min(1, (performance.now() - startT) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    camera.position.lerpVectors(startPos, targetPos, e);
    camera.lookAt(0, 0, 0);
    if (k < 1) requestAnimationFrame(step);
  };
  step();
}

export function zoomMapBy(factor) {
  if (!camera || !controls) return;
  const dir = camera.position.clone().normalize();
  const currentDist = camera.position.length();
  let newDist = currentDist / factor;
  newDist = Math.max(controls.minDistance, Math.min(controls.maxDistance, newDist));
  camera.position.copy(dir.multiplyScalar(newDist));
  camera.lookAt(0, 0, 0);
}

export function resizeMap3D() {
  onResize();
}

export function setMapRunning(on) {
  running = on;
  if (on && camera && controls) {
    onResize();
    updateSunDirection();   // на случай, если игрок вернулся через час
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
  scene = null;
  camera = null;
  renderer = null;
  controls = null;
  sphereMesh = null;
  markersGroup = null;
  uniforms = null;
}
