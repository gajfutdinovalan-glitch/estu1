import { apiRequest } from '../core/api.js';
import { INFORMER_TYPES } from '../core/catalog.js';
import { byId, esc } from '../core/format.js';
import { can, state } from '../core/state.js';
import { compareFleetBoards } from './fleet.js';

const NAVIGATION_STORAGE_KEY = 'estu_navigation_state_v1';

let navigationRecords = {};

let pendingLocalNavigationRecords = loadNavigationRecords();

const navigationSaveTimers = new Map();

const navigationSaveChains = new Map();

const navigationDirtyBoards = new Set();

let navigationMigrationAttempted = false;

let navigationSaveErrorShown = false;

function loadNavigationRecords() {
  try {
    const parsed = JSON.parse(localStorage.getItem(NAVIGATION_STORAGE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const cleaned = Object.fromEntries(Object.entries(parsed).map(([board, record]) => {
      const {reserve, ...current} = record && typeof record === 'object' ? record : {};
      return [board, current];
    }));
    return cleaned;
  } catch {
    return {};
  }
}

function storePendingNavigationRecords() {
  try {
    if (Object.keys(pendingLocalNavigationRecords).length) {
      localStorage.setItem(NAVIGATION_STORAGE_KEY, JSON.stringify(pendingLocalNavigationRecords));
    } else {
      localStorage.removeItem(NAVIGATION_STORAGE_KEY);
    }
  } catch (error) {
    console.warn('Не удалось сохранить временную копию данных навигации.', error);
  }
}

function normalizeNavigationRecord(record = {}) {
  return {
    informer: INFORMER_TYPES.includes(record.informer) ? record.informer : 'ИР',
    orbita: Boolean(record.orbita || record.ai),
    ai: Boolean(record.ai),
    note: String(record.note || '')
  };
}

function syncNavigationRecordsFromState() {
  const serverRecords = Object.fromEntries(state.navigation.map(record => [
    String(record.board),
    normalizeNavigationRecord(record)
  ]));
  const dirtyRecords = {};
  for (const board of navigationDirtyBoards) {
    if (navigationRecords[board]) dirtyRecords[board] = navigationRecords[board];
  }
  navigationRecords = {...serverRecords, ...pendingLocalNavigationRecords, ...dirtyRecords};
}

async function migrateLocalNavigationRecords() {
  if (navigationMigrationAttempted || !can('manageNavigation')) return;
  const migrationSnapshot = Object.fromEntries(Object.entries(pendingLocalNavigationRecords).map(([board, record]) => [
    board,
    normalizeNavigationRecord(record)
  ]));
  const records = Object.entries(migrationSnapshot).map(([board, record]) => ({
    board,
    ...record
  }));
  if (!records.length) return;
  navigationMigrationAttempted = true;
  try {
    await apiRequest('/navigation/import-local', {
      method: 'POST',
      body: JSON.stringify({records})
    });
    for (const [board, record] of Object.entries(migrationSnapshot)) {
      if (JSON.stringify(normalizeNavigationRecord(pendingLocalNavigationRecords[board])) === JSON.stringify(record)) {
        delete pendingLocalNavigationRecords[board];
      }
    }
    storePendingNavigationRecords();
    navigationMigrationAttempted = false;
  } catch (error) {
    navigationMigrationAttempted = false;
    console.warn('Не удалось перенести локальные данные навигации в SQL.', error);
  }
}

function defaultInformer(vehicle) {
  const boardNumber = Number(vehicle.board);
  const model = String(vehicle.model || '').toLowerCase();
  if (model.includes('маз')) return 'Искра';
  if (boardNumber >= 2300 && boardNumber <= 2340) return 'Селена';
  return 'ИР';
}

function defaultNavigationRecord(vehicle) {
  return {
    informer: defaultInformer(vehicle),
    orbita: false,
    ai: false,
    note: ''
  };
}

function getNavigationRecord(vehicle) {
  const board = String(vehicle.board);
  return {
    ...defaultNavigationRecord(vehicle),
    ...(navigationRecords[board] || {})
  };
}

function setNavigationRecordField(board, field, value) {
  const boardKey = String(board);
  const vehicle = state.fleet.find(item => String(item.board) === boardKey) || {board, model: ''};
  const current = getNavigationRecord(vehicle);
  const next = {...current, [field]: value};
  if (field === 'ai' && value) next.orbita = true;
  navigationRecords[boardKey] = next;
  pendingLocalNavigationRecords[boardKey] = normalizeNavigationRecord(next);
  storePendingNavigationRecords();
  navigationDirtyBoards.add(boardKey);
  clearTimeout(navigationSaveTimers.get(boardKey));
  navigationSaveTimers.set(boardKey, setTimeout(() => {
    persistNavigationRecord(boardKey).catch(error => {
      console.warn('Не удалось сохранить оборудование борта.', error);
      if (!navigationSaveErrorShown) {
        navigationSaveErrorShown = true;
        alert(`Не удалось сохранить данные информаторов: ${error.message}`);
      }
    });
  }, field === 'note' ? 700 : 120));
}

function persistNavigationRecord(board) {
  navigationSaveTimers.delete(board);
  const previous = navigationSaveChains.get(board) || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    const record = normalizeNavigationRecord(navigationRecords[board]);
    const snapshot = JSON.stringify(record);
    const saved = await apiRequest(`/navigation/${encodeURIComponent(board)}`, {
      method: 'PUT',
      body: JSON.stringify(record)
    });
    if (JSON.stringify(normalizeNavigationRecord(navigationRecords[board])) === snapshot) {
      navigationRecords[board] = normalizeNavigationRecord(saved);
      navigationDirtyBoards.delete(board);
      if (JSON.stringify(normalizeNavigationRecord(pendingLocalNavigationRecords[board])) === snapshot) {
        delete pendingLocalNavigationRecords[board];
        storePendingNavigationRecords();
      }
    }
    navigationSaveErrorShown = false;
  });
  navigationSaveChains.set(board, task);
  task.finally(() => {
    if (navigationSaveChains.get(board) === task) navigationSaveChains.delete(board);
  }).catch(() => {});
  return task;
}

function optionTags(values, selected) {
  return values.map(value => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(value)}</option>`).join('');
}

function renderNavigationStats() {
  const records = state.fleet.map(vehicle => getNavigationRecord(vehicle));
  const countInformer = (type) => records.filter(record => record.informer === type).length;
  const values = [
    ['Всего бортов', state.fleet.length],
    ['Селена', countInformer('Селена')],
    ['Искра', countInformer('Искра')],
    ['ИР', countInformer('ИР')],
    ['Орбита', records.filter(record => record.orbita).length],
    ['А/И Орбита', records.filter(record => record.ai).length]
  ];
  byId('navigationStats').innerHTML = values.map(([label, value]) =>
    `<div class="stat"><b>${value}</b><span>${label}</span></div>`
  ).join('');
}

function filteredNavigationFleet() {
  const query = byId('navigationSearch').value.trim().toLowerCase();
  const informer = byId('navigationInformer').value;
  const orbita = byId('navigationOrbita').value;
  return [...state.fleet]
    .filter(vehicle => {
      const record = getNavigationRecord(vehicle);
      const haystack = `${vehicle.board} ${vehicle.model}`.toLowerCase();
      const matchesQuery = !query || haystack.includes(query);
      const matchesInformer = informer === 'all' || record.informer === informer;
      const matchesOrbita = orbita === 'all'
        || (orbita === 'orbita' && record.orbita)
        || (orbita === 'no-orbita' && !record.orbita)
        || (orbita === 'ai' && record.ai)
        || (orbita === 'no-ai' && !record.ai);
      return matchesQuery && matchesInformer && matchesOrbita;
    })
    .sort(compareFleetBoards);
}

function navigationCard(vehicle) {
  const record = getNavigationRecord(vehicle);
  const disabled = can('manageNavigation') ? '' : 'disabled';
  return `
    <article class="navigation-card" data-board="${esc(vehicle.board)}">
      <div class="navigation-card-head">
        <div>
          <span class="board">${esc(vehicle.board)}</span>
          <div class="meta">${esc(vehicle.model)}</div>
        </div>
        <span class="navigation-pill">${esc(record.informer)}</span>
      </div>
      <div class="navigation-pills">
        <span class="navigation-pill ${record.orbita ? 'ok' : 'muted-pill'}">Орбита: ${record.orbita ? 'есть' : 'нет'}</span>
        <span class="navigation-pill ${record.ai ? 'warn' : 'muted-pill'}">А/И Орбита: ${record.ai ? 'да' : 'нет'}</span>
      </div>
      <div class="navigation-controls">
        <label class="navigation-informer-field">Информатор
          <select data-navigation-field="informer" ${disabled}>${optionTags(INFORMER_TYPES, record.informer)}</select>
        </label>
        <label class="navigation-check">
          <input type="checkbox" data-navigation-field="orbita" ${record.orbita ? 'checked' : ''} ${disabled} />
          Орбита
        </label>
        <label class="navigation-check">
          <input type="checkbox" data-navigation-field="ai" ${record.ai ? 'checked' : ''} ${disabled} />
          А/И Орбита
        </label>
      </div>
      <label class="navigation-note-label">Заметка
        <textarea data-navigation-field="note" rows="3" placeholder="Дополнительная информация по оборудованию" ${disabled}>${esc(record.note)}</textarea>
      </label>
    </article>`;
}

function renderNavigation() {
  renderNavigationStats();
  const items = filteredNavigationFleet();
  byId('navigationGrid').innerHTML = items.length
    ? items.map(navigationCard).join('')
    : '<div class="empty">Бортов по выбранным условиям нет</div>';
}

function handleNavigationFieldChange(event) {
  const field = event.target.dataset.navigationField;
  if (!field || !can('manageNavigation')) return;
  if (event.type === 'input' && event.target.tagName !== 'TEXTAREA') return;
  if (event.type === 'change' && event.target.tagName === 'TEXTAREA') return;
  const card = event.target.closest('[data-board]');
  if (!card) return;
  const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
  setNavigationRecordField(card.dataset.board, field, value);
  if (event.target.tagName === 'TEXTAREA') return;
  renderNavigation();
}

export { getNavigationRecord, handleNavigationFieldChange, migrateLocalNavigationRecords, renderNavigation, syncNavigationRecordsFromState };
