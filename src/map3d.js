// Карта мира: 3D-глобус с дневным/ночным циклом и кластеризацией.
//
// ОСВЕЩЕНИЕ
// ---------
// Нормаль к поверхности считается в МИРОВЫХ координатах (mat3(modelMatrix)),
// солнце задаётся в мире. Terminator зафиксирован в мировых координатах и
// не зависит от вращения камеры. Солнце движется по реальному UTC:
// 12:00 UTC — над Гринвичем, каждые 24 часа полный оборот. Широта
// упрощена до 0° (реальная гуляет ±23.5° по сезону — для визуала
// несущественно).
//
// ЯРКОСТЬ (актуальные значения)
// -----------------------------
// Дневная текстура усиливается через pow(raw * 1.4, 0.9) — blue-marble
// сама по себе бледная. Терминатор расширен до ~60°: smoothstep(-0.45, 0.10)
// вместо старого (-0.15, 0.25), чтобы день занимал больше диска.
// Ночная сторона подсвечена дневной текстурой на 35% + огни городов
// усилены в 1.6 раз.
//
// КЛАСТЕРИЗАЦИЯ
// -------------
// При camDist > 2R точки группируются по квадратам world-grid. Размер
// сетки 12..340 единиц, зависит от расстояния до камеры. Ближе 2R —
// кластеризация полностью отключается, каждая точка рисуется отдельно
// со своим ником.
//
// ДИНАМИЧЕСКИЕ СКОРОСТИ КАМЕРЫ
// ----------------------------
// rotateSpeed и zoomSpeed меняются каждый кадр в зависимости от
// расстояния. У поверхности — точные (0.25 / 0.20), вдали — быстрые
// (0.80 / 1.00). Фиксированные значения либо не давали точности вблизи,
// либо не позволяли быстро обернуться вокруг глобуса.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FLAG_COLORS_HEX } from './config.js';

const WORLD_TO_DEG = 0.01;
const WORLD_CENTER_LON = 10;
const WORLD_CENTER_LAT = 50;

const SPHERE_RADIUS = 100;

const EARTH_TEXTURE_SOURCES_DAY = [
  'https://cdn.jsdelivr.net/npm/three-globe@2/example/img/earth-blue-marble.jpg',
  'https://cdn.jsdelivr.net/npm/three-globe@2/example/img/earth-day.jpg',
  'https://unpkg.com/three@0.160.0/examples/textures/planets/earth_atmos_2048.jpg',
];

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

// user_id -> { sprite, data } — только для одиночных маркеров.
// Используется в setMapCameraToMe, чтобы найти позицию своего острова.
const markers = new Map();

// Плоский список визуальных объектов — одиночные маркеры и кластеры.
// Каждый: { sprite, kind, data }
let visualMarkers = [];

// Сырые точки с бэка — источник правды для кластеризации.
let rawPoints = [];

let myUserId = null;

let uniforms = null;

// Для пересборки кластеров: запоминаем, при каком расстоянии собирали.
let lastClusterDist = 0;

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
  controls.dampingFactor = 0.12;
  // Стартовые скорости; animate() переписывает их каждый кадр в зависимости
  // от расстояния. Здесь значения нужны только для первого кадра.
  controls.rotateSpeed = 0.45;
  controls.zoomSpeed = 0.35;
  controls.minDistance = SPHERE_RADIUS * 1.05;
  controls.maxDistance = SPHERE_RADIUS * 6;
  controls.enablePan = false;
  controls.target.set(0, 0, 0);

  const geo = new THREE.SphereGeometry(SPHERE_RADIUS, 128, 64);

  uniforms = {
    dayTexture:   { value: null },
    nightTexture: { value: null },
    sunDirection: { value: new THREE.Vector3(1, 0, 0) },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      varying vec3 vWorldNormal;
      varying vec3 vViewNormal;
      varying vec2 vUv;

      void main() {
        // Нормаль в МИРОВЫХ координатах — для расчёта дня/ночи.
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        // Нормаль во VIEW space — только для rim-эффекта (обводки).
        vViewNormal = normalize(normalMatrix * normal);
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D dayTexture;
      uniform sampler2D nightTexture;
      uniform vec3 sunDirection;
      varying vec3 vWorldNormal;
      varying vec3 vViewNormal;
      varying vec2 vUv;

      void main() {
        vec3 dayRaw = texture2D(dayTexture, vUv).rgb;
        vec3 nightRaw = texture2D(nightTexture, vUv).rgb;

        // Усиление дневной текстуры: blue-marble сама по себе недостаточно
        // насыщенная, океаны серовато-синие. 1.4 + лёгкая gamma вытягивают
        // континенты и воду до читаемого уровня.
        vec3 dayColor = pow(dayRaw * 1.4, vec3(0.9));

        // Угол между нормалью и солнцем в мировых координатах.
        float cosAngle = dot(normalize(vWorldNormal), normalize(sunDirection));

        // Расширенная дневная зона.
        //   cosAngle = 1.0  → прямо под солнцем
        //   cosAngle = 0.1  → ещё день (верхний порог)
        //   cosAngle = -0.45 → начинается ночь (нижний порог)
        // Терминатор ~60° ширины. Старый smoothstep(-0.15, 0.25) давал
        // ночь уже при 75° от солнца — больше половины диска в тени.
        float dayAmount = smoothstep(-0.45, 0.10, cosAngle);

        // Ночная сторона: огни городов заметно ярче + подсветка
        // континентов дневной текстурой (силуэты читаются).
        vec3 nightLit = nightRaw * 1.6 + dayColor * 0.35 + vec3(0.05);

        vec3 color = mix(nightLit, dayColor, dayAmount);

        // Обводка («нарисованный» вид): rim-эффект по краю диска.
        float rim = 1.0 - abs(vViewNormal.z);
        float outline = smoothstep(0.62, 0.96, rim);
        color = mix(color, vec3(0.02, 0.04, 0.10), outline * 0.7);

        // Голубая атмосфера на светлом лимбе.
        float atmosphere = smoothstep(0.55, 0.92, rim) * dayAmount * 0.35;
        color += vec3(0.35, 0.6, 1.0) * atmosphere;

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
    if (idx >= sources.length) return;
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    loader.load(sources[idx], onLoad, undefined, () => { idx++; tryNext(); });
  };
  tryNext();
}

// --- Солнце ---------------------------------------------------------------

// Пересчитываем каждый кадр: 60 FPS × маленькая тригонометрия — бесплатно.
// Плавное движение терминатора видно глазом, задержка на минуту делала бы
// сдвиг дёрганым.
function updateSunDirection() {
  if (!uniforms) return;
  const now = new Date();
  const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
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

// --- Текстуры маркеров ---------------------------------------------------

const markerTextureCache = new Map();

function makeMarkerTexture(colorHex, { label = null, isMine = false, count = 0 } = {}) {
  const key = `${colorHex}|${label || ''}|${isMine ? 'm' : ''}|${count}`;
  if (markerTextureCache.has(key)) return markerTextureCache.get(key);

  // Холст шире, если есть подпись — иначе текст не влезет.
  const hasLabel = label !== null && label !== '';
  const W = hasLabel ? 256 : 128;
  const H = hasLabel ? 180 : 128;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Центр круга: при наличии подписи — верхняя треть, иначе центр.
  const cx = W / 2;
  const cy = hasLabel ? H * 0.35 : H / 2;
  const r = hasLabel ? H * 0.28 : W * 0.32;

  // Свечение под своим маркером.
  if (isMine) {
    const glow = ctx.createRadialGradient(cx, cy, r * 0.5, cx, cy, r * 1.7);
    glow.addColorStop(0, 'rgba(253,230,138,.55)');
    glow.addColorStop(1, 'rgba(253,230,138,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
  }

  // Круг.
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = colorHex;
  ctx.fill();
  ctx.lineWidth = r * 0.18;
  ctx.strokeStyle = isMine ? '#fde68a' : 'rgba(255,255,255,.9)';
  ctx.stroke();

  // Блик.
  ctx.beginPath();
  ctx.arc(cx - r * 0.25, cy - r * 0.3, r * 0.35, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,.4)';
  ctx.fill();

  // Число для кластера — крупно, по центру круга.
  if (count > 0) {
    ctx.font = `bold ${Math.round(r * 1.05)}px system-ui,-apple-system,sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#0b1020';
    ctx.fillText(String(count), cx, cy + r * 0.05);
    ctx.fillStyle = '#fff';
    ctx.fillText(String(count), cx, cy);
  }

  // Подпись под кругом.
  if (hasLabel) {
    ctx.font = `600 ${Math.round(H * 0.14)}px system-ui,-apple-system,sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    // Тень для читаемости на светлой карте.
    ctx.fillStyle = 'rgba(0,0,0,.75)';
    ctx.fillText(label, cx + 1, cy + r + 6 + 1);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, cx, cy + r + 6);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  markerTextureCache.set(key, tex);
  return tex;
}

// --- Кластеризация --------------------------------------------------------

// Пересобирает визуальные маркеры из rawPoints, группируя близкие точки.
// Вызывается: при setMapPoints и при значительном изменении дистанции камеры.
function rebuildMarkers() {
  if (!markersGroup) return;

  const camDist = camera.position.length();

  // Нормированное расстояние 0 (у поверхности) .. 1 (максимум).
  const t = Math.max(0, Math.min(1,
    (camDist - controls.minDistance) / (controls.maxDistance - controls.minDistance)
  ));

  // Полное отключение кластеризации при достаточно близком зуме.
  //
  // Причина: 5 игроков спавнятся в радиусе 60 единиц вокруг Берлина.
  // При ячейке 30×30 они все попадают в один-два квадрата, и вместо
  // отдельных маркеров с никами виден один кластер с цифрой.
  // При camDist < 2R каждая точка рисуется отдельно — ник на каждом.
  const noClustering = camDist < SPHERE_RADIUS * 2.0;

  // Размер сетки: 1 (= нет кластеризации) вблизи, 340 вдали.
  // Нижняя граница 12 — на среднем зуме плотные группы начинают
  // разбиваться раньше, чем при старой 30.
  const gridSize = noClustering
    ? 1
    : 12 + Math.pow(t, 1.6) * 340;

  // Подписи показываем щедрее: было < 2.5R, стало < 3.2R. При 3.2R
  // уже есть смысл различать ники.
  const showLabels = camDist < SPHERE_RADIUS * 3.2;

  // Квадратная сетка в мировых единицах.
  const cells = new Map();
  for (const p of rawPoints) {
    const gx = Math.floor(p.world_x / gridSize);
    const gy = Math.floor(p.world_y / gridSize);
    const key = gx + ',' + gy;
    let arr = cells.get(key);
    if (!arr) { arr = []; cells.set(key, arr); }
    arr.push(p);
  }

  // Скрываем все существующие объекты. Проще создать новые, чем
  // переиспользовать: их немного (десятки), стоимость — доли миллисекунды.
  for (const vm of visualMarkers) {
    markersGroup.remove(vm.sprite);
    vm.sprite.material.dispose();
  }
  visualMarkers = [];

  for (const [key, group] of cells) {
    // Одна точка — рисуем индивидуальный маркер.
    if (group.length === 1) {
      const p = group[0];
      const isMine = myUserId && String(p.user_id) === String(myUserId);
      const hex = FLAG_COLORS_HEX[p.flag_color] ?? 0xef4444;
      const css = '#' + hex.toString(16).padStart(6, '0');
      const label = showLabels ? p.username : null;

      const tex = makeMarkerTexture(css, { label, isMine });
      const mat = new THREE.SpriteMaterial({
        map: tex, transparent: true, depthWrite: false, depthTest: true,
      });
      const sprite = new THREE.Sprite(mat);
      const { lat, lon } = worldToLatLon(p.world_x, p.world_y);
      sprite.position.copy(latLonToVec3(lat, lon, SPHERE_RADIUS * 1.015));
      sprite.userData.kind = 'single';
      sprite.userData.user_id = p.user_id;
      sprite.userData.username = p.username;
      sprite.userData.isMine = isMine;
      // Коэффициент масштабирования под текстуру с подписью: она шире,
      // надо нормировать, чтобы высота спрайта была как у одиночного кружка.
      sprite.userData.aspect = label ? (256 / 180) : 1;
      // Маркеры с подписью делаем крупнее, чтобы ник читался.
      sprite.userData.baseSize = label
        ? (isMine ? 36 : 30)
        : (isMine ? 26 : 20);

      markersGroup.add(sprite);
      visualMarkers.push({ sprite, kind: 'single', data: p });
      continue;
    }

    // Несколько точек — рисуем кластер.
    let sx = 0, sy = 0;
    let hasMine = false;
    for (const p of group) {
      sx += p.world_x;
      sy += p.world_y;
      if (myUserId && String(p.user_id) === String(myUserId)) hasMine = true;
    }
    const wx = sx / group.length;
    const wy = sy / group.length;

    // Цвет кластера: если в нём мой остров — жёлтый, иначе — по флагу
    // самого крупного члена группы. Так крупные кластеры выделяются
    // своим доминирующим цветом.
    let dominant = group[0];
    for (const p of group) {
      if (p.cube_count > dominant.cube_count) dominant = p;
    }
    const hex = hasMine ? 0xfde68a : (FLAG_COLORS_HEX[dominant.flag_color] ?? 0xef4444);
    const css = '#' + hex.toString(16).padStart(6, '0');

    const tex = makeMarkerTexture(css, { count: group.length, isMine: hasMine });
    const mat = new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false, depthTest: true,
    });
    const sprite = new THREE.Sprite(mat);
    const { lat, lon } = worldToLatLon(wx, wy);
    sprite.position.copy(latLonToVec3(lat, lon, SPHERE_RADIUS * 1.015));
    sprite.userData.kind = 'cluster';
    sprite.userData.memberIds = group.map(p => String(p.user_id));
    sprite.userData.members = group;
    sprite.userData.isMine = hasMine;
    sprite.userData.aspect = 1;
    sprite.userData.baseSize = hasMine ? 30 : 26;

    markersGroup.add(sprite);
    visualMarkers.push({ sprite, kind: 'cluster', data: { wx, wy, count: group.length } });
  }

  // Обновляем глобальный указатель для одиночных маркеров — нужен
  // для setMapCameraToMe и flyToPlayer.
  markers.clear();
  for (const vm of visualMarkers) {
    if (vm.kind === 'single') {
      markers.set(String(vm.sprite.userData.user_id), { sprite: vm.sprite, data: vm.data });
    }
  }

  lastClusterDist = camDist;
}

export function setMapPoints(points) {
  rawPoints = points || [];
  if (camera && controls) rebuildMarkers();
}

// --- Масштаб маркеров под экран -------------------------------------------

function updateMarkerScales() {
  const h = renderer.domElement.clientHeight;
  const vFov = (camera.fov * Math.PI) / 180;
  const k = (2 * Math.tan(vFov / 2)) / h;

  for (const vm of visualMarkers) {
    const sprite = vm.sprite;
    const distance = camera.position.distanceTo(sprite.position);
    const aspect = sprite.userData.aspect || 1;
    const baseSize = sprite.userData.baseSize || 20;
    const scale = k * distance * baseSize;
    // Sprite.scale задаёт размер по X и Y. С учётом aspect холста
    // (ширина/высота), масштабируем по X пропорционально.
    sprite.scale.set(scale * aspect, scale, 1);
  }
}

// --- Цикл рендера ---------------------------------------------------------

let lastClusterCheck = 0;

function animate() {
  if (disposed) return;
  animationId = requestAnimationFrame(animate);
  if (!running) return;

  updateSunDirection();

  const camDist = camera.position.length();

  // Динамические скорости: у поверхности камера должна двигаться
  // медленно (иначе одно движение пальца пролетает полсферы), а вдали —
  // быстрее, чтобы не «пилить» пальцем через экран.
  const speedT = Math.max(0, Math.min(1,
    (camDist - controls.minDistance) / (controls.maxDistance - controls.minDistance)
  ));
  // Вблизи: 0.25, вдали: 0.80. Разница в 3 раза — этого хватает,
  // чтобы у поверхности вращение было точным, а вдали не раздражало.
  controls.rotateSpeed = 0.25 + speedT * 0.55;
  // Вблизи: 0.20 (один тик зума даёт маленький шаг), вдали: 1.00
  // (за пару pinch'ей от полюса к полюсу).
  controls.zoomSpeed = 0.20 + speedT * 0.80;

  controls.update();

  // Пересобираем кластеры, если дистанция изменилась больше чем на 15%
  // или прошло 1.5 секунды. Так избегаем пересборки на каждый кадр
  // (это дорого) и на каждый микро-сдвиг pinch'а.
  const now = performance.now();
  if (
    Math.abs(camDist - lastClusterDist) > lastClusterDist * 0.15 ||
    now - lastClusterCheck > 1500
  ) {
    rebuildMarkers();
    lastClusterCheck = now;
  }

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

  const sprites = visualMarkers.map(vm => vm.sprite);
  const hits = raycaster.intersectObjects(sprites, false);
  if (hits.length === 0) return;

  const hit = hits[0].object;

  if (hit.userData.kind === 'cluster') {
    // Тап по кластеру: приближаемся к его центру. Дальше пользователь
    // увидит отдельные маркеры (сетка кластеризации уменьшится).
    const members = hit.userData.members || [];
    if (members.length === 0) return;
    // Летим к первому члену — его маркер будет точкой фокуса.
    // Идеально было бы к центроиду, но он не всегда валиден (может
    // оказаться на воде). Первый член — безопасно.
    const target = members[0];
    flyToPlayer(target.user_id, target.username, { zoom: 1.4, fromCluster: true });
    return;
  }

  // Одиночный маркер.
  const uid = hit.userData.user_id;
  const uname = hit.userData.username;
  if (hit.userData.isMine) return;   // свой — не открываем профиль
  onTapCallback(uid, uname);
}

// --- Публичное API --------------------------------------------------------

// Плавный перелёт к игроку. Если zoom передан — приближаемся
// (zoom > 1 значит ближе к поверхности), иначе остаёмся на текущем.
export function flyToPlayer(userId, username, { zoom = 1, fromCluster = false } = {}) {
  if (!camera || !controls) return;

  // Находим цель: сначала в одиночных маркерах, если не нашли —
  // ищем в rawPoints (кластер мог скрыть одиночный маркер).
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

  // Направление от центра к цели — нормаль поверхности в её точке.
  const dir = target.clone().normalize();

  // Итоговое расстояние камеры: базовое 3.0R / zoom. zoom=1 — то же
  // расстояние, zoom=2 — вдвое ближе.
  const currentDist = camera.position.length();
  const finalDist = Math.max(
    controls.minDistance,
    Math.min(controls.maxDistance, (SPHERE_RADIUS * 3.0) / zoom)
  );

  const endPos = dir.clone().multiplyScalar(finalDist);
  const startPos = camera.position.clone();

  // Дуговой перелёт: линейная интерполяция позиций даёт «провал» внутрь
  // сферы, если точки на противоположных сторонах. Нормализуем на каждом
  // шаге — получаем сферическую интерполяцию, камера идёт по поверхности.
  const startT = performance.now();
  const dur = fromCluster ? 800 : 1000;

  const step = () => {
    if (disposed) return;
    const k = Math.min(1, (performance.now() - startT) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    // Лерпим, потом проецируем на сферу радиуса lerp(startDist, finalDist).
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
  flyToPlayer(String(myUserId), '', { zoom: 1.6 });
}

export function zoomMapBy(factor) {
  if (!camera || !controls) return;
  const dir = camera.position.clone().normalize();
  const currentDist = camera.position.length();
  let newDist = currentDist / factor;
  newDist = Math.max(controls.minDistance, Math.min(controls.maxDistance, newDist));

  // Плавная интерполяция: мгновенный скачок дизориентирует.
  const startDist = currentDist;
  const startT = performance.now();
  const dur = 200;

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
    updateSunDirection();
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
  visualMarkers = [];
  rawPoints = [];
  scene = null;
  camera = null;
  renderer = null;
  controls = null;
  sphereMesh = null;
  markersGroup = null;
  uniforms = null;
        }
