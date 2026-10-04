// src/camera.js
// Анимация перелёта камеры: camAnim/savedCam и их обсчёт в render loop.
//
// Зависит только от scene.js (camera и controls) — обратной связи нет.

import * as THREE from 'three';
import { camera, controls } from './scene.js';

export const camAnim = { active: false, t: 0, dur: 1, fromPos: new THREE.Vector3(), toPos: new THREE.Vector3(), fromTgt: new THREE.Vector3(), toTgt: new THREE.Vector3(), onDone: null };
export const savedCam = { pos: new THREE.Vector3(), tgt: new THREE.Vector3() };
export function animateCamera(toPos, toTgt, dur, onDone) {
  camAnim.active = true; camAnim.t = 0; camAnim.dur = Math.max(0.01, dur);
  camAnim.fromPos.copy(camera.position); camAnim.fromTgt.copy(controls.target);
  camAnim.toPos.copy(toPos); camAnim.toTgt.copy(toTgt);
  camAnim.onDone = onDone || null; controls.enabled = false;
}
export function updateCameraAnim(dt) {
  if (!camAnim.active) return false;
  camAnim.t += dt;
  const k = Math.min(1, camAnim.t / camAnim.dur);
  const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
  camera.position.lerpVectors(camAnim.fromPos, camAnim.toPos, e);
  controls.target.lerpVectors(camAnim.fromTgt, camAnim.toTgt, e);
  if (k >= 1) { camAnim.active = false; const cb = camAnim.onDone; camAnim.onDone = null; if (cb) cb(); }
  return true;
}
