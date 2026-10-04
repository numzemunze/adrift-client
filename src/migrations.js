// src/migrations.js
// Разовая миграция localStorage после переименования ADRIFT → Riftad.
//
// Ключи переехали с префикса adrift_ на riftad_. Без переноса игрок при
// первом заходе после релиза потерял бы всё, что там лежит: access/refresh
// токены (то есть вход), пройденный онбординг, настройки графики и звука,
// преференсы стройки.
//
// Поэтому значения старых ключей переносятся в новые, а старые удаляются.
// Миграция идемпотентна: повторный вызов ничего не меняет, а если старых
// ключей нет — не делает вообще ничего.
//
// Модуль подключается ПЕРВЫМ импортом в index.html, до config.js и audio.js.
// Когда через игру пройдут все активные игроки, файл и его импорт можно
// удалить целиком — это единственное место, где остались старые имена.

//: старый ключ → новый ключ. Порядок не важен.
const KEY_MIGRATION = {
  adrift_token: 'riftad_token',
  adrift_id: 'riftad_id',
  adrift_refresh: 'riftad_refresh',
  adrift_onboarded: 'riftad_onboarded',
  adrift_build_prefs: 'riftad_build_prefs',
  adrift_audio_muted: 'riftad_audio_muted',
  adrift_graphics: 'riftad_graphics',
};

/**
 * Переносит значения старых ключей в новые и удаляет старые.
 *
 * Возвращает список перенесённых старых ключей (для лога и тестов).
 * Никогда не бросает: приватный режим, отключённое хранилище или
 * переполнение квоты не должны ломать загрузку игры — без миграции
 * игрок максимум разлогинится, а без загрузки не поиграет вообще.
 *
 * @param {Storage} [storage] — подменяется в тестах; по умолчанию localStorage.
 */
export function migrateLegacyLocalStorageKeys(storage) {
  const ls = storage || (typeof window !== 'undefined' ? window.localStorage : null);
  if (!ls) return [];

  const migrated = [];
  for (const oldKey of Object.keys(KEY_MIGRATION)) {
    const newKey = KEY_MIGRATION[oldKey];

    let oldValue = null;
    try { oldValue = ls.getItem(oldKey); } catch (e) { break; }
    if (oldValue === null) continue;

    try {
      // Новый ключ главнее: если он уже заполнен, старое значение устарело.
      if (ls.getItem(newKey) === null) ls.setItem(newKey, oldValue);
      ls.removeItem(oldKey);
      migrated.push(oldKey);
    } catch (e) {
      // Запись не удалась (квота и т.п.) — старый ключ намеренно оставляем,
      // чтобы не потерять значение: попробуем в следующий раз.
    }
  }
  return migrated;
}

const migrated = migrateLegacyLocalStorageKeys();
if (migrated.length) {
  console.info('[Riftad] localStorage: перенесены старые ключи →', migrated.join(', '));
}
