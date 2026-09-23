// src/blocks.js
// Кубы: текстуры, геометрия по форме, материалы, добавление/удаление меша
// на сцене, пересчёт «наземных» клеток для Буйка.
//
// Этот модуль — «сцена кубов»: единственное место, где живут cubeMeshes
// (Map id → THREE.Mesh) и blockedGround (Set клеток «x,z», занятых наземными
// кубами). Рейкаст, ИИ Буйка, счётчики — все читают их ОТСЮДА, а не из
// глобальной области index.html.
//
// ЧТО НЕ ВХОДИТ СЮДА и осталось в index.html:
//   * setFlagVisual — управляет флагом, это не про кубы;
//   * computePlacement, updateGhost — это рейкаст и превью, отдельный модуль;
//   * cubeTypeInfo, каталог — это про цены, пусть живёт рядом с магазином.
//
// ПОРЯДОК ИНИЦИАЛИЗАЦИИ: scene должна существовать до первого addCube.
// Поэтому initBlocks(scene) вызывается сразу после сборки сцены в index.html.
//
// СТИЛЬ (TOON)
// -------------
// Материалы кубов создаются через makeToonMaterial из style.js. Это даёт
// дискретное освещение (3 ступени), как в комиксах, вместо плавного
// градиента Lambert. Текстуры (дерево/железо) при этом сохраняются.
//
// Чёрная рамка по краям текстур рисуется прямо в canvas — при наложении
// на куб она создаёт чёткую границу между гранями, эффект «нарисованного»
// куба без второго меша-обводки (который удвоил бы draw calls).

import * as THREE from 'three';
import { BLOCK_COLORS_HEX } from './config.js';
import { $ } from './utils.js';
import { makeToonMaterial } from './style.js';

//: Сцена, которую заполняем. Устанавливается один раз через initBlocks().
//: До вызова — любой addCube/removeCube упадёт на null. Это осознанно:
//: если такое случилось, значит initBlocks забыли вызвать.
let scene = null;

export function initBlocks(sceneRef) {
  scene = sceneRef;
}

//: Хук, который вызывается после любой мутации набора кубов.
//: По умолчанию ничего не делает. index.html регистрирует здесь
//: resetMinionPath — чтобы Буй пересчитал маршрут после обрушения.
let onCubesChanged = () => {};
export function setOnCubesChanged(fn) {
  onCubesChanged = fn;
}

// --- Текстуры ----------------------------------------------------------
// Канвас-текстуры генерируются один раз при загрузке модуля. Это дешевле,
// чем грузить jpg с сервера, и позволяет обойтись без бинарных ассетов
// в репозитории. Стиль намеренно шершавый: у дерева — прожилки, у железа —
// заклёпки, чтобы материалы различались издалека.
//
// В конце каждой текстуры рисуется чёрная рамка по периметру. При
// наложении на куб она даёт чёткий контур каждой грани — основной
// элемент cartoony-стиля.

function makeWoodTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 22; i++) {
    const y = Math.random() * size;
    ctx.strokeStyle = `rgba(0,0,0,${0.04 + Math.random() * 0.06})`;
    ctx.lineWidth = 1 + Math.random() * 2;
    ctx.beginPath(); ctx.moveTo(0, y);
    for (let x = 0; x <= size; x += 8) ctx.lineTo(x, y + Math.sin(x / 14 + i) * 2.5);
    ctx.stroke();
  }

  for (let i = 0; i < 2; i++) {
    const cx = Math.random() * size, cy = Math.random() * size;
    for (let r = 2; r < 8; r += 2) {
      ctx.strokeStyle = `rgba(0,0,0,${0.08 - r * 0.008})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.ellipse(cx, cy, r * 1.6, r, 0, 0, Math.PI * 2); ctx.stroke();
    }
  }

  // Чёрная рамка по краям — контур грани куба.
  // Толщина 7px от размера 128: при натяжке текстуры на грань рамка
  // занимает ~5% ширины грани. Достаточно, чтобы быть видимой, но не
  // съедает сам рисунок.
  ctx.strokeStyle = 'rgba(26, 20, 16, 0.9)';
  ctx.lineWidth = 7;
  ctx.strokeRect(3.5, 3.5, size - 7, size - 7);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const WOOD_TEXTURE = makeWoodTexture();

function makeIronTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, size, size);

  const grad = ctx.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0.0, 'rgba(255,255,255,0.30)');
  grad.addColorStop(0.5, 'rgba(0,0,0,0.03)');
  grad.addColorStop(1.0, 'rgba(0,0,0,0.20)');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, size, size);

  ctx.strokeStyle = 'rgba(0,0,0,0.055)'; ctx.lineWidth = 1;
  for (let i = -size; i < size * 2; i += 13) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + size, size); ctx.stroke();
  }

  const rivet = (x, y, r) => {
    ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.beginPath(); ctx.arc(x + 0.7, y + 0.7, r, 0, Math.PI * 2); ctx.fill();
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, 0.5, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.6, 'rgba(200,200,200,0.85)');
    g.addColorStop(1, 'rgba(150,150,150,0.85)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.28)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  };
  const R = 6, R2 = 4.5, pad = 13;
  rivet(pad, pad, R); rivet(size - pad, pad, R); rivet(pad, size - pad, R); rivet(size - pad, size - pad, R);
  rivet(size / 2, pad, R2); rivet(size / 2, size - pad, R2); rivet(pad, size / 2, R2); rivet(size - pad, size / 2, R2);

  ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 0.8;
  for (let i = 0; i < 6; i++) {
    const x = 24 + Math.random() * (size - 48);
    const y = 24 + Math.random() * (size - 48);
    const len = 5 + Math.random() * 10;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + len, y + (Math.random() - 0.5) * 3); ctx.stroke();
  }

  // Та же чёрная рамка, что и у дерева — единый стиль всех кубов.
  ctx.strokeStyle = 'rgba(26, 20, 16, 0.9)';
  ctx.lineWidth = 7;
  ctx.strokeRect(3.5, 3.5, size - 7, size - 7);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const IRON_TEXTURE = makeIronTexture();

// --- Разбор данных куба ------------------------------------------------
// Сервер отдаёт cube_type вида 'wood_block', 'iron_triangle'. Форму и
// материал вытаскиваем из этого префикса/суффикса, чтобы не тащить
// отдельные поля и не разъезжаться с CHECK-констрейнтом cubes.shape.

export function effectiveShape(c) {
  const ct = (c && c.cube_type) || '';
  if (ct.endsWith('_half'))     return 'half';
  if (ct.endsWith('_triangle')) return 'triangle';
  if (ct.endsWith('_circle'))   return 'circle';
  return (c && c.shape) || 'block';
}

export function effectiveMaterial(c) {
  const ct = (c && c.cube_type) || '';
  if (ct.startsWith('iron_')) return 'iron';
  return (c && c.material) || 'wood';
}

//: Плита толщиной в один слой? Влияет на вертикальное смещение центра:
//: у плоской плиты центр на четверти высоты, а не на половине.
export function isFlatHalf(shape, sy) { return shape === 'half' && sy <= 1; }

// --- Геометрия ---------------------------------------------------------
// shapeGeometry конструирует BufferGeometry по форме и габаритам блока.
// Для 'triangle' — ручная сборка из 8 треугольников: стандартного примитива
// «клин» в three.js нет.
export function shapeGeometry(shape, sx, sy, sz) {
  if (shape === 'triangle') {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const A  = [-hx, -hy, -hz];
    const B  = [ hx, -hy, -hz];
    const C  = [-hx, -hy,  hz];
    const A2 = [-hx,  hy, -hz];
    const B2 = [ hx,  hy, -hz];
    const C2 = [-hx,  hy,  hz];
    const pos = [], uvs = [];
    function tri(p1, p2, p3, u1, u2, u3) {
      pos.push(p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2]);
      uvs.push(u1[0], u1[1], u2[0], u2[1], u3[0], u3[1]);
    }
    tri(A,  B,  C,  [0,0], [1,0], [0,1]);
    tri(A2, C2, B2, [0,0], [0,1], [1,0]);
    tri(A,  A2, B2, [0,0], [0,1], [1,1]); tri(A,  B2, B,  [0,0], [1,1], [1,0]);
    tri(A,  C,  C2, [0,0], [1,0], [1,1]); tri(A,  C2, A2, [0,0], [1,1], [0,1]);
    tri(B,  B2, C2, [0,0], [0,1], [1,1]); tri(B,  C2, C,  [0,0], [1,1], [1,0]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
    g.computeVertexNormals();
    return g;
  }
  if (shape === 'circle') {
    const g = new THREE.CylinderGeometry(0.5, 0.5, 1, 20, 1);
    g.scale(sx, sy, sz);
    return g;
  }
  if (shape === 'half') {
    if (isFlatHalf('half', sy)) return new THREE.BoxGeometry(sx, sy * 0.5, sz);
    return new THREE.BoxGeometry(sx * 0.5, sy, sz);
  }
  return new THREE.BoxGeometry(sx, sy, sz);
}

//: При нечётном rotation клиент уже прислал мировой AABB в size_x/size_z.
//: Чтобы построить геометрию правильно, локальные размеры надо вернуть
//: в исходную ориентацию (поменять местами обратно).
export function localDims(size_x, size_y, size_z, rotation) {
  if (rotation % 2 === 1) return { sx: size_z, sy: size_y, sz: size_x };
  return { sx: size_x, sy: size_y, sz: size_z };
}

// --- Материал ----------------------------------------------------------
//: Железо без явного цвета выглядит серым, а не «древесным по умолчанию».
//: Это костыль: в идеале color='wood' у железного блока быть не должно,
//: но в старых записях могло остаться.
export function effectiveColorHex(material, color) {
  if (material === 'iron' && (!color || color === 'wood')) return 0x9aa4ad;
  return BLOCK_COLORS_HEX[color] || BLOCK_COLORS_HEX.wood;
}

export function makeCubeMaterial(material, color) {
  const map = (material === 'iron') ? IRON_TEXTURE : WOOD_TEXTURE;
  // makeToonMaterial вместо MeshLambertMaterial: дискретное освещение
  // (3 ступени градиента) даёт «комиксовый» вид. flatShading=true —
  // соседние грани куба не сглаживаются между собой, у каждой грани
  // своя чёткая нормаль. Это важно для toon-стиля: сглаженные нормали
  // размывают градации и убивают эффект.
  return makeToonMaterial({
    map,
    color: new THREE.Color(effectiveColorHex(material, color)),
    flatShading: true,
  });
}

// --- Сцена кубов -------------------------------------------------------
//: Единственный источник правды: id → THREE.Mesh. Живёт до конца сессии,
//: очищается через resetCubes() перед загрузкой нового острова.
export const cubeMeshes = new Map();

//: Клетки «x,z» (через запятую), занятые НАЗЕМНЫМИ кубами. Используется
//: Буйком для навигации: он не умеет ходить по блокам, только вокруг них.
//: export let, потому что rebuildBlockedGround переприсваивает Set целиком.
//: ES-модули дают live-binding: импортирующая сторона видит новое значение.
export let blockedGround = new Set();

//: Вертикальное смещение центра меша от (x, y, z).
//: У обычного куба — половина высоты, у плоской плиты — четверть.
export function cubeCenter(c) {
  const sx = c.size_x || 1, sy = c.size_y || 1, sz = c.size_z || 1;
  const shape = c.shape || effectiveShape(c);
  const yOffset = isFlatHalf(shape, sy) ? sy * 0.25 : sy / 2;
  return { x: c.x + sx / 2, y: c.y + yOffset, z: c.z + sz / 2 };
}

function rebuildBlockedGround() {
  blockedGround = new Set();
  for (const m of cubeMeshes.values()) {
    const c = m.userData.cube;
    const sx = c.size_x || 1, sy = c.size_y || 1, sz = c.size_z || 1;
    if (c.y <= 0 && c.y + sy - 1 >= 0) {
      for (let dx = 0; dx < sx; dx++)
        for (let dz = 0; dz < sz; dz++)
          blockedGround.add((c.x + dx) + ',' + (c.z + dz));
    }
  }
}

function buildCubeMesh(shape, sxWorld, syWorld, szWorld, material, color, rotation) {
  const { sx, sy, sz } = localDims(sxWorld, syWorld, szWorld, rotation);
  const geo = shapeGeometry(shape, sx, sy, sz);
  const mesh = new THREE.Mesh(geo, makeCubeMaterial(material, color));
  if (shape === 'triangle' && rotation) mesh.rotation.y = rotation * Math.PI / 2;
  return mesh;
}

// --- Мутации -----------------------------------------------------------
export function addCube(c) {
  if (cubeMeshes.has(c.id)) return;
  const color = c.color || 'wood';
  const shape = effectiveShape(c);
  const material = effectiveMaterial(c);
  const sx = c.size_x || 1, sy = c.size_y || 1, sz = c.size_z || 1;
  const rotation = ((c.rotation | 0) % 4 + 4) % 4;
  const mesh = buildCubeMesh(shape, sx, sy, sz, material, color, rotation);
  const cc = cubeCenter({ ...c, shape, material, size_x: sx, size_y: sy, size_z: sz });
  mesh.position.set(cc.x, cc.y, cc.z);
  mesh.userData.cube = { ...c, color, shape, material, size_x: sx, size_y: sy, size_z: sz, rotation };
  scene.add(mesh);
  cubeMeshes.set(c.id, mesh);
  paintCube(mesh);
  rebuildBlockedGround();
  onCubesChanged();
}

//: Подкраска «по прочности»: полный HP — базовый цвет, ноль — тёмно-красный.
//: Линейная интерполяция по каналу, без шейдеров — дёшево и наглядно.
//:
//: ВАЖНО: mesh.material — это MeshToonMaterial. У него есть .color, и
//: .copy/.lerp работают так же, как у Lambert. Ничего менять не надо.
export function paintCube(mesh) {
  const c = mesh.userData.cube;
  const ratio = c.max_hp > 0 ? Math.max(0, Math.min(1, c.hp / c.max_hp)) : 0;
  const base = new THREE.Color(effectiveColorHex(c.material, c.color));
  const hurt = new THREE.Color(0x7f1d1d);
  mesh.material.color.copy(base).lerp(hurt, 1 - ratio);
}

export function updateCubeHp(id, hp) {
  const mesh = cubeMeshes.get(id);
  if (!mesh) return;
  mesh.userData.cube.hp = hp;
  paintCube(mesh);
}

export function removeCube(id) {
  const mesh = cubeMeshes.get(id);
  if (!mesh) return;
  scene.remove(mesh);
  mesh.geometry.dispose();
  mesh.material.dispose();
  cubeMeshes.delete(id);
  rebuildBlockedGround();
  onCubesChanged();
}

export function resetCubes() {
  for (const id of [...cubeMeshes.keys()]) removeCube(id);
  rebuildBlockedGround();
}

//: Счётчик кубов в верхнем HUD. Здесь, а не в index.html — чтобы не
//: забыть обновить после мутации.
export function refreshCounters() {
  $('cubes').textContent = cubeMeshes.size;
      }
