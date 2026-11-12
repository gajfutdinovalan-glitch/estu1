import { byId, dt } from '../core/format.js';
import { state } from '../core/state.js';

const SOUND_PREFERENCE_KEY = 'uzr_request_sound_enabled';

let notificationsEnabled = localStorage.getItem(SOUND_PREFERENCE_KEY) !== 'false';

let requestSound = null;

let seenRequestIds = new Set();

let notificationQueue = Promise.resolve();

function setupNotifications() {
  requestSound = byId('requestSound');
  updateSoundButton();
}

function bindNotificationEvents() {
  byId('soundToggle').addEventListener('click', async () => {
    notificationsEnabled = !notificationsEnabled;
    localStorage.setItem(SOUND_PREFERENCE_KEY, String(notificationsEnabled));
    updateSoundButton();
    if (!notificationsEnabled) {
      if ('speechSynthesis' in window) speechSynthesis.cancel();
      return;
    }
    await unlockNotificationAudio();
  });
  const unlock = () => {
    if (notificationsEnabled) unlockNotificationAudio();
  };
  document.addEventListener('pointerdown', unlock, {once: true, capture: true});
  document.addEventListener('keydown', unlock, {once: true, capture: true});
}

function updateSoundButton() {
  const button = byId('soundToggle');
  button.textContent = notificationsEnabled ? 'Звук включен' : 'Включить звук';
  button.classList.toggle('enabled', notificationsEnabled);
  button.setAttribute('aria-pressed', String(notificationsEnabled));
}

async function unlockNotificationAudio() {
  if (!requestSound) return;
  try {
    requestSound.volume = 0.9;
    requestSound.currentTime = 0;
    await requestSound.play();
    requestSound.pause();
    requestSound.currentTime = 0;
  } catch (error) {
    console.warn('Звук будет доступен после взаимодействия со страницей.', error);
  }
}

function syncRequestNotifications({announce = false} = {}) {
  const currentIds = new Set(state.requests.map(request => String(request.id)));
  const newRequests = state.requests.filter(request => !seenRequestIds.has(String(request.id)));
  seenRequestIds = currentIds;
  if (announce && notificationsEnabled && newRequests.length) enqueueRequestNotifications(newRequests);
}

function enqueueRequestNotifications(requests) {
  [...requests].sort((a, b) => dt(a.createdAt) - dt(b.createdAt)).forEach(request => {
    notificationQueue = notificationQueue
      .then(() => announceRequest(request))
      .catch(error => console.warn('Не удалось озвучить заявку.', error));
  });
}

async function announceRequest(request) {
  await playRequestSound();
  await speakRequest(request);
}

function playRequestSound() {
  if (!requestSound) return Promise.resolve();
  return new Promise(resolve => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      requestSound.removeEventListener('ended', finish);
      requestSound.removeEventListener('error', finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 7000);
    requestSound.addEventListener('ended', finish);
    requestSound.addEventListener('error', finish);
    requestSound.currentTime = 0;
    requestSound.volume = 0.9;
    requestSound.play().catch(finish);
  });
}

function getRussianVoice() {
  if (!('speechSynthesis' in window)) return null;
  const voices = speechSynthesis.getVoices();
  return voices.find(voice => voice.lang.toLowerCase().startsWith('ru'))
    || voices.find(voice => voice.name.toLowerCase().includes('russian'))
    || null;
}

function speakRequest(request) {
  if (!('speechSynthesis' in window)) return Promise.resolve();
  return new Promise(resolve => {
    const utterance = new SpeechSynthesisUtterance(
      `Новая заявка. Бортовой номер ${request.board}. ${request.description}`.slice(0, 420)
    );
    const voice = getRussianVoice();
    if (voice) utterance.voice = voice;
    utterance.lang = 'ru-RU';
    utterance.rate = 0.92;
    utterance.onend = resolve;
    utterance.onerror = resolve;
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  });
}

function resetNotifications() {
  seenRequestIds = new Set();
}

export { bindNotificationEvents, resetNotifications, setupNotifications, syncRequestNotifications };
