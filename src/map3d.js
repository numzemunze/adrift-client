// Карта мира: настоящий 3D-глобус на Three.js.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ
// ----------------------
// У игры есть свой Three.js-сцена и рендерер (остров, камера, кубики).
// У карты — свой. Их нельзя смешивать: разные камеры, разные контролы,
// разные生命周期. Отдельный модуль держит обе сцены изолированными, а
// index.html просто вызывает init / show / hide / dispose.
//
// СИСТЕМА КООРДИНАТ
// -----------------
// world_x, world_y с сервера ∈ [-2000, 2000]. (0, 0) = Берлин,
// (50°N, 10°E). 1 единица = 0.01°. Полный мир — 40°×40° вокруг Германии.
//
// Конвертация: world → lat/lon → XYZ на сфере радиуса R.
// Формула latLonToVec3 — стандартная для сферических проекций Three.js:
// фи — полярный угол от северного полюса, тета — азимут.
//
// МАРКЕРЫ
// -------
// Спрайты (всегда лицом к камере), размер компенсируется каждый кадр,
// чтобы оставался постоянным на экране при любом зуме. Это даёт «точки
// как в Google Maps» — не исчезают при отдалении и не разрастаются при
// приближении.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FLAG_COLORS_HEX } from './config.js';

const WORLD_TO_DEG = 0.01;
const WORLD_CENTER_LON = 10;    // 10°E — Берлин
const WORLD_CENTER_LAT = 50;    // 50°N

const SPHERE_RADIUS = 100;

// Источники текстуры: от лёгкого к тяжёлому. Первый успешный идёт в дело.
const EARTH_TEXTURE_SOURCES = [
  'https://cdn.jsdelivr.net/npm/three-globe@2/example/img/earth-dark.jpg',
  'https://cdn.jsdelivr.net/npm/three-globe@2/example/img/earth-day.jpg',
  'https://unpkg.com/three@0.160.0/examples/textures/planets/earth_atmos_2048.jpg',
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

// --- Инициализация --------------------------------------------------------

export function initMap3D(containerEl, { onPointTap, myUserId: myId } = {}) {
  if (scene) return;   // уже инициализирована
  container = containerEl;
  onTapCallback = onPointTap;
  myUserId = myId;

  const w = container.clientWidth || window.innerWidth;
  const h = container.clientHeight || window.innerHeight;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050810);

  camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 10000);
  // Стартовое положение — над Берлином, с отступом в 3.5 радиуса.
  const startPos = latLonToVec3(WORLD_CENTER_LAT, WORLD_CENTER_LON, SPHERE_RADIUS * 3.2);
  camera.position.copy(startPos);
  camera.lookAt(0, 0, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.touchAction = 'none';
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.45;
  controls.zoomSpeed = 0.7;
  controls.minDistance = SPHERE_RADIUS * 1.08;   // чуть выше поверхности
  controls.maxDistance = SPHERE_RADIUS * 6;
  controls.enablePan = false;                     // крутим вокруг центра
  controls.target.set(0, 0, 0);

  // Свет: ambient, чтобы тёмная сторона не была чёрной, и направленный
  // «солнечный» — чтобы у планеты был объём и тень терминатора.
  scene.add(new THREE.AmbientLight(0xffffff, 0.45));
  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(300, 200, 300);
  scene.add(sun);

  // Сфера с текстурой.
  const geo = new THREE.SphereGeometry(SPHERE_RADIUS, 96, 48);
  const mat = new THREE.MeshPhongMaterial({
    color: 0xffffff,
    shininess: 4,
    specular: 0x1a1a1a,
  });
  sphereMesh = new THREE.Mesh(geo, mat);
  scene.add(sphereMesh);

  loadEarthTexture(mat);

  markersGroup = new THREE.Group();
  scene.add(markersGroup);

  raycaster = new THREE.Raycaster();
  pointerNdc = new THREE.Vector2();

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  window.addEventListener('resize', onResize);

  // Запускаем цикл рендера. До первого show() он будет просто крутиться
  // без дела — это дёшево (одна сцена с 2 объектами) и избавляет от
  // логики «запустить при показе, остановить при скрытии».
  running = true;
  animate();
}

function loadEarthTexture(material) {
  let idx = 0;
  const tryNext = () => {
    if (idx >= EARTH_TEXTURE_SOURCES.length) {
      // Все источники недоступны — красим сферу в однотонный тёмно-синий,
      // чтобы шар не был чёрным. Маркеры всё равно видны.
      material.color.set(0x1a2a4a);
      material.needsUpdate = true;
      return;
    }
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    loader.load(
      EARTH_TEXTURE_SOURCES[idx],
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
        material.map = tex;
        material.needsUpdate = true;
      },
      undefined,
      () => { idx++; tryNext(); },
    );
  };
  tryNext();
}

// --- Позиционирование -----------------------------------------------------

// world_x, world_y → долгота, широта.
function worldToLatLon(wx, wy) {
  return {
    lon: WORLD_CENTER_LON + wx * WORLD_TO_DEG,
    lat: WORLD_CENTER_LAT - wy * WORLD_TO_DEG,
  };
}

// Широта/долгота → точка на сфере радиуса R.
//
// Стандартная формула Three.js: сфера параметризуется так, что u=0
// соответствует долготе -180°. Текстура equirectangular начинается с
// -180° на левом краю, поэтому lon + 180 даёт корректное совмещение.
//
// Знаки: у Three.js «верх» — ось +Y, поэтому cos(phi) даёт Y (широта),
// sin(phi) — радиус в плоскости XZ.
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

// Текстура круга с обводкой. Генерируется один раз, переиспользуется всеми
// маркерами с одинаковым цветом. Кэш по hex.
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

  // Внешнее свечение (только для своего маркера).
  if (isMine) {
    const glow = ctx.createRadialGradient(cx, cy, size * 0.2, cx, cy, size * 0.5);
    glow.addColorStop(0, 'rgba(253,230,138,.55)');
    glow.addColorStop(1, 'rgba(253,230,138,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size, size);
  }

  // Основной круг.
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.32, 0, Math.PI * 2);
  ctx.fillStyle = colorHex;
  ctx.fill();

  // Обводка.
  ctx.lineWidth = size * 0.06;
  ctx.strokeStyle = isMine ? '#fde68a' : 'rgba(255,255,255,.85)';
  ctx.stroke();

  // Блик сверху — чтобы маркер выглядел «выпуклым».
  ctx.beginPath();
  ctx.arc(cx - size * 0.08, cy - size * 0.1, size * 0.12, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,.35)';
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
      // Смещение чуть выше поверхности, чтобы маркер не сливался с
      // текстурой и не мерцал от z-fighting.
      sprite.position.copy(latLonToVec3(lat, lon, SPHERE_RADIUS * 1.015));

      markersGroup.add(sprite);
      entry = { sprite, data: p, isMine };
      markers.set(String(p.user_id), entry);
    } else {
      // Обновляем данные (онлайн, размер, цвет), позицию трогаем только
      // если реально изменилась — перестроение спрайта дороже, чем
      // сравнение двух чисел.
      const { lat, lon } = worldToLatLon(p.world_x, p.world_y);
      const newPos = latLonToVec3(lat, lon, SPHERE_RADIUS * 1.015);
      if (!entry.sprite.position.equals(newPos)) {
        entry.sprite.position.copy(newPos);
      }
      entry.data = p;
    }

    entry.sprite.visible = true;
  }

  // Удаляем маркеры, которых больше нет в ответе (игрок пропал из bbox).
  for (const [id, entry] of markers) {
    if (!seen.has(id)) {
      markersGroup.remove(entry.sprite);
      entry.sprite.material.dispose();
      // Текстуру НЕ удаляем — она в кэше, пригодится снова.
      markers.delete(id);
    }
  }
}

// Подгоняет размер каждого маркера так, чтобы на экране он занимал
// фиксированное число пикселей. Без этого при отдалении маркеры схлопнутся
// в точку, при приближении — закроют экран.
//
// Формула: желаемый_px / высота_экрана * 2 * tan(fov/2) * расстояние.
// Выводится из подобия треугольников: масштаб мира, при котором объект
// займёт нужную долю экрана, пропорционален расстоянию до камеры.
function updateMarkerScales() {
  const h = renderer.domElement.clientHeight;
  const vFov = (camera.fov * Math.PI) / 180;
  const k = (2 * Math.tan(vFov / 2)) / h;

  for (const { sprite, isMine } of markers.values()) {
    const distance = camera.position.distanceTo(sprite.position);
    const desiredPx = isMine ? 22 : 16;
    const scale = k * distance * desiredPx;
    sprite.scale.set(scale, scale, 1);
  }
}

// --- Цикл рендера ---------------------------------------------------------

function animate() {
  if (disposed) return;
  animationId = requestAnimationFrame(animate);
  if (!running) return;

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

  // Отличаем тап от вращения/зума по смещению и времени.
  const dx = ev.clientX - pointerDown.x;
  const dy = ev.clientY - pointerDown.y;
  if (Math.hypot(dx, dy) > 10) return;
  if (performance.now() - pointerDown.t > 500) return;

  const rect = renderer.domElement.getBoundingClientRect();
  pointerNdc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointerNdc, camera);

  // threshold в пикселях: raycaster.params.Sprite не поддерживает
  // screen-space, поэтому проверяем расстояние в world и полагаемся на
  // то, что маркеры уже отмасштабированы под экран.
  const sprites = [...markers.values()].map(e => e.sprite);
  const hits = raycaster.intersectObjects(sprites, false);
  if (hits.length === 0) return;

  const hit = hits[0].object;
  const uid = hit.userData.user_id;
  const uname = hit.userData.username;

  // Свой маркер не открываем.
  if (myUserId && String(uid) === String(myUserId)) return;

  onTapCallback(uid, uname);
}

// --- Публичное API --------------------------------------------------------

export function setMapCameraToMe() {
  if (!camera || !controls) return;
  // Мой маркер в markers, находим по myUserId.
  const mine = markers.get(String(myUserId));
  if (!mine) return;

  const dir = mine.sprite.position.clone().normalize();
  const distance = SPHERE_RADIUS * 1.6;   // средний зум — видно регион
  const targetPos = dir.multiplyScalar(distance);

  // Плавный переход: lerp по позиции. Просто и не мешает контролам.
  const startPos = camera.position.clone();
  const startT = performance.now();
  const dur = 600;

  const step = () => {
    if (disposed) return;
    const k = Math.min(1, (performance.now() - startT) / dur);
    const e = 1 - Math.pow(1 - k, 3);   // ease-out cubic
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
    // Пересчитываем aspect на случай, если размер контейнера изменился,
    // пока экран был скрыт.
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
  scene = null;
  camera = null;
  renderer = null;
  controls = null;
  sphereMesh = null;
  markersGroup = null;
}
