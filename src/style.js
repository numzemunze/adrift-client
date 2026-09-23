// src/style.js
// Общий toon-стиль игры: 3-ступенчатый градиент + опциональная
// inverted-hull обводка для крупных объектов.
//
// ВАЖНО ПРО flatShading
// ---------------------
// В three.js r160 у MeshToonMaterial больше нет свойства flatShading.
// Передача его в конструктор вызывает warning в консоли:
//   "THREE.Material: 'flatShading' is not a property of THREE.MeshToonMaterial."
// Функционально параметр игнорировался, но засорял консоль.
//
// На вид это не влияет: у BoxGeometry грани уже плоские (у каждой грани
// свои нормали), а toon-эффект создаётся через gradientMap, а не через
// flatShading. Для цилиндров (столб флага) грани чуть сгладятся — на
// масштабе игры незаметно.
//
// Параметр flatShading в деструктуризации оставлен, чтобы вызовы
// makeToonMaterial({ ..., flatShading: true }) в blocks.js и index.html
// не падали и не нужно было править десять мест. Значение просто
// игнорируется.

import * as THREE from 'three';

// Кэш градиента: одна текстура на весь проект. DataTexture с 4 пикселями
// по горизонтали, NearestFilter — переходы между ступенями резкие,
// это и создаёт «комиксовый» вид.

let _gradientTex = null;

export function getToonGradient() {
  if (_gradientTex) return _gradientTex;
  const data = new Uint8Array([
    90,  90,  90,  255,   // тень
    180, 180, 180, 255,   // полутень
    255, 255, 255, 255,   // свет
    255, 255, 255, 255,   // край (для сглаживания последнего пикселя)
  ]);
  const tex = new THREE.DataTexture(data, 4, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  _gradientTex = tex;
  return tex;
}

// Создаёт toon-материал.
//
// flatShading в списке параметров есть, но в конструктор НЕ передаётся —
// см. комментарий в шапке. Ключ оставлен только чтобы старые вызовы
// { flatShading: true } не ломали сигнатуру.
export function makeToonMaterial({ map = null, color = 0xffffff, flatShading = false } = {}) {
  void flatShading;
  return new THREE.MeshToonMaterial({
    map,
    color,
    gradientMap: getToonGradient(),
  });
}

// Inverted-hull обводка. Возвращает меш, который надо добавить как child
// к основному — он унаследует позицию и поворот.
//
// Для кубов НЕ применять: 256 кубов × 2 = 512 мешей, мобильный не потянет.
// Только для крупных объектов: миньон, флаг.
export function makeOutlineMesh(geometry, thickness = 1.05, color = 0x1a1410) {
  const mat = new THREE.MeshBasicMaterial({
    color,
    side: THREE.BackSide,
  });
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.scale.setScalar(thickness);
  return mesh;
}
