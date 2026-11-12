import { apiRequest } from '../core/api.js';
import { byId, compareRequests, dt, esc, ruDate, ruDateTime, todayISO } from '../core/format.js';
import { loadedStateParts, refreshFromServer } from '../core/refresh.js';
import { assigneeOptions, statusBadge, statusOptions } from '../core/request-fields.js';
import { can, state } from '../core/state.js';
import { showBsoToast } from './equipment.js';
import { renderHistory } from './history.js';
import * as Shifts from './shifts.js';
import * as RequestFlow from './request-flow.js';

function renderStats() {
  const today = todayISO();
  const weekAgo = Date.now() - 7 * 864e5;
  const values = [
    ['Активные заявки', state.requests.length],
    ['Новые', state.requests.filter(item => item.status === 'new').length],
    ['В работе', state.requests.filter(item => item.status === 'in_progress').length],
    ['Выполнено сегодня', state.history.filter(item => item.status !== 'rejected' && item.date === today).length],
    ['Выполнено за 7 дней', state.history.filter(item => item.status !== 'rejected' && dt(item.date) >= weekAgo).length]
  ];
  byId('stats').innerHTML = values.map(([label, value]) =>
    `<div class="stat"><b>${value}</b><span>${label}</span></div>`
  ).join('');
}



function renderDashboard() {
  const requests = [...state.requests].sort(compareRequests).slice(0, 8);
  byId('dashboardRequestsCount').textContent = `${state.requests.length} шт.`;
  byId('dashboardRequests').innerHTML = requests.length
    ? requests.map(request => `
      <article class="dashboard-request request-state-${esc(request.status)}">
        <div class="summary-head">
          <div><span class="board">${esc(request.board)}</span><div class="meta">${esc(request.model)} · от участка: ${esc(request.createdBy)}</div></div>
          ${request.status === 'new' && (!RequestFlow || RequestFlow.canAct(request))
            ? `<div class="dashboard-status-controls">${statusBadge(request.status)}<button type="button" class="small-action dashboard-accept-button" data-dashboard-start="${esc(request.id)}" title="Подтвердить и взять в работу">Принять в работу</button></div>`
            : statusBadge(request.status)}
        </div>
        <p class="description">${esc(request.description)}</p>
        <div class="meta">Создано: ${ruDateTime(request.createdAt)} · ${esc(request.createdBy)}</div>
      </article>`).join('')
    : '<div class="empty">Активных заявок нет</div>';
  document.querySelectorAll('[data-dashboard-start]').forEach(button => {
    button.addEventListener('click', confirmDashboardRequest);
  });

  const history = state.history.filter(item => item.status !== 'rejected').sort((a, b) => dt(b.date) - dt(a.date)).slice(0, 8);
  byId('lastDone').innerHTML = history.length
    ? history.map(item => `
      <article class="history-card">
        <div class="history-head">
          <div><span class="board">${esc(item.board)}</span><div class="meta">${ruDate(item.date)}${item.completedBy ? ` · ${esc(item.completedBy)}` : ''}</div></div>
          ${statusBadge(item.status || 'completed')}
        </div>
        <p class="description">${esc(item.workDone || item.description)}</p>
      </article>`).join('')
    : '<div class="empty">Выполненных работ нет</div>';
}

function filteredRequests() {
  const query = byId('activeSearch').value.trim().toLowerCase();
  const status = byId('activeStatus').value;
  const stage = byId('requestFlowStage').value;
  return state.requests.filter(request => {
    const matchesStatus = !status || status === 'all' || request.status === status;
    const haystack = [request.board, request.description, request.createdBy, request.assignedTo]
      .join(' ')
      .toLowerCase();
    return matchesStatus && (!stage || (request.flow?.stage || ({new:'incoming',in_progress:'work',waiting:'wait'}[request.status])) === stage) && (!query || haystack.includes(query));
  }).sort(compareRequests);
}

function requestCard(request) {
  if (RequestFlow) return RequestFlow.card(request);
  const deleteButton = can('deleteRequests')
    ? '<button type="button" class="ghost small-action danger-action" data-action="delete-request">Удалить</button>'
    : '';
  const waitingButton = request.status !== 'waiting'
    ? '<button type="button" class="ghost small-action" data-status="waiting">В ожидание</button>'
    : '';
  const workButton = request.status !== 'in_progress'
    ? '<button type="button" class="ghost small-action" data-status="in_progress">В работу</button>'
    : '';
  const assigned = request.assignedTo ? ` · исполнитель: ${esc(request.assignedTo)}` : '';
  const assigneeDisabled = can('reassignRequests') ? '' : 'disabled';
  return `
    <article class="request-card request-state-${esc(request.status)}" data-id="${esc(request.id)}">
      <div class="request-head">
        <div>
          <span class="board">${esc(request.board)}</span>
          <div class="meta">${esc(request.model)}${assigned} · ${ruDateTime(request.createdAt)}</div>
        </div>
        <div class="request-status">
          ${statusBadge(request.status)}
          <div class="request-actions">
            ${waitingButton}${workButton}
            <button type="button" class="ghost small-action" data-stock-repair="${esc(request.id)}">Запчасти по заявке</button>
            <button type="button" class="ghost small-action" data-action="view-board-history" data-board="${esc(request.board)}">История борта</button>
            <button type="button" class="ghost small-action" data-action="edit-request">Редактировать</button>
            ${deleteButton}
          </div>
        </div>
      </div>
      <p class="description">${esc(request.description)}</p>
      <div class="meta">От участка: ${esc(request.createdBy)}</div>
      <form class="edit-request-form" hidden>
        <div class="edit-grid">
          <label>Бортовой номер<input name="board" list="fleetBoards" required value="${esc(request.board)}" inputmode="numeric" /></label>
          <label>Статус<select name="status">${statusOptions(request.status)}</select></label>
          <label>Исполнитель<select name="assignedUserId" ${assigneeDisabled}>${assigneeOptions(request.department, request.assignedUserId)}</select></label>
        </div>
        <label>Описание неисправности<textarea name="description" required rows="3">${esc(request.description)}</textarea></label>
        <div class="form-actions">
          <button type="submit">Сохранить</button>
          <button type="button" class="ghost" data-action="cancel-edit">Отмена</button>
        </div>
      </form>
      <form class="complete-form">
        <label>Выполненные работы<textarea required rows="3" placeholder="Что выполнено"></textarea></label>
        <button type="submit">Выполнено</button>
      </form>
    </article>`;
}

function renderActive() {
  const requests = filteredRequests();
  byId('activeList').innerHTML = requests.length
    ? requests.map(requestCard).join('')
    : '<div class="empty">Заявок по выбранным условиям нет</div>';
  bindRequestCards();
}

function showBoardHistory(event) {
  const board = event.currentTarget.dataset.board;
  if (!board) return;
  byId('historySearch').value = board;
  byId('dateFrom').value = '';
  byId('dateTo').value = '';
  renderHistory();
  openJournalTab('history');
  byId('historyList').scrollIntoView({behavior: 'smooth', block: 'start'});
}

async function confirmDashboardRequest(event) {
  const request = state.requests.find(item => String(item.id) === String(event.currentTarget.dataset.dashboardStart));
  if (!request || request.status !== 'new') return;
  const payload = {action: 'accept', version: request.flow?.version || 1};
  if (state.currentUser.role === 'executor') payload.assignedUserId = state.currentUser.id;
  event.currentTarget.disabled = true;
  try {
    await apiRequest(`/requests/${encodeURIComponent(request.id)}/decision`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    await refreshFromServer(false);
  } catch (error) {
    event.currentTarget.disabled = false;
    alert(`Не удалось подтвердить заявку: ${error.message}`);
  }
}

function bindRequestCards() {
  document.querySelectorAll('[data-action="edit-request"]').forEach(button => {
    button.addEventListener('click', event => {
      const card = event.target.closest('.request-card');
      card.querySelector('.edit-request-form').hidden = false;
      card.querySelector('.complete-form').hidden = true;
      event.target.hidden = true;
    });
  });
  document.querySelectorAll('[data-action="cancel-edit"]').forEach(button => {
    button.addEventListener('click', event => {
      const card = event.target.closest('.request-card');
      card.querySelector('.edit-request-form').hidden = true;
      const request = state.requests.find(r => r.id === card.dataset.id);
      card.querySelector('.complete-form').hidden = request?.flow ? request.flow.stage !== 'work' : request?.status !== 'in_progress';
      card.querySelector('[data-action="edit-request"]').hidden = false;
    });
  });
  document.querySelectorAll('[data-action="delete-request"]').forEach(button => {
    button.addEventListener('click', deleteRequest);
  });
  document.querySelectorAll('[data-action="view-board-history"]').forEach(button => {
    button.addEventListener('click', showBoardHistory);
  });
  document.querySelectorAll('[data-status]').forEach(button => {
    button.addEventListener('click', changeRequestStatus);
  });
  document.querySelectorAll('.edit-request-form').forEach(form => {
    form.addEventListener('submit', saveEditedRequest);
  });
  document.querySelectorAll('.complete-form').forEach(form => {
    form.addEventListener('submit', completeRequest);
  });
}

async function createRequest(event) {
  event.preventDefault();
  const payload = {
    board: byId('board').value.trim(),
    description: byId('description').value.trim(),
    status: byId('requestStatus').value,
    assignedUserId: null,
    intake: byId('requestIntake').value
  };
  try {
    const created = await apiRequest('/requests', {method: 'POST', body: JSON.stringify(payload)});
    event.target.reset();
    await refreshFromServer(false);
    openJournalTab('active');
    if (typeof showBsoToast === 'function') showBsoToast('Заявка передана: ' + (created.flow?.shiftId ? Shifts.name(created.flow.shiftId) : 'общий профиль заявочного ремонта'));
  } catch (error) {
    alert(`Не удалось создать заявку: ${error.message}`);
  }
}

async function saveEditedRequest(event) {
  event.preventDefault();
  const card = event.target.closest('.request-card');
  const current = state.requests.find(item => item.id === card.dataset.id);
  if (!current) return;
  const form = new FormData(event.target);
  const payload = {
    board: String(form.get('board') || current.board).trim(),
    status: String(form.get('status') || current.status),
    assignedUserId: String(form.get('assignedUserId') || '') || null,
    description: String(form.get('description') || '').trim(),
    flowVersion: current.flow?.version
  };
  try {
    await apiRequest(`/requests/${encodeURIComponent(current.id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    await refreshFromServer(false);
  } catch (error) {
    alert(`Не удалось сохранить заявку: ${error.message}`);
  }
}

async function changeRequestStatus(event) {
  const card = event.target.closest('.request-card');
  const request = state.requests.find(item => item.id === card.dataset.id);
  if (!request) return;
  const payload = {status: event.target.dataset.status};
  if (payload.status === 'in_progress' && state.currentUser.role === 'executor') {
    payload.assignedUserId = state.currentUser.id;
  }
  try {
    await apiRequest(`/requests/${encodeURIComponent(request.id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    await refreshFromServer(false);
  } catch (error) {
    alert(`Не удалось изменить статус: ${error.message}`);
  }
}

async function deleteRequest(event) {
  const request = state.requests.find(item => item.id === event.target.closest('.request-card').dataset.id);
  if (!request || !confirm(`Удалить заявку по борту ${request.board}?`)) return;
  try {
    await apiRequest(`/requests/${encodeURIComponent(request.id)}`, {method: 'DELETE'});
    await refreshFromServer(false);
  } catch (error) {
    alert(`Не удалось удалить заявку: ${error.message}`);
  }
}

async function completeRequest(event) {
  event.preventDefault();
  const card = event.target.closest('.request-card');
  const workDone = event.target.querySelector('textarea').value.trim();
  try {
    await apiRequest(`/requests/${encodeURIComponent(card.dataset.id)}/complete`, {
      method: 'POST',
      body: JSON.stringify({workDone,flowVersion:state.requests.find(r=>r.id===card.dataset.id)?.flow?.version})
    });
    loadedStateParts.history = false;
    await refreshFromServer(false);
  } catch (error) {
    alert(`Не удалось закрыть заявку: ${error.message}`);
  }
}

let openJournalTab;

function initJournal(openTab) {
  openJournalTab = openTab;
}

export { createRequest, initJournal, renderActive, renderDashboard, renderStats };
