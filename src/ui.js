// UI-анимации: ripple на кнопках, spring-появление панелей, пульсация
// счётчиков.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ
// ----------------------
// Все эти эффекты — про DOM, а не про игру. Держать их в index.html
// значит утонуть в CSS и JS посреди игровой логики. Здесь — единый
// словарь «как сделать сочно».
//
// ВСЁ ЧИСТО НА CSS ГДЕ ВОЗМОЖНО
// -----------------------------
// Ripple: одна динамическая кнопка-псевдо-элемент через Web Animations API.
// Spring-pop: одна функция, добавляющая класс с animationend.
// Counter-pulse: один класс, включающий keyframes.

// Ripple на кнопке: круг, расширяющийся из точки тапа. По завершении
// элемент удаляется. Дёшево и выглядит «сочнее» чем любой CSS :active.
export function attachRipple(el, color = 'rgba(255,255,255,.35)') {
  if (!el || el.__rippleAttached) return;
  el.__rippleAttached = true;

  // Обязательно: обрезать ripple за границами кнопки.
  // Вставляем inline, потому что у разных кнопок разные border-radius,
  // и переопределять в CSS было бы дольше.
  if (getComputedStyle(el).position === 'static') {
    el.style.position = 'relative';
  }
  el.style.overflow = 'hidden';

  el.addEventListener('pointerdown', (ev) => {
    const rect = el.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const r = Math.hypot(
      Math.max(x, rect.width - x),
      Math.max(y, rect.height - y),
    );

    const ripple = document.createElement('span');
    ripple.className = 'ui-ripple';
    ripple.style.left = x + 'px';
    ripple.style.top = y + 'px';
    ripple.style.width = ripple.style.height = (r * 2) + 'px';
    ripple.style.background = color;
    el.appendChild(ripple);

    ripple.addEventListener('animationend', () => ripple.remove());
  });
}

// Применить ripple ко всем кнопкам в документе. Вызывать один раз при
// старте, после того как DOM готов.
export function attachRippleToAll(selector = 'button') {
  document.querySelectorAll(selector).forEach((el) => {
    if (el.id === 'menu-play' || el.classList.contains('menu-play')) {
      attachRipple(el, 'rgba(255,255,255,.5)');
    } else {
      attachRipple(el);
    }
  });
}

// Spring-pop: добавляет элементу класс, который делает короткий «прыжок»
// (scale 0.95 → 1.05 → 1). Используется при появлении экранов и при
// открытии панелей.
export function popIn(el) {
  if (!el) return;
  el.classList.remove('ui-pop');
  void el.offsetWidth;   // reflow: сброс анимации
  el.classList.add('ui-pop');
  el.addEventListener('animationend', function handler() {
    el.classList.remove('ui-pop');
    el.removeEventListener('animationend', handler);
  });
}

// Пульс счётчика: короткий «толчок» цифры при изменении. Вызывается на
// элементы вроде #ether, #cubes.
export function pulseCounter(el) {
  if (!el) return;
  el.classList.remove('ui-pulse');
  void el.offsetWidth;
  el.classList.add('ui-pulse');
  el.addEventListener('animationend', function handler() {
    el.classList.remove('ui-pulse');
    el.removeEventListener('animationend', handler);
  });
}

// Поочерёдное появление секций экрана: каждый ребёнок получает
// animation-delay в зависимости от индекса. Даёт «каскадный» вход экрана.
export function staggerChildren(parent, stepMs = 40) {
  if (!parent) return;
  const children = parent.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    child.style.animationDelay = (i * stepMs) + 'ms';
    child.classList.add('ui-stagger');
  }
}
