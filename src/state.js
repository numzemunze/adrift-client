// src/state.js
// Общее изменяемое состояние игры: единственный источник правды для полей,
// которые читаются и пишутся сразу из нескольких модулей.
//
// Почему объект, а не `export let` + сеттеры: присвоить импортированную
// live-привязку нельзя, а полей здесь 23 и пишутся они из разных мест. Объект
// даёт чтение и запись без сеттера на каждое поле и без риска, что имя сеттера
// столкнётся с игровой функцией — например, setMode живёт в panels.js.

import { BLOCK_SIZES } from './config.js';

export const state = {
  // --- режим и инструменты стройки ---
  mode: 'own',
  buildMode: true,
  demolishMode: false,
  rotationStep: 0,
  vertical: false,

  // --- выбранный блок ---
  selectedSize: BLOCK_SIZES[0],
  selectedShape: 'block',
  selectedMaterial: 'wood',
  selectedBlockColor: 'wood',

  // --- рейд ---
  raidId: null,
  raidFlagState: null,
  flagWasOpen: false,
  targetUser: null,
  attacking: false,

  // --- экономика ---
  econ: { accrued_now: 0, seconds_to_next: 0, ether_balance: 0 },

  // --- флаг ---
  myFlagColor: 'red',
  displayFlagColor: 'red',
  currentFlagHp: 0,
  currentFlagMax: 0,

  // --- мир и меню ---
  myRaidAlert: false,
  myWorldX: null,
  myWorldY: null,
  menuMode: true,
};
