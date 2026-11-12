import { apiRequest } from '../core/api.js';
import { byId, dt, esc, ruDate } from '../core/format.js';
import { refreshFromServer } from '../core/refresh.js';
import { statusBadge } from '../core/request-fields.js';
import { can, state } from '../core/state.js';
import * as RequestFlow from './request-flow.js';

function filteredHistory() {
  const query = byId('historySearch').value.trim().toLowerCase();
  const from = byId('dateFrom').value;
  const to = byId('dateTo').value;
  return state.history
    .filter(item => {
      const matchesDate = (!from || item.date >= from) && (!to || item.date <= to);
      const haystack = [item.board, item.model, item.description, item.workDone, item.completedBy]
        .join(' ')
        .toLowerCase();
      return matchesDate && (!query || haystack.includes(query));
    })
    .sort((a, b) => dt(b.date) - dt(a.date));
}

function historyCard(item) {
  const actions = can('manageHistory')
    ? `<div class="request-actions">
        <button type="button" class="ghost small-action" data-action="edit-history">Редактировать</button>
        <button type="button" class="ghost small-action danger-action" data-action="delete-history">Удалить</button>
      </div>`
    : '';
  const editForm = can('manageHistory')
    ? `<form class="edit-history-form" hidden>
        <div class="edit-grid">
          <label>Борт<input name="board" list="fleetBoards" value="${esc(item.board)}" required /></label>
          <label>Дата<span class="date-input-shell"><input name="date" type="date" value="${esc(item.date)}" required /><button type="button" class="date-picker-button" aria-label="Открыть календарь"><img src="assets/calendar-icon.png?v=20260723" alt="" /></button></span></label>
          <label>Источник<input name="source" value="${esc(item.source || '')}" /></label>
        </div>
        <label>Неисправность<textarea name="description" rows="3" required>${esc(item.description)}</textarea></label>
        <label>Выполненные работы<textarea name="workDone" rows="3">${esc(item.workDone || '')}</textarea></label>
        <label>Примечание<textarea name="note" rows="2">${esc(item.note || '')}</textarea></label>
        <div class="form-actions">
          <button type="submit">Сохранить</button>
          <button type="button" class="ghost" data-action="cancel-history">Отмена</button>
        </div>
      </form>`
    : '';
  return `
    <article class="history-card" data-id="${esc(item.id)}">
      <div class="history-head">
        <div><span class="board">${esc(item.board)}</span><div class="meta">${ruDate(item.date)} · ${esc(item.model)}</div></div>
        <div class="request-status">${statusBadge(item.status || 'completed')}${actions}</div>
      </div>
      <p class="description">${esc(item.workDone || item.description)}</p>
      <div class="meta">Источник: ${esc(item.source || 'журнал')}${item.completedBy ? ` · выполнил: ${esc(item.completedBy)}` : ''}</div>
      ${item.note ? `<p class="description">${esc(item.note)}</p>` : ''}
      ${RequestFlow.notes(item.flow) || ''}
      ${RequestFlow.timeline(item.flow) || ''}
      ${editForm}
    </article>`;
}

function renderHistory() {
  const items = filteredHistory().slice(0, 300);
  byId('historyList').innerHTML = items.length
    ? items.map(historyCard).join('')
    : '<div class="empty">Ничего не найдено</div>';
  bindHistoryCards();
}

function bindHistoryCards() {
  document.querySelectorAll('[data-action="edit-history"]').forEach(button => {
    button.addEventListener('click', event => {
      event.target.closest('.history-card').querySelector('.edit-history-form').hidden = false;
      event.target.hidden = true;
    });
  });
  document.querySelectorAll('[data-action="cancel-history"]').forEach(button => {
    button.addEventListener('click', event => {
      const card = event.target.closest('.history-card');
      card.querySelector('.edit-history-form').hidden = true;
      card.querySelector('[data-action="edit-history"]').hidden = false;
    });
  });
  document.querySelectorAll('[data-action="delete-history"]').forEach(button => {
    button.addEventListener('click', deleteHistory);
  });
  document.querySelectorAll('.edit-history-form').forEach(form => {
    form.addEventListener('submit', saveHistory);
  });
}

async function saveHistory(event) {
  event.preventDefault();
  const card = event.target.closest('.history-card');
  const payload = Object.fromEntries(new FormData(event.target).entries());
  try {
    await apiRequest(`/history/${encodeURIComponent(card.dataset.id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    await refreshFromServer(false);
  } catch (error) {
    alert(`Не удалось сохранить историю: ${error.message}`);
  }
}

async function deleteHistory(event) {
  const card = event.target.closest('.history-card');
  const item = state.history.find(entry => entry.id === card.dataset.id);
  if (!item || !confirm(`Удалить запись истории по борту ${item.board}?`)) return;
  try {
    await apiRequest(`/history/${encodeURIComponent(item.id)}`, {method: 'DELETE'});
    await refreshFromServer(false);
  } catch (error) {
    alert(`Не удалось удалить запись: ${error.message}`);
  }
}

export { renderHistory };
