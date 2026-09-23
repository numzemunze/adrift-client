// Общий стиль игры: toon-материалы и обводка.
//
// ЧТО ЭТО ДАЁТ
// ------------
// MeshToonMaterial + gradientMap — освещение дискретизируется в 3 ступени,
// как в комиксах или в Borderlands. Тени становятся не размытыми, а
// резкими. Текстуры (дерево, железо) сохраняются.
//
// Плюс доработка текстур в blocks.js — чёрная рамка по краям. Это даёт
// эффект «нарисованных» кубов без второго меша-обводки, который удвоил
// бы число draw calls.
//
// КАК ПРИМЕНЯТЬ
// -------------
// Импортировать makeToonMaterial и заменить в существующем коде
// `new THREE.MeshLambertMaterial({ ... })` на `makeToonMaterial({ ... })`.
// Параметры те же (color, map), плюс опциональный flatShading.

import * as THREE from 'three';

// Кэш градиента: одна текстура на весь проект.
let _gradientTex = null;

// 1D-текстура из 4 пикселей по горизонтали. NearestFilter не даёт
// сглаживать переходы между ступенями — именно это и создаёт
// «комиксовый» вид.
//
// Значения: 0.35 (тень), 0.7 (полутень), 1.0 (свет), 1.0 (для сглаживания
// крайнего пикселя).
export function getToonGradient() {
  if (_gradientTex) return _gradientTex;
  const data = new Uint8Array([
    90,  90,  90,  255,
    180, 180, 180, 255,
    255, 255, 255, 255,
    255, 255, 255, 255,
  ]);
  const tex = new THREE.DataTexture(data, 4, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  _gradientTex = tex;
  return tex;
}

// Создаёт toon-материал. Параметры как у MeshLambertMaterial.
//
// flatShading: true — грани куба плоские, без сглаживания нормалей.
// Для кубической игры это правильно: соседние грани не «затягиваются».
export function makeToonMaterial({ map = null, color = 0xffffff, flatShading = false } = {}) {
  return new THREE.MeshToonMaterial({
    map,
    color,
    gradientMap: getToonGradient(),
    flatShading,
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
