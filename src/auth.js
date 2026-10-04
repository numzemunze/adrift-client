// src/auth.js
// Аутентификация: вход через Google OAuth (Supabase), хранение сессии и
// обёртка api() над бэкендом.
//
// token и myId экспортируются как live-привязки (`export let`): снаружи их
// только читают, а пишет их исключительно этот модуль — поэтому сеттеры не
// нужны, а читатели всегда видят актуальное значение.

import { SUPABASE_URL, SUPABASE_ANON_KEY, API_URL } from './config.js';
import { $, fetchT } from './utils.js';
import { t } from './i18n.js';

export let token = null;
export let myId = null;

export async function signIn() {
  throw new Error('Use signInWithGoogle()');
}

export function signInWithGoogle() {
  const redirectTo = encodeURIComponent(window.location.origin + window.location.pathname);
  const url = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${redirectTo}`;
  window.location.href = url;
}

//: Разбор base64url из JWT. Внутренний хелпер handleOAuthCallback.
function base64UrlDecode(str) {
  const padding = '='.repeat((4 - (str.length % 4)) % 4);
  const base64 = (str + padding).replace(/-/g, '+').replace(/_/g, '/');
  return atob(base64);
}

export function handleOAuthCallback() {
  const hash = window.location.hash;
  if (!hash || hash.length < 2) return false;

  const params = new URLSearchParams(hash.slice(1));
  const accessToken = params.get('access_token');
  if (!accessToken) return false;

  token = accessToken;

  try {
    const payload = JSON.parse(base64UrlDecode(token.split('.')[1]));
    myId = payload.sub || null;
  } catch (e) { myId = null; }

  const refreshToken = params.get('refresh_token');
  if (refreshToken) {
    try { localStorage.setItem('riftad_refresh', refreshToken); } catch (e) {}
  }

  if (myId) {
    try {
      localStorage.setItem('riftad_token', token);
      localStorage.setItem('riftad_id', myId);
    } catch (e) {}
  }

  history.replaceState(null, '', window.location.pathname + window.location.search);
  return true;
}

export function clearSession() {
  token = null;
  myId = null;
  try {
    localStorage.removeItem('riftad_token');
    localStorage.removeItem('riftad_id');
    localStorage.removeItem('riftad_refresh');
  } catch (e) {}
}

export const AUTH_ERRORS = ['TOKEN_EXPIRED','TOKEN_INVALID','TOKEN_MISSING','UNAUTHORIZED'];

export async function refreshSession() {
  let refreshToken;
  try { refreshToken = localStorage.getItem('riftad_refresh'); } catch (e) { return false; }
  if (!refreshToken) return false;

  try {
    const res = await fetchT(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!res.ok) return false;

    const data = await res.json();
    if (!data.access_token) return false;

    token = data.access_token;
    try {
      localStorage.setItem('riftad_token', token);
      if (data.refresh_token) localStorage.setItem('riftad_refresh', data.refresh_token);
    } catch (e) {}

    return true;
  } catch (e) {
    return false;
  }
}

export async function api(path, options = {}) {
  const res = await fetchT(API_URL + path, {
    ...options,
    headers: { 'Authorization':`Bearer ${token}`, 'Content-Type':'application/json', ...(options.headers||{}) },
  });
  const text = await res.text();
  let body = null;
  if (text) { try { body = JSON.parse(text); } catch (e) { body = null; } }
  if (!res.ok) {
    const err = new Error(body?.error?.message || res.statusText);
    err.code = body?.error?.code || ('HTTP_' + res.status);
    err.details = body?.error?.details;

    if (AUTH_ERRORS.includes(err.code) && !options.__retried) {
      const refreshed = await refreshSession();
      if (refreshed) {
        return api(path, { ...options, __retried: true });
      }
      clearSession();
      showGoogleLogin();
      throw err;
    }
    throw err;
  }
  return body;
}

export async function auth() {
  if (handleOAuthCallback()) return;

  const saved = localStorage.getItem('riftad_token');
  const savedId = localStorage.getItem('riftad_id');
  if (saved && savedId) {
    token = saved; myId = savedId;
    try {
      await api('/api/v1/build/catalog');
      return;
    } catch (e) {
      if (!AUTH_ERRORS.includes(e.code)) throw e;
    }
  }

  showGoogleLogin();
  throw new Error('AUTH_REQUIRED');
}

export function showGoogleLogin() {
  const menu = $('menu-screen');
  menu.classList.remove('hidden');
  menu.classList.remove('fading');
  if ($('google-login-btn')) return;

  const btn = document.createElement('button');
  btn.id = 'google-login-btn';
  btn.className = 'menu-play';
  btn.style.marginTop = '16px';
  btn.innerHTML =
  '<svg width="18" height="18" viewBox="0 0 48 48" style="margin-right:10px" xmlns="http://www.w3.org/2000/svg">' +
    '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>' +
    '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>' +
    '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>' +
    '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>' +
  '</svg>' +
  t('googleLogin');
  btn.addEventListener('click', signInWithGoogle);
  menu.appendChild(btn);

  const play = $('menu-play');
  if (play) play.disabled = true;
}
