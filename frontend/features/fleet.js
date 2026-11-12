import { apiRequest } from '../core/api.js';
import { STATUS_META } from '../core/catalog.js';
import { byId, dt, esc, ruDate } from '../core/format.js';
import { refreshFromServer } from '../core/refresh.js';
import { statusBadge } from '../core/request-fields.js';
import { can, state } from '../core/state.js';
import * as RequestFlow from './request-flow.js';

let selectedFleetBoard = '';

function renderFleet() {
  const query = byId('fleetSearch').value.trim().toLowerCase();
  const historyCounts = state.history.reduce((result, item) => {
    if (item.status === 'rejected') return result;
    result[item.board] = (result[item.board] || 0) + 1;
    return result;
  }, {});
  const requestCounts = state.requests.reduce((result, item) => {
    result[item.board] = (result[item.board] || 0) + 1;
    return result;
  }, {});
  const items = state.fleet.filter(item => !query || `${item.board} ${item.model}`.toLowerCase().includes(query));
  if (selectedFleetBoard && !state.fleet.some(item => item.board === selectedFleetBoard)) {
    selectedFleetBoard = '';
  }
  byId('fleetGrid').innerHTML = items.map(item => `
    <button type="button" class="fleet-card ${item.board === selectedFleetBoard ? 'selected' : ''}" data-board="${esc(item.board)}">
      <b>${esc(item.board)}</b>
      <span>${esc(item.model)}</span>
      <span>Заявок: ${requestCounts[item.board] || 0}</span>
      <span>Ремонтов: ${historyCounts[item.board] || 0}</span>
    </button>`).join('');
  document.querySelectorAll('.fleet-card').forEach(card => {
    card.addEventListener('click', () => {
      selectedFleetBoard = card.dataset.board;
      renderFleet();
    });
  });
  renderFleetDetail();
}

function renderFleetDetail() {
  const vehicle = state.fleet.find(item => item.board === selectedFleetBoard);
  if (!vehicle) {
    byId('fleetDetail').innerHTML = '<div class="empty">Выберите машину в парке</div>';
    return;
  }
  const active = state.requests.filter(item => item.board === vehicle.board);
  const history = state.history
    .filter(item => item.board === vehicle.board)
    .sort((a, b) => dt(b.date) - dt(a.date));
  const editor = can('manageFleet')
    ? `<form id="editFleetForm" class="fleet-edit-form">
        <label>Бортовой номер<input name="board" required value="${esc(vehicle.board)}" inputmode="numeric" /></label>
        <label>Модель<input name="model" required value="${esc(vehicle.model)}" /></label>
        <div class="form-actions">
          <button type="submit">Сохранить</button>
          <button type="button" class="ghost danger-action" id="deleteFleetVehicle">Убрать из парка</button>
        </div>
      </form>`
    : `<div class="fleet-readonly-model">${esc(vehicle.model)}</div>`;
  byId('fleetDetail').innerHTML = `
    <div class="section-title"><h2>Борт ${esc(vehicle.board)}</h2><span>Записей истории: ${history.length}</span></div>
    ${editor}
    <div class="fleet-detail-section">
      <h3>Текущие заявки</h3>
      ${active.length ? active.map(item => `<article class="dashboard-request"><div class="summary-head"><b>${esc(item.createdBy || 'Участок')}</b>${statusBadge(item.status)}</div><p class="description">${esc(item.description)}</p></article>`).join('') : '<div class="empty">Активных заявок нет</div>'}
    </div>
    <div class="fleet-detail-section">
      <h3>История ремонтов</h3>
      <div class="compact-list">${history.length ? history.map(item => `<details class="history-card"><summary><b>${ruDate(item.date)}</b> · ${esc(item.description)} · ${esc(STATUS_META[item.status || 'completed']?.label || '')}</summary><div class="meta">${item.completedBy ? `Выполнил: ${esc(item.completedBy)}` : ''}</div><p class="description">${esc(item.workDone || item.description)}</p>${item.note ? `<p class="description">${esc(item.note)}</p>` : ''}${RequestFlow.notes(item.flow) || ''}${RequestFlow.timeline(item.flow) || ''}</details>`).join('') : '<div class="empty">Истории нет</div>'}</div>
    </div>`;
  if (can('manageFleet')) {
    byId('editFleetForm').addEventListener('submit', saveFleetVehicle);
    byId('deleteFleetVehicle').addEventListener('click', deleteFleetVehicle);
  }
}

async function addFleetVehicle(event) {
  event.preventDefault();
  const board = byId('newFleetBoard').value.trim();
  const model = byId('newFleetModel').value.trim();
  try {
    await apiRequest('/fleet', {method: 'POST', body: JSON.stringify({board, model})});
    selectedFleetBoard = board;
    event.target.reset();
    await refreshFromServer(false);
  } catch (error) {
    alert(`Не удалось добавить машину: ${error.message}`);
  }
}

async function saveFleetVehicle(event) {
  event.preventDefault();
  const vehicle = state.fleet.find(item => item.board === selectedFleetBoard);
  if (!vehicle) return;
  const form = new FormData(event.target);
  const payload = {
    board: String(form.get('board')).trim(),
    model: String(form.get('model')).trim()
  };
  try {
    await apiRequest(`/fleet/${encodeURIComponent(vehicle.board)}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    selectedFleetBoard = payload.board;
    await refreshFromServer(false);
  } catch (error) {
    alert(`Не удалось сохранить машину: ${error.message}`);
  }
}

async function deleteFleetVehicle() {
  const vehicle = state.fleet.find(item => item.board === selectedFleetBoard);
  if (!vehicle || !confirm(`Убрать борт ${vehicle.board} из активного парка?`)) return;
  try {
    await apiRequest(`/fleet/${encodeURIComponent(vehicle.board)}`, {method: 'DELETE'});
    selectedFleetBoard = '';
    await refreshFromServer(false);
  } catch (error) {
    alert(`Не удалось убрать машину: ${error.message}`);
  }
}

function compareFleetBoards(left, right) {
  const leftNumber = Number(left.board);
  const rightNumber = Number(right.board);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  return String(left.board).localeCompare(String(right.board), 'ru');
}

export { addFleetVehicle, compareFleetBoards, renderFleet };
