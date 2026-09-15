// src/utils.js
// Общие хелперы: доступ к DOM, тосты, форматирование времени, сетевой слой
// с таймаутом, перевод кодов ошибок сервера в человеческий текст.
//
// Зависимости: только config.js (таймаут), i18n.js (перевод), audio.js (звуки
// для тостов). Обратных зависимостей нет — эти три модуля про utils.js не знают.

import { NET_TIMEOUT_MS } from './config.js';
import { t } from './i18n.js';
import { SFX } from './audio.js';

// --- DOM ---------------------------------------------------------------
export const $ = (id) => document.getElementById(id);

const statusEl = $('status');
const toastEl = $('toast');
export const priceEl = $('price-tag');

// --- Оверлей загрузки --------------------------------------------------
// export let — это live-binding: index.html читает loading прямо в
// обработчике тапов, и всегда видит актуальное значение, без геттера.
export let loading = false;
export const fail = (msg) => { loading = true; statusEl.classList.remove('hidden'); statusEl.firstChild.textContent = msg; };
export const ok = () => { loading = false; statusEl.classList.add('hidden'); };

// --- Тосты -------------------------------------------------------------
let toastTimer = null;
export function toast(msg, kind = 'info') {
  toastEl.textContent = msg;
  toastEl.classList.toggle('error', kind === 'error');
  toastEl.classList.toggle('tip', kind === 'tip');
  toastEl.classList.toggle('warn', kind === 'warn');
  toastEl.classList.remove('hidden');
  requestAnimationFrame(() => toastEl.classList.add('show'));
  clearTimeout(toastTimer);
  const dur = kind === 'error' ? 2600 : (kind === 'warn' ? 3200 : (kind === 'tip' ? 3000 : 1600));
  toastTimer = setTimeout(() => { toastEl.classList.remove('show'); setTimeout(() => toastEl.classList.add('hidden'), 220); }, dur);
  if (kind === 'error') SFX.error();
  else if (kind === 'warn') SFX.warn();
}

// --- Утилиты -----------------------------------------------------------
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

export const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + ':' + String(sec).padStart(2, '0');
  return '0:' + String(sec).padStart(2, '0');
};

// --- Сеть --------------------------------------------------------------
// fetch с жёстким таймаутом. Пока запрос идёт дольше NET_TIMEOUT_MS,
// на экране баннер «нет соединения»; при успехе баннер снимается с
// задержкой 300мс, чтобы не мигал на быстрых запросах после долгого.
let netDownTimer = null;
let netDownShown = false;

function showNetDown() {
  if (netDownShown) return;
  netDownShown = true;
  const el = $('net-banner'); if (el) el.classList.add('show');
}
function hideNetDown() {
  clearTimeout(netDownTimer);
  netDownTimer = setTimeout(() => {
    netDownShown = false;
    const el = $('net-banner'); if (el) el.classList.remove('show');
  }, 300);
}

export async function fetchT(url, opts = {}, ms = NET_TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal });
    hideNetDown();
    return res;
  } catch (e) {
    if (e && (e.name === 'AbortError' || e instanceof TypeError)) showNetDown();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// --- Ошибки ------------------------------------------------------------
// Один switch на весь ErrorCode из app/core/errors.py. Клиент никогда
// не парсит текст с сервера — он ветвит по code и подставляет перевод.
// Неизвестный код — показываем message с сервера или общий 'error'.
export function humanError(e) {
  const code = e && e.code;
  const srv = (e && e.message) || '';
  const d = (e && e.details) || {};
  if (!code && e) {
    if (e.name === 'AbortError') return t('errNetTimeout');
    if (e instanceof TypeError)   return t('errNetDown');
  }
  switch (code) {
    case 'NOT_READY': return t('errNotReady');
    case 'CONFLICT': return t('errConflict');
    case 'VALIDATION_ERROR':
    case 'BAD_REQUEST': return t('errValidation');
    case 'RATE_LIMITED':
      return d.retry_after ? t('errRateLimitedWait', { s: d.retry_after }) : t('errRateLimited');
    case 'INTERNAL_ERROR': return t('errInternal');
    case 'TOKEN_EXPIRED': return t('errTokenExpired');
    case 'TOKEN_INVALID':
    case 'TOKEN_MISSING':
    case 'UNAUTHORIZED': return t('errTokenInvalid');
    case 'PROFILE_MISSING': return t('errProfileMissing');
    case 'CELL_OCCUPIED': return t('errCellOccupied');
    case 'OUT_OF_BOUNDS': return t('errOutOfBounds');
    case 'NO_SUPPORT': return t('errNoSupport');
    case 'CUBE_LIMIT_REACHED':
      return d.limit ? t('errCubeLimitN', { n: d.limit }) : t('errCubeLimit');
    case 'NOT_ENOUGH_ETHER':
      if (d.required != null && d.available != null)
        return t('errNotEnoughEtherAmount', { need: d.required, have: d.available });
      return t('errNotEnoughEther');
    case 'NOT_YOUR_CUBE': return t('errNotYourCube');
    case 'INVALID_CUBE_TYPE': return t('errInvalidCubeType');
    case 'BUILD_ISLAND_BUSY': return t('errIslandBusy');
    case 'SAFE_ZONE_UPGRADE_FORBIDDEN': return t('errSafeZoneUpgrade');
    case 'RAID_NOT_FOUND': return t('errRaidNotFound');
    case 'RAID_ALREADY_FINISHED': return t('errRaidFinished');
    case 'RAID_FORBIDDEN_TARGET': return t('errRaidForbiddenTarget');
    case 'TARGET_SHIELDED':
      return d.seconds_left ? t('errTargetShieldedTime', { time: fmtTime(d.seconds_left) }) : t('errTargetShielded');
    case 'TARGET_IS_SELF': return t('errTargetIsSelf');
    case 'COOLDOWN_ACTIVE':
      return d.seconds_left ? t('errCooldownTime', { time: fmtTime(d.seconds_left) }) : t('errCooldown');
    case 'CUBE_IN_SAFE_ZONE': return t('errCubeInSafeZone');
    case 'FLAG_PROTECTED': return t('errFlagProtected');
    case 'FLAG_ALREADY_DESTROYED': return t('errFlagAlreadyDestroyed');
    case 'CLAIM_TOO_EARLY': return t('errClaimTooEarly');
    case 'IDEMPOTENCY_KEY_REUSED': return t('errIdempotency');
  }
  return srv || t('error');
}
