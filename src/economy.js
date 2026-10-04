// src/economy.js
// Экономика: отрисовка счётчика Эфира, загрузка ставок, забор накопленного
// и таймеры, которые тикают счётчик между запросами к серверу.
//
// Зависимости только «вниз»: state.js, auth.js и уже существующие модули.
// Таймеры переезжают сюда вместе с функциями: в index.html они регистрировались
// в середине тела модуля, то есть тоже до auth() — порядок не изменился.

import { $, toast, fmtTime, humanError } from './utils.js';
import { pulseCounter } from './ui.js';
import { t } from './i18n.js';
import { SFX } from './audio.js';
import { api, token } from './auth.js';
import { state } from './state.js';

export function renderEconomy() {
  const btn = $('claim-btn'), hint = $('claim-hint');
  if (state.econ.accrued_now >= 1) { btn.classList.add('ready'); hint.textContent = '+' + state.econ.accrued_now; }
  else { btn.classList.remove('ready'); hint.textContent = fmtTime(state.econ.seconds_to_next); }
}
export async function loadEconomy() {
  try {
    state.econ = await api('/api/v1/economy/rates');
    $('ether').textContent = state.econ.ether_balance;
    pulseCounter($('ether'));
    renderEconomy();
  } catch (e) {
    if (state.econ.seconds_to_next <= 0) {
      state.econ.seconds_to_next = 30;
      renderEconomy();
    }
  }
}
export async function claimEther() {
  if (state.econ.accrued_now < 1) return;
  try {
    const res = await api('/api/v1/economy/claim', { method: 'POST' });
    $('ether').textContent = res.ether_balance;
    pulseCounter($('ether'));
    toast('+' + res.claimed + ' ' + t('ether'), 'tip');
    SFX.claim();
    await loadEconomy();
  } catch (e) {
    if (e.code === 'CLAIM_TOO_EARLY') { await loadEconomy(); return; }
    toast(humanError(e), 'error');
  }
}
setInterval(() => { if (!token) return; if (state.econ.accrued_now >= 1) return; if (state.econ.seconds_to_next > 0) { state.econ.seconds_to_next -= 1; renderEconomy(); } else loadEconomy(); }, 1000);
setInterval(() => { if (token) loadEconomy(); }, 30000);
