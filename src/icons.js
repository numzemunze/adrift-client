// src/icons.js
// Инлайновые SVG-иконки HUD.
//
// Все иконки одного формата: viewBox 24×24, обводка currentColor толщиной 2,
// скруглённые стыки. Цвет задаётся снаружи через CSS (`color`), внутри SVG
// ничего не захардкожено — поэтому одна и та же иконка годится и для тёмного
// состояния `.ready`, и для цветных вариантов `.pill-ether` и т.п.
//
// Вставка в разметку происходит ОДИН раз при загрузке (mountIcons в boot):
// счётчики обновляются десятки раз в секунду, и перерисовка SVG на каждом
// тике была бы лишней работой для DOM.

const wrap = (body) =>
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  body +
  '</svg>';

export const ICONS = {
  // Молния — накопленный Эфир.
  ether: wrap('<path d="M13.2 2.2 5 13.4h5.3L9.8 21.8l8.4-11.6h-5.3l.3-8Z"/>'),

  // Куб в изометрии: верхняя грань, два вертикальных ребра.
  cubes: wrap(
    '<path d="M12 2.6 20.4 7.4v9.2L12 21.4 3.6 16.6V7.4L12 2.6Z"/>' +
    '<path d="M3.6 7.4 12 12.2l8.4-4.8"/>' +
    '<path d="M12 12.2v9.2"/>'
  ),

  // Полотнище на древке.
  flag: wrap('<path d="M5.5 21.2V3.4"/><path d="M5.5 4.6h12l-2.4 3.9 2.4 3.9h-12"/>'),

  // Силуэт головы — профиль игрока.
  profile: wrap('<circle cx="12" cy="8.2" r="3.7"/><path d="M4.8 20.3a7.2 7.2 0 0 1 14.4 0"/>'),

  // Шестерёнка — настройки.
  settings: wrap(
    '<circle cx="12" cy="12" r="3.1"/>' +
    '<circle cx="12" cy="12" r="7.4"/>' +
    '<path d="M12 1.9v2.7M12 19.4v2.7M1.9 12h2.7M19.4 12h2.7' +
    'M4.9 4.9l1.9 1.9M17.2 17.2l1.9 1.9M19.1 4.9l-1.9 1.9M6.8 17.2l-1.9 1.9"/>'
  ),

  // Глаз — цель рейда или визита.
  target: wrap(
    '<path d="M2.6 12S6.2 5.5 12 5.5 21.4 12 21.4 12 17.8 18.5 12 18.5 2.6 12 2.6 12Z"/>' +
    '<circle cx="12" cy="12" r="3"/>'
  ),
};

/**
 * Подставляет SVG в каждый элемент с data-icon. Вызывается один раз в boot.
 * Возвращает число заполненных контейнеров — удобно для теста.
 */
export function mountIcons(root = document) {
  let mounted = 0;
  for (const el of root.querySelectorAll('[data-icon]')) {
    const svg = ICONS[el.dataset.icon];
    if (!svg) continue;
    el.innerHTML = svg;
    mounted++;
  }
  return mounted;
}
