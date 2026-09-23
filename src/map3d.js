// Карта мира: 3D-глобус.

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

const HIT_RADIUS_PX = 44;

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

function makeMarkerTexture(colorHex, { label, isMine }) {
  const key = `${colorHex}|${label}|${isMine ? 'm' : ''}`;
  if (markerTextureCache.has(key)) return markerTextureCache.get(key);

  const W = 240;
  const H = 110;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const cx = W / 2;
  const cy = 40;
  const r = 28;

  if (isMine) {
    const glow = ctx.createRadialGradient(cx, cy, r * 0.5, cx, cy, r * 1.9);
    glow.addColorStop(0, 'rgba(253,230,138,.75)');
    glow.addColorStop(1, 'rgba(253,230,138,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
  }

  ctx.beginPath();
  ctx.arc(cx, cy + 3, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,.5)';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = colorHex;
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = isMine ? '#fde68a' : 'rgba(255,255,255,.95)';
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx - r * 0.3, cy - r * 0.35, r * 0.4, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,.55)';
  ctx.fill();

  ctx.font = '700 34px system-ui,-apple-system,sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(0,0,0,.9)';
  ctx.strokeText(label, cx, 76);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, cx, 76);

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
      const tex = makeMarkerTexture(css, { label: p.username, isMine });
      const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        depthTest: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.userData.user_id = p.user_id;
      sprite.userData.username = p.username;
      sprite.userData.isMine = isMine;
      sprite.userData.aspect = 240 / 110;
      sprite.userData.baseSize = isMine ? 42 : 36;

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

  for (const { sprite } of markers.values()) {
    const distance = camera.position.distanceTo(sprite.position);
    const aspect = sprite.userData.aspect || 1;
    const baseSize = sprite.userData.baseSize || 36;
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

  let best = null;
  let bestDist = Infinity;

  for (const [uid, { sprite, data }] of markers.entries()) {
    _projVec.copy(sprite.position).project(camera);
    if (_projVec.z > 1) continue;

    const sx = (_projVec.x * 0.5 + 0.5) * rect.width;
    const sy = (-_projVec.y * 0.5 + 0.5) * rect.height;

    const ddx = sx - tapX;
    const ddy = sy - tapY;
    const d = Math.hypot(ddx, ddy);
    if (d < bestDist) {
      bestDist = d;
      best = { uid, sprite, data };
    }
  }

  if (!best || bestDist > HIT_RADIUS_PX) return;
  if (best.sprite.userData.isMine) return;
  onTapCallback(best.uid, best.data.username);
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
