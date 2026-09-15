// src/audio.js
// Звук: WebAudio для эффектов (синтез на лету), HTMLAudioElement для музыки.
//
// Почему не файлы: эффекты (удар, постройка, claim) — короткие, синтез
// из пары осцилляторов звучит чисто и не тянет ни одного килобайта.
// Музыка — наоборот, длинная, и лежит в Supabase Storage как mp3.
//
// Браузеры не дают играть звук до первого тапа игрока (autoplay policy).
// Поэтому audioCtx создаётся лениво, а разблокировка происходит в
// tryUnlockAudio() — она висит на первых pointerdown/touchstart/click/keydown
// в index.html.
//
// Мьют хранится в localStorage под ключом adrift_audio_muted ('1' или '0').
// Затрагивает и эффекты, и музыку — это осознанно, одна кнопка на всё.

import { MUSIC_URLS } from './config.js';

//: Локальный $(id) — не тянем сюда utils.js, чтобы не плодить циклические
//: зависимости. Функция однострочная, дублирование дешевле.
const $ = (id) => document.getElementById(id);

const AUDIO_MUTED_KEY = 'adrift_audio_muted';

//: Общий множитель громкости эффектов. 1.7 — потому что отдельные SFX
//: заданы тихо (0.06–0.15), и без него они звучат почти неслышно
//: на телефонах с тихим динамиком.
const MASTER_VOLUME = 1.7;

//: Громкость музыки. 0.3 — фон, а не концерт; даёт место эффектам.
const MUSIC_VOLUME = 0.3;

let audioCtx = null;
let audioReady = false;
let audioMuted = false;

function ensureAudio() {
  if (audioCtx) return audioCtx;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
  } catch (e) { return null; }
}

//: Вызывается из первого пользовательского жеста. Без него звука не будет
//: вообще: браузер держит AudioContext в состоянии 'suspended'.
export function tryUnlockAudio() {
  const ctx = ensureAudio();
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  audioReady = true;
}

//: Один тон с линейной атакой и экспоненциальным затуханием.
//: slideTo — куда уехать по частоте к концу (для «ударов», «прыжков»).
function tone({ freq, dur = 0.12, type = 'sine', vol = 0.15, slideTo = null, delay = 0 }) {
  if (audioMuted || !audioReady) return;
  const ctx = audioCtx;
  if (!ctx) return;
  const t0 = ctx.currentTime + delay;
  // Клипуем жёстко: MASTER_VOLUME может толкнуть сумму тонов в разнос,
  // а хрип на телефоне — хуже тишины.
  const v = Math.min(0.38, vol * MASTER_VOLUME);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo != null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + dur);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(v, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

//: Готовые звуковые «слова» игры. Каждое — 1-3 тона, ничего больше.
export const SFX = {
  build:    () => { tone({ freq: 220, slideTo: 440, dur: 0.10, type: 'triangle', vol: 0.13 }); },
  demolish: () => { tone({ freq: 320, slideTo: 120, dur: 0.16, type: 'sawtooth', vol: 0.10 }); },
  hit:      () => { tone({ freq: 180, slideTo: 90,  dur: 0.09, type: 'square',   vol: 0.08 }); },
  collapse: () => { tone({ freq: 140, slideTo: 60,  dur: 0.22, type: 'sawtooth', vol: 0.11 }); },
  claim:    () => {
    tone({ freq: 660, dur: 0.08, type: 'sine', vol: 0.11 });
    tone({ freq: 990, dur: 0.10, type: 'sine', vol: 0.09, delay: 0.06 });
  },
  error:    () => { tone({ freq: 240, slideTo: 170, dur: 0.16, type: 'square', vol: 0.09 }); },
  warn:     () => { tone({ freq: 440, dur: 0.10, type: 'triangle', vol: 0.09 }); },
  win:      () => {
    tone({ freq: 523, dur: 0.10, type: 'sine', vol: 0.12 });
    tone({ freq: 659, dur: 0.10, type: 'sine', vol: 0.12, delay: 0.09 });
    tone({ freq: 784, dur: 0.16, type: 'sine', vol: 0.12, delay: 0.18 });
  },
  // Буйка: три голоса — обычный чирик, вопросительный (когда тапнули),
  // панический (когда рейд). Разброс частот рандомный, чтобы не было
  // ощущения заезженной пластинки.
  buoyChirp: () => {
    const base = 420 + Math.random() * 480;
    const up = Math.random() < 0.5;
    const target = up ? base * 1.35 : base * 0.72;
    tone({ freq: base, slideTo: target, dur: 0.08 + Math.random() * 0.06, type: 'triangle', vol: 0.075 });
    if (Math.random() < 0.45) {
      tone({ freq: target, slideTo: base * (0.9 + Math.random() * 0.2), dur: 0.07, type: 'triangle', vol: 0.06, delay: 0.10 });
    }
  },
  buoyQuestion: () => {
    tone({ freq: 620, slideTo: 880, dur: 0.10, type: 'sine', vol: 0.11 });
    tone({ freq: 880, slideTo: 1040, dur: 0.09, type: 'sine', vol: 0.09, delay: 0.10 });
  },
  buoyPanic: () => {
    const base = 820 + Math.random() * 380;
    tone({ freq: base, slideTo: base * 0.45, dur: 0.06, type: 'square', vol: 0.085 });
    if (Math.random() < 0.6) {
      tone({ freq: base * 0.9, slideTo: base * 0.4, dur: 0.055, type: 'square', vol: 0.075, delay: 0.07 });
    }
  },
};

// --- Музыка --------------------------------------------------------------
// musicWantKey — что игрок хочет слышать (не зависит от паузы/фейда).
// currentMusicKey — что реально играет сейчас.
// Это разные вещи: во время перехода между сценами музыка может быть
// в состоянии фейда, но желание остаётся прежним.

let musicWantKey = null;
let currentMusicKey = null;
let currentAudio = null;
let musicStopTimer = null;
let musicFadeTimer = null;

export function playMusic(key) {
  musicWantKey = key;
  if (audioMuted) return;
  _startOrResumeMusic();
}

function _startOrResumeMusic() {
  clearTimeout(musicStopTimer);
  clearInterval(musicFadeTimer);
  musicStopTimer = null;
  musicFadeTimer = null;
  const key = musicWantKey;
  if (!key) return;
  const url = MUSIC_URLS[key];
  if (!url) return;
  if (currentAudio && currentMusicKey === key) {
    currentAudio.volume = MUSIC_VOLUME;
    if (currentAudio.paused) currentAudio.play().catch(() => {});
    return;
  }
  if (currentAudio) {
    try { currentAudio.pause(); currentAudio.src = ''; } catch (e) {}
    currentAudio = null;
    currentMusicKey = null;
  }
  const el = new Audio(url);
  el.loop = true;
  el.volume = MUSIC_VOLUME;
  el.play().catch(() => {});
  currentAudio = el;
  currentMusicKey = key;
}

export function stopMusic() {
  clearTimeout(musicStopTimer);
  clearInterval(musicFadeTimer);
  musicStopTimer = null;
  musicFadeTimer = null;
  musicWantKey = null;
  if (currentAudio) {
    try { currentAudio.pause(); currentAudio.src = ''; } catch (e) {}
    currentAudio = null;
  }
  currentMusicKey = null;
}

function fadeMusicOut(ms) {
  if (!currentAudio) return;
  clearInterval(musicFadeTimer);
  const startVol = currentAudio.volume;
  const t0 = performance.now();
  musicFadeTimer = setInterval(function () {
    if (!currentAudio) { clearInterval(musicFadeTimer); return; }
    const k = Math.min(1, (performance.now() - t0) / ms);
    currentAudio.volume = startVol * (1 - k);
    if (k >= 1) {
      clearInterval(musicFadeTimer);
      stopMusic();
    }
  }, 50);
}

//: Плавно затушить музыку через delayMs. Используется в startGame:
//: менюшная музыка должна затихнуть не сразу, а когда игрок уже играет.
export function scheduleMusicStop(delayMs, fadeMs) {
  clearTimeout(musicStopTimer);
  clearInterval(musicFadeTimer);
  musicStopTimer = setTimeout(function () { fadeMusicOut(fadeMs); }, delayMs);
}

//: Пауза на время, когда вкладка уходит в фон (visibilitychange —
//: можно прицепить позже, если понадобится).
export function pauseMusic() {
  if (currentAudio && !currentAudio.paused) currentAudio.pause();
}

export function resumeMusic() {
  if (audioMuted) return;
  if (!musicWantKey) return;
  _startOrResumeMusic();
}

//: Дёргается на каждом пользовательском жесте: если музыка «залипла»
//: (мобильный браузер часто блокирует play() до явного тапа) — пробуем снова.
export function retryMusic() {
  if (audioMuted) return;
  if (!musicWantKey) return;
  if (currentAudio && !currentAudio.paused) return;
  _startOrResumeMusic();
}

// --- Мьют ----------------------------------------------------------------

function updateSoundIcon() {
  const btn = $('sound-btn'); if (!btn) return;
  btn.textContent = audioMuted ? '🔇' : '🔊';
  btn.style.opacity = audioMuted ? 0.55 : 1;
}

export function loadAudioPref() {
  try { audioMuted = localStorage.getItem(AUDIO_MUTED_KEY) === '1'; } catch (e) {}
  updateSoundIcon();
}

export function toggleAudio() {
  audioMuted = !audioMuted;
  try { localStorage.setItem(AUDIO_MUTED_KEY, audioMuted ? '1' : '0'); } catch (e) {}
  updateSoundIcon();
  if (audioMuted) {
    if (currentAudio) {
      try { currentAudio.pause(); currentAudio.src = ''; } catch (e) {}
      currentAudio = null;
      currentMusicKey = null;
    }
  } else {
    tryUnlockAudio();
    SFX.build();
    if (musicWantKey) playMusic(musicWantKey);
  }
                         }
