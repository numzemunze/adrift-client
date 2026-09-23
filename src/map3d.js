// src/map3d.js
// Карта мира: 3D-глобус с LOD-маркерами.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FLAG_COLORS_HEX } from './config.js';

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

let scene = null;
let camera = null;
let renderer = null;
let controls = null;
let sphereMesh = null;
let markersGroup = null;

let container = null;
let onTapCallback = null;
let disposed = false;
let running = false;
let animationId = 0;

const markers = new Map();
let rawPoints = [];
let myUserId = null;

const _projVec = new THREE.Vector3();

export function initMap3D(containerEl, { onPointTap, myUserId: myId } = {}) {
  if (scene) return;
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
  renderer.domElement.style.filter = 'saturate(1.5) contrast(1.15)';
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.15;
  controls.rotateSpeed = 0.35;
  controls.zoomSpeed = 0.55;
  controls.minDistance = SPHERE_RADIUS * 1.08;
  controls.maxDistance = SPHERE_RADIUS * 6;
  controls.enablePan = false;
  controls.target.set(0, 0, 0);

  const geo = new THREE.SphereGeometry(SPHERE_RADIUS, 96, 48);

  const mat = new THREE.MeshBasicMaterial({
    color: 0x3a5f8a,
    toneMapped: false,
  });

  sphereMesh = new THREE.Mesh(geo, mat);
  scene.add(sphereMesh);

  loadEarthTexture(mat);

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
      () => {
        console.warn('map3d: 404 на', url);
        idx++;
        tryNext();
      },
    );
  };
  tryNext();
}

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

const markerTextureCache = new Map();

function makeCompactTexture(colorHex, isMine) {
  const key = `c|${colorHex}|${isMine ? 'm' : ''}`;
  if (markerTextureCache.has(key)) return markerTextureCache.get(key);

  const S = 96;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');
  const cx = S / 2, cy = S / 2, r = 34;

  if (isMine) {
    const glow = ctx.createRadialGradient(cx, cy, r * 0.5, cx, cy, r * 1.9);
    glow.addColorStop(0, 'rgba(253,230,138,.7)');
    glow.addColorStop(1, 'rgba(253,230,138,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, S, S);
  }

  ctx.beginPath();
  ctx.arc(cx, cy + 2, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,.5)';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = colorHex;
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = isMine ? '#fde68a' : 'rgba(255,255,255,.95)';
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx - r * 0.3, cy - r * 0.35, r * 0.4, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,.55)';
  ctx.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  markerTextureCache.set(key, tex);
  return tex;
}

function makeFullTexture(colorHex, label, isMine, extra = null) {
  const key = `f|${colorHex}|${label}|${isMine ? 'm' : ''}|${extra ? extra.cubes + '_' + (extra.online ? '1' : '0') : ''}`;
  if (markerTextureCache.has(key)) return markerTextureCache.get(key);

  const FONT_SIZE = 40;
  const PADDING = 32;

  const measureCanvas = document.createElement('canvas');
  const mCtx = measureCanvas.getContext('2d');
  mCtx.font = `700 ${FONT_SIZE}px system-ui,-apple-system,sans-serif`;
  const textWidth = Math.ceil(mCtx.measureText(label).width);
  const W = Math.max(240, textWidth + PADDING * 2);
  const H = extra ? 200 : 160;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const cx = W / 2;
  const textY = 8;
  const circleY = 122;
  const r = 34;

  if (isMine) {
    const glow = ctx.createRadialGradient(cx, circleY, r * 0.5, cx, circleY, r * 2.2);
    glow.addColorStop(0, 'rgba(253,230,138,.7)');
    glow.addColorStop(1, 'rgba(253,230,138,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
  }

  ctx.beginPath();
  ctx.arc(cx, circleY + 3, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,.5)';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, circleY, r, 0, Math.PI * 2);
  ctx.fillStyle = colorHex;
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = isMine ? '#fde68a' : 'rgba(255,255,255,.95)';
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx - r * 0.3, circleY - r * 0.35, r * 0.4, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,.55)';
  ctx.fill();

  ctx.font = `700 ${FONT_SIZE}px system-ui,-apple-system,sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineWidth = 7;
  ctx.strokeStyle = 'rgba(0,0,0,.95)';
  ctx.strokeText(label, cx, textY);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, cx, textY);

  if (extra) {
    const badgeY = circleY + r + 14;
    const badgeFont = '600 26px system-ui,-apple-system,sans-serif';
    ctx.font = badgeFont;

    const cubeText = '🧱 ' + extra.cubes;
    const statusText = extra.online ? '●' : '○';
    const statusColor = extra.online ? '#22c55e' : 'rgba(255,255,255,.5)';

    const cubeW = ctx.measureText(cubeText).width;
    const statusW = 20;
    const padX = 14;
    const badgeW = cubeW + statusW + padX * 3;
    const badgeH = 36;
    const bx = cx - badgeW / 2;

    const radius = 10;
    ctx.beginPath();
    ctx.moveTo(bx + radius, badgeY);
    ctx.arcTo(bx + badgeW, badgeY, bx + badgeW, badgeY + badgeH, radius);
    ctx.arcTo(bx + badgeW, badgeY + badgeH, bx, badgeY + badgeH, radius);
    ctx.arcTo(bx, badgeY + badgeH, bx, badgeY, radius);
    ctx.arcTo(bx, badgeY, bx + badgeW, badgeY, radius);
    ctx.closePath();
    ctx.fillStyle = 'rgba(11,16,32,.85)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.25)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fde68a';
    ctx.fillText(cubeText, bx + padX, badgeY + badgeH / 2);

    ctx.fillStyle = statusColor;
    ctx.font = '700 28px system-ui,-apple-system,sans-serif';
    ctx.fillText(statusText, bx + padX + cubeW + padX, badgeY + badgeH / 2);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  markerTextureCache.set(key, tex);
  return tex;
}

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
      const texFull    = makeFullTexture(css, p.username, isMine);
      const texCompact = makeCompactTexture(css, isMine);

      const mat = new THREE.SpriteMaterial({
        map: texFull,
        transparent: true,
        depthWrite: false,
        depthTest: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.userData.user_id = p.user_id;
      sprite.userData.username = p.username;
      sprite.userData.isMine = isMine;
      sprite.userData.texFull = texFull;
      sprite.userData.texCompact = texCompact;
      sprite.userData.aspectFull = texFull.image.width / texFull.image.height;
      sprite.userData.aspectCompact = 1;

      const { lat, lon } = worldToLatLon(p.world_x, p.world_y);
      sprite.position.copy(latLonToVec3(lat, lon, SPHERE_RADIUS * 1.015));

      markersGroup.add(sprite);
      entry = { sprite, data: p };
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

  updateMarkerScales();
}

function updateMarkerScales() {
  const h = renderer.domElement.clientHeight;
  const vFov = (camera.fov * Math.PI) / 180;
  const k = (2 * Math.tan(vFov / 2)) / h;

  const camDist = camera.position.length();
  const ratio = camDist / SPHERE_RADIUS;

  let level;
  let baseSize;
  if (ratio > LOD_FAR) {
    level = 'far';
    baseSize = 34;
  } else if (ratio > LOD_MID) {
    level = 'mid';
    baseSize = 56;
  } else {
    level = 'close';
    baseSize = 90;
  }

  for (const { sprite, data } of markers.values()) {
    const distance = camera.position.distanceTo(sprite.position);

    const targetMap = level === 'far' ? sprite.userData.texCompact : sprite.userData.texFull;

    if (level === 'close') {
      const hex = FLAG_COLORS_HEX[data.flag_color] ?? 0xef4444;
      const css = '#' + hex.toString(16).padStart(6, '0');
      const isMine = myUserId && String(data.user_id) === String(myUserId);
      const texClose = makeFullTexture(css, data.username, isMine, {
        cubes: data.cube_count || 0,
        online: !!data.is_online,
      });
      if (sprite.material.map !== texClose) {
        sprite.material.map = texClose;
        sprite.material.needsUpdate = true;
      }
    } else if (sprite.material.map !== targetMap) {
      sprite.material.map = targetMap;
      sprite.material.needsUpdate = true;
    }

    const aspect = level === 'far'
      ? sprite.userData.aspectCompact
      : (sprite.material.map.image.width / sprite.material.map.image.height);
    const scale = k * distance * baseSize;
    sprite.scale.set(scale * aspect, scale, 1);
  }
}

function animate() {
  if (disposed) return;
  animationId = requestAnimationFrame(animate);
  if (!running) return;

  controls.update();
  updateMarkerScales();
  renderer.render(scene, camera);
}

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
  for (const [uid, { sprite, data }] of markers.entries()) {
    _projVec.copy(sprite.position).project(camera);
    if (_projVec.z > 1) continue;

    const sx = (_projVec.x * 0.5 + 0.5) * rect.width;
    const sy = (-_projVec.y * 0.5 + 0.5) * rect.height;
    const screenDist = Math.hypot(sx - tapX, sy - tapY);
    if (screenDist > HIT_RADIUS_PX) continue;

    const camDist = camPos.distanceTo(sprite.position);
    candidates.push({ uid, sprite, data, screenDist, camDist });
  }

  if (!candidates.length) return;

  candidates.sort((a, b) => (a.camDist - b.camDist) || (a.screenDist - b.screenDist));
  const chosen = candidates[0];

  if (chosen.sprite.userData.isMine) return;
  onTapCallback(chosen.uid, chosen.data.username);
}

export function flyToPlayer(userId, username, { zoom = 1 } = {}) {
  if (!camera || !controls) return;

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
