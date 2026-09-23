// Карта мира: 3D-глобус.
//
// ЧТО ИЗМЕНИЛОСЬ В ЭТОЙ ВЕРСИИ
// ----------------------------
// 1. Убран кастомный шейдер. Проблема была в том, что earth-blue-marble.jpg
//    иногда не грузится с jsdelivr — и shader возвращал чёрный, потому что
//    dayRaw=0. Теперь MeshBasicMaterial: он не зависит от освещения вообще,
//    и текстура либо видна ярко, либо (если 404) виден однотонный цвет
//    материала — но не чёрный экран.
//
// 2. Кластеризация отключена. У пользователя 5 игроков в Берлине — они все
//    попадали в один квадрат и превращались в маркер «5» с подписью.
//    Теперь каждая точка рисуется отдельно с ником. Кластеризацию вернём,
//    когда игроков станет >100 (тогда без неё будет каша).
//
// 3. Cartoony-стиль через CSS-фильтр на canvas: saturate + contrast.
//    Это даёт насыщенные цвета и контрастные границы — то, что нужно.
//    Быстрее и надёжнее шейдера: работает на любом устройстве с CSS.
//
// 4. Управление жёстко зафиксировано: zoomSpeed=0.08, rotateSpeed=0.35.
//    Динамические скорости не помогали — при подлёте к поверхности
//    OrbitControls сам по себе слишком чувствительный.
//
// ДЕНЬ / НОЧЬ
// -----------
// Сейчас не реализовано — глобус всегда дневной. Вернём как второй слой:
// при желании можно наложить землю с ночной текстурой и AdditiveBlending
// на теневую сторону. Пока важнее, чтобы карта была видна.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FLAG_COLORS_HEX } from './config.js';

const WORLD_TO_DEG = 0.01;
const WORLD_CENTER_LON = 10;
const WORLD_CENTER_LAT = 50;

const SPHERE_RADIUS = 100;

// Проверенные URL. jsdelivr@three-globe иногда отдаёт 404 на blue-marble —
// переключились на unpkg, там другая сборка. Список — fallback-цепочка:
// первый успешный идёт в дело.
const EARTH_TEXTURE_SOURCES = [
  'https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg',
  'https://unpkg.com/three-globe/example/img/earth-day.jpg',
  'https://unpkg.com/three@0.160.0/examples/textures/planets/earth_atmos_2048.jpg',
  'https://cdn.jsdelivr.net/npm/three-globe@2/example/img/earth-blue-marble.jpg',
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

// user_id -> { sprite, data }. Всегда одиночные маркеры — кластеризации нет.
const markers = new Map();
let rawPoints = [];
let myUserId = null;

// --- Инициализация --------------------------------------------------------

export function initMap3D(containerEl, { onPointTap, myUserId: myId } = {}) {
  if (scene) return;
  container = containerEl;
  onTapCallback = onPointTap;
  myUserId = myId;

  const w = container.clientWidth || window.innerWidth;
  const h = container.clientHeight || window.innerHeight;

  scene = new THREE.Scene();
  // Тёмно-синий космос, не чёрный — так шар выглядит более объёмно.
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
  // Cartoony: насыщенность + контраст. Один CSS-фильтр, GPU-ускоренный,
  // работает на всех мобильниках. Заменяет пост-обработку через шейдер.
  renderer.domElement.style.filter = 'saturate(1.45) contrast(1.12)';
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.15;
  // Жёсткие скорости. Динамика (0.25→0.80) не помогала: при подлёте к
  // поверхности одно движение пальца всё равно улетало на пол-глобуса,
  // потому что OrbitControls умножает скорость на относительный масштаб.
  // Значения подобраны так, чтобы у поверхности управление было точным,
  // а вдали — не слишком медленным.
  controls.rotateSpeed = 0.35;
  controls.zoomSpeed = 0.08;
  controls.minDistance = SPHERE_RADIUS * 1.08;
  controls.maxDistance = SPHERE_RADIUS * 6;
  controls.enablePan = false;
  controls.target.set(0, 0, 0);

  // SphereGeometry: 96 сегментов по долготе, 48 по широте — компромисс
  // между гладкостью и полигонами. Больше — красивее, но на мобильном
  // при сильном зуме мешает.
  const geo = new THREE.SphereGeometry(SPHERE_RADIUS, 96, 48);

  // MeshBasicMaterial: не зависит от освещения, показывает текстуру как
  // есть. Это НАМЕРЕННО — предыдущая версия с шейдером и светом давала
  // чёрный шар, когда дневная текстура не загружалась.
  //
  // Если текстура 404: материал покажет однотонный цвет (0x3a5f8a —
  // насыщенный синий). Шар будет виден, маркеры будут видны, просто
  // без континентов. Это в разы лучше, чем чёрный экран.
  const mat = new THREE.MeshBasicMaterial({
    color: 0x3a5f8a,   // fallback-цвет (синий океан), пока текстура не загрузилась
    toneMapped: false, // не гасим яркость через tone mapping
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

  running = true;
  animate();
}

function loadEarthTexture(material) {
  let idx = 0;
  const tryNext = () => {
    if (idx >= EARTH_TEXTURE_SOURCES.length) {
      // Все источники 404. Оставляем материал с fallback-цветом — синий
      // шар без континентов. Пользователь хотя бы видит маркеры и может
      // вращать карту.
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
        // Белый цвет = «показывай текстуру как есть». Fallback-синий
        // исчезает, потому что текстура перекрывает цвет.
        material.color.set(0xffffff);
        material.needsUpdate = true;
      },
      undefined,
      () => {
        console.warn('map3d: 404 на', url);
        idx++;
        tryNext();
      },
    );
  };
  tryNext();
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

// --- Текстуры маркеров ---------------------------------------------------

const markerTextureCache = new Map();

// Маркер всегда рисуется с подписью ника — это требование задачи.
// Холст шире, чтобы текст влез, текст в белом цвете с тенью.
function makeMarkerTexture(colorHex, { label, isMine }) {
  const key = `${colorHex}|${label}|${isMine ? 'm' : ''}`;
  if (markerTextureCache.has(key)) return markerTextureCache.get(key);

  // Холст: ширина под ники (до 20 символов), высота — под круг + текст.
  // Фиксированные размеры, чтобы кэш работал и текст помещался.
  const W = 320;
  const H = 200;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Круг — верхняя треть холста, текст — снизу.
  const cx = W / 2;
  const cy = H * 0.32;
  const r = H * 0.24;

  // Свечение под своим маркером.
  if (isMine) {
    const glow = ctx.createRadialGradient(cx, cy, r * 0.5, cx, cy, r * 1.9);
    glow.addColorStop(0, 'rgba(253,230,138,.7)');
    glow.addColorStop(1, 'rgba(253,230,138,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
  }

  // Тень круга — для отрыва от текстуры карты.
  ctx.beginPath();
  ctx.arc(cx, cy + r * 0.15, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,.45)';
  ctx.fill();

  // Основной круг.
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = colorHex;
  ctx.fill();

  // Обводка. У своего маркера — жёлтая, у чужого — белая. Толстая, чтобы
  // было видно на любом фоне.
  ctx.lineWidth = r * 0.22;
  ctx.strokeStyle = isMine ? '#fde68a' : 'rgba(255,255,255,.95)';
  ctx.stroke();

  // Блик — выпуклость.
  ctx.beginPath();
  ctx.arc(cx - r * 0.3, cy - r * 0.35, r * 0.35, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,.5)';
  ctx.fill();

  // Ник — крупно, внизу, с тенью для читаемости на светлом фоне.
  ctx.font = `700 34px system-ui,-apple-system,sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  // Обводка текста чёрным — ещё один слой читаемости.
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(0,0,0,.85)';
  ctx.strokeText(label, cx, cy + r + 10);
  // Сам текст.
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, cx, cy + r + 10);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  markerTextureCache.set(key, tex);
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
      const tex = makeMarkerTexture(css, { label: p.username, isMine });
      const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        depthTest: false,   // рисуем поверх сферы — не мерцает на границе
      });
      const sprite = new THREE.Sprite(mat);
      sprite.userData.user_id = p.user_id;
      sprite.userData.username = p.username;
      sprite.userData.isMine = isMine;
      // Соотношение сторон холста: 320×200 = 1.6.
      sprite.userData.aspect = 1.6;
      sprite.userData.baseSize = isMine ? 40 : 34;

      const { lat, lon } = worldToLatLon(p.world_x, p.world_y);
      // +1.5% радиуса — маркер стоит чуть выше поверхности, не сливается
      // с текстурой и не «утопает» в ней.
      sprite.position.copy(latLonToVec3(lat, lon, SPHERE_RADIUS * 1.015));

      markersGroup.add(sprite);
      entry = { sprite, data: p };
      markers.set(String(p.user_id), entry);
    } else {
      // Обновляем позицию, если игрок переехал.
      const { lat, lon } = worldToLatLon(p.world_x, p.world_y);
      const newPos = latLonToVec3(lat, lon, SPHERE_RADIUS * 1.015);
      if (!entry.sprite.position.equals(newPos)) {
        entry.sprite.position.copy(newPos);
      }
      entry.data = p;
    }

    entry.sprite.visible = true;
  }

  // Убираем маркеры, которых нет в новом ответе.
  for (const [id, entry] of markers) {
    if (!seen.has(id)) {
      markersGroup.remove(entry.sprite);
      entry.sprite.material.dispose();
      markers.delete(id);
    }
  }

  updateMarkerScales();
}

// Компенсация размера: спрайт должен занимать фиксированное число пикселей
// на экране независимо от расстояния до камеры. Иначе при отдалении
// маркеры схлопываются в точку.
function updateMarkerScales() {
  const h = renderer.domElement.clientHeight;
  const vFov = (camera.fov * Math.PI) / 180;
  const k = (2 * Math.tan(vFov / 2)) / h;

  for (const { sprite } of markers.values()) {
    const distance = camera.position.distanceTo(sprite.position);
    const aspect = sprite.userData.aspect || 1;
    const baseSize = sprite.userData.baseSize || 34;
    const scale = k * distance * baseSize;
    sprite.scale.set(scale * aspect, scale, 1);
  }
}

// --- Цикл рендера ---------------------------------------------------------

function animate() {
  if (disposed) return;
  animationId = requestAnimationFrame(animate);
  if (!running) return;

  controls.update();
  // Пересчитываем размеры маркеров каждый кадр — дёшево, а при движении
  // камеры нужно, чтобы они оставались фиксированного размера на экране.
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
  if (hit.userData.isMine) return;
  onTapCallback(uid, uname);
}

// --- Публичное API --------------------------------------------------------

export function flyToPlayer(userId, username, { zoom = 1 } = {}) {
  if (!camera || !controls) return;

  // Целевая точка: находим по маркеру или по rawPoints.
  let target = null;
  const m = markers.get(String(userId));
  if (m) {
    target = m.sprite.position.clone();
  } else {
    for (const p of rawPoints) {
      if (String(p.user_id) === String(userId)) {
        const { lat, lon } = worldToLatLon(p.world_x, p.world_y);
        target = latLonToVec3(lat, lon, SPHERE_RADIUS * 1.015);
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
    // Сферическая интерполяция: лерпим позиции, нормализуем, ставим на
    // нужный радиус. Так камера идёт по дуге над поверхностью, а не
    // сквозь шар.
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
    }
