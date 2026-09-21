// ADRIFT Service Worker.
//
// ЕДИНСТВЕННАЯ ЗАДАЧА: показать push-уведомление и открыть игру по тапу.
// Никакого кэширования, никаких offline-стратегий — они превращают SW в
// источник трудноуловимых багов («почему у меня старая версия игры?»),
// а нам нужен только push.
//
// ЖИЗНЕННЫЙ ЦИКЛ
// --------------
// Браузер держит SW запущенным даже когда вкладка закрыта. Он переживает
// перезагрузки, живёт отдельно от игры. Если здесь будет баг — у игроков
// останется старая версия, пока браузер не решит обновиться. Поэтому файл
// максимально простой.

self.addEventListener('install', () => {
  // Активируемся сразу после установки, не ждём закрытия старых вкладок.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Перехватываем контроль над открытыми вкладками сразу.
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    // Сервер всегда шлёт JSON, но на всякий случай не падаем.
    data = { title: 'ADRIFT', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'ADRIFT';
  const options = {
    body: data.body || '',
    // tag: уведомления с одинаковым tag'ом заменяют друг друга, а не
    // копятся стопкой. Три «забери эфир» подряд превратятся в одно.
    tag: data.tag || 'adrift',
    icon: './assets/Untitled72_20260916105743.png',
    badge: './assets/Untitled72_20260916105743.png',
    data: { url: data.url || './' },
    requireInteraction: false,
    renotify: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // Если игра уже открыта хоть в одной вкладке — фокусируем её,
        // не плодим новые. Иначе открываем новую.
        for (const client of clientList) {
          if ('focus' in client) return client.focus();
        }
        if (self.clients.openWindow) return self.clients.openWindow(url);
      })
  );
});
