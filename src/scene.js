// src/scene.js
// Инициализация Three.js: сцена, камера, рендерер, контролы, свет, земля, сетка,
// небо, флаг и кольцо запрета стройки.
//
// Это ядро графа зависимостей: scene, camera, renderer и controls будут
// импортировать почти все остальные модули. Обратных зависимостей нет —
// модуль знает только о config.js, state.js, utils.js, style.js и blocks.js
// (тот получает сцену параметром и о scene.js не знает).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FLAG_COLORS_HEX, FLAG_CLEAR_RADIUS } from './config.js';
import { $ } from './utils.js';
import { makeToonMaterial } from './style.js';
import { initBlocks } from './blocks.js';
import { state } from './state.js';

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x070f22);
scene.fog = new THREE.Fog(0x1c3054, 80, 220);
export const camera = new THREE.PerspectiveCamera(55, innerWidth/innerHeight, 0.1, 500);
camera.position.set(26, 44, 26);
export const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.domElement.style.filter = 'saturate(1.18) contrast(1.06)';
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
$('app').appendChild(renderer.domElement);
export const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 3);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2.6;
controls.minDistance = 10;
controls.maxDistance = 90;
controls.enabled = false;

const skyGeo = new THREE.SphereGeometry(320, 32, 16);
const skyMat = new THREE.ShaderMaterial({
  uniforms: {
    topColor:    { value: new THREE.Color(0x0d1b3d) },
    midColor:    { value: new THREE.Color(0x4a6a9c) },
    bottomColor: { value: new THREE.Color(0xa8b8d0) },
  },
  vertexShader: `
    varying vec3 vWorldPos;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform vec3 topColor;
    uniform vec3 midColor;
    uniform vec3 bottomColor;
    varying vec3 vWorldPos;
    void main() {
      float h = normalize(vWorldPos).y;
      vec3 color;
      if (h < 0.0) {
        color = mix(bottomColor, midColor, smoothstep(-0.4, 0.0, h));
      } else {
        color = mix(midColor, topColor, smoothstep(0.0, 0.6, h));
      }
      gl_FragColor = vec4(color, 1.0);
    }
  `,
  side: THREE.BackSide,
  depthWrite: false,
  fog: false,
});
export const skyMesh = new THREE.Mesh(skyGeo, skyMat);
skyMesh.renderOrder = -1000;
skyMesh.frustumCulled = false;
scene.add(skyMesh);

scene.add(new THREE.AmbientLight(0xffffff, 0.35));
export const sun = new THREE.DirectionalLight(0xffffff, 1.25);
sun.position.set(30, 50, 20);
sun.castShadow = true;
sun.shadow.mapSize.width = 1024;
sun.shadow.mapSize.height = 1024;
sun.shadow.camera.left = -45;
sun.shadow.camera.right = 45;
sun.shadow.camera.top = 45;
sun.shadow.camera.bottom = -45;
sun.shadow.camera.near = 10;
sun.shadow.camera.far = 150;
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.02;
scene.add(sun);
scene.add(sun.target);

export const ground = new THREE.Mesh(
  new THREE.BoxGeometry(66,1,66),
  makeToonMaterial({ color: 0x1e3a2f, flatShading: true })
);
ground.position.y = -0.5;
ground.receiveShadow = true;
ground.castShadow = false;
scene.add(ground);
export const grid = new THREE.GridHelper(64, 64, 0x3b82f6, 0x1e293b);
grid.position.y = 0.01;
scene.add(grid);

export const FLAG_CELL_CENTER = 0.5;
export const RING_HALF = FLAG_CLEAR_RADIUS + 0.5;
export const RING_THICK = 0.08;

const ringMat = new THREE.MeshBasicMaterial({
  color: 0xef4444, transparent: true, opacity: 0.5, depthWrite: false,
});
export const noBuildRing = new THREE.Group();
const ringN = new THREE.Mesh(new THREE.BoxGeometry(RING_HALF * 2, 0.02, RING_THICK), ringMat);
ringN.position.set(0, 0, -RING_HALF);
const ringS = new THREE.Mesh(new THREE.BoxGeometry(RING_HALF * 2, 0.02, RING_THICK), ringMat);
ringS.position.set(0, 0, RING_HALF);
const ringW = new THREE.Mesh(new THREE.BoxGeometry(RING_THICK, 0.02, RING_HALF * 2), ringMat);
ringW.position.set(-RING_HALF, 0, 0);
const ringE = new THREE.Mesh(new THREE.BoxGeometry(RING_THICK, 0.02, RING_HALF * 2), ringMat);
ringE.position.set(RING_HALF, 0, 0);
noBuildRing.add(ringN, ringS, ringW, ringE);
noBuildRing.position.set(FLAG_CELL_CENTER, 0.03, FLAG_CELL_CENTER);
noBuildRing.visible = false;
scene.add(noBuildRing);

export const flagGroup = new THREE.Group();
const pole = new THREE.Mesh(
  new THREE.CylinderGeometry(0.15,0.15,4,8),
  makeToonMaterial({ color: 0x94a3b8 })
);
pole.position.y = 2;
pole.castShadow = true;
pole.receiveShadow = true;
const banner = new THREE.Mesh(
  new THREE.BoxGeometry(1.6,1,0.1),
  makeToonMaterial({ color: 0xef4444 })
);
banner.position.set(0.8, 3.3, 0);
banner.castShadow = true;
banner.receiveShadow = true;
flagGroup.add(pole, banner);
flagGroup.position.set(FLAG_CELL_CENTER, 0, FLAG_CELL_CENTER);
scene.add(flagGroup);

initBlocks(scene);

export function setFlagVisual(hp, maxHp, color) {
  state.currentFlagHp = hp; state.currentFlagMax = maxHp;
  if (color) state.displayFlagColor = color;
  const ratio = maxHp > 0 ? Math.max(0, Math.min(1, hp/maxHp)) : 0;
  const base = new THREE.Color(FLAG_COLORS_HEX[state.displayFlagColor] || FLAG_COLORS_HEX.red);
  banner.material.color.copy(base).lerp(new THREE.Color(0x7f1d1d), 1 - ratio);
  $('flag').textContent = Math.max(0, hp) + ' / ' + maxHp;
  setMinionFlagColor(state.displayFlagColor);
}

// --- флажок Буя ---
// ВРЕМЕННО: setMinionFlagColor по плану живёт в minion.js (модуль 7). Пока он
// не вынесен, функция остаётся здесь: setFlagVisual обязан перекрасить флажок
// Буя вместе со знаменем. Материал регистрируется из index.html при сборке Буя
// (buildMinion) — до первого вызова setFlagVisual он всегда успевает появиться.
// TODO: переехать в minion.js при выносе.
let minionFlagMat = null;
export function setMinionFlagMaterial(mat) { minionFlagMat = mat; }
export function setMinionFlagColor(color) {
  minionFlagMat.color.set(FLAG_COLORS_HEX[color] || FLAG_COLORS_HEX.red);
}
