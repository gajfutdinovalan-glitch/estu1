import { apiRequest } from '../core/api.js';

const STATUS = {
  green: {label: 'Работает', short: 'OK'},
  red: {label: 'Не работает утром и вечером', short: 'НЕТ'},
  yellow_morning: {label: 'Не работала утром', short: 'У'},
  yellow_evening: {label: 'Не работала вечером', short: 'В'},
  incomplete: {label: 'Нет полного комплекта отчётов', short: '—'}
};
const state = {data: null, initialized: false, loading: false, settingsLoaded: false, horizontalResizeObserver: null, renderSignature: ''};
const DATE_FILTER_STORAGE_KEY = 'estu.navControl.dateFilter';
const el = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[char]));
const dateRu = value => value ? new Date(`${value}T00:00:00`).toLocaleDateString('ru-RU', {day: '2-digit', month: '2-digit'}) : '—';
const dateTimeRu = value => value ? new Date(value).toLocaleString('ru-RU') : 'ещё не выполнялась';
const dateInputValue = value => [
  value.getFullYear(),
  String(value.getMonth() + 1).padStart(2, '0'),
  String(value.getDate()).padStart(2, '0')
].join('-');

function defaultDates() {
  try {
    const saved = JSON.parse(localStorage.getItem(DATE_FILTER_STORAGE_KEY) || 'null');
    if (/^\d{4}-\d{2}-\d{2}$/.test(saved?.from) && /^\d{4}-\d{2}-\d{2}$/.test(saved?.to)) {
      el('navControlFrom').value = saved.from;
      el('navControlTo').value = saved.to;
      return;
    }
  } catch {
    localStorage.removeItem(DATE_FILTER_STORAGE_KEY);
  }
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 13);
  el('navControlTo').value = dateInputValue(to);
  el('navControlFrom').value = dateInputValue(from);
}

function saveDates() {
  localStorage.setItem(DATE_FILTER_STORAGE_KEY, JSON.stringify({
    from: el('navControlFrom').value,
    to: el('navControlTo').value
  }));
}

function setBusy(busy) {
  state.loading = busy;
  ['navControlRefresh', 'navControlSync', 'navControlFile'].forEach(id => {
    const target = el(id);
    if (target) target.disabled = busy;
  });
}

async function refresh() {
  if (state.loading) return;
  if (!el('navControlFrom').value) defaultDates();
  setBusy(true);
  try {
    const query = new URLSearchParams({from: el('navControlFrom').value, to: el('navControlTo').value});
    const nextData = await apiRequest(`/nav-control?${query}`);
    const nextSignature = JSON.stringify(nextData);
    state.data = nextData;
    if (nextSignature !== state.renderSignature) {
      state.renderSignature = nextSignature;
      render();
    }
  } catch (error) {
    el('navControlMatrix').innerHTML = `<div class="nav-control-empty">${escapeHtml(error.message)}</div>`;
    throw error;
  } finally {
    setBusy(false);
  }
}

function renderNavigationStats() {
  const stats = state.data?.stats || {};
  el('navControlStats').innerHTML = [
    [`Бортов в парке${stats.reportDate ? ` · ${dateRu(stats.reportDate)}` : ''}`, stats.fleet ?? 0, 'fleet'],
    ['Работает', stats.working ?? 0, 'ok'],
    ['Есть неисправность', stats.problem ?? 0, 'warning'],
    ['Нет полного отчёта', stats.incomplete ?? 0, 'muted']
  ].map(([label, value, kind]) => `<div class="stat nav-control-stat ${kind}"><span>${label}</span><b>${value}</b></div>`).join('');
}

function filteredBoards() {
  const query = (el('navControlSearch').value || '').trim().toLocaleLowerCase('ru-RU');
  const problemsOnly = el('navControlProblemsOnly').checked;
  return (state.data?.boards || []).filter(item => {
    const matches = !query || `${item.board} ${item.model}`.toLocaleLowerCase('ru-RU').includes(query);
    return matches && (!problemsOnly || item.red > 0 || item.yellow > 0 || item.currentStreak > 0);
  });
}

function entryTitle(board, entry) {
  const details = [
    `Борт ${board}`,
    new Date(`${entry.date}T00:00:00`).toLocaleDateString('ru-RU'),
    STATUS[entry.status]?.label || entry.status
  ];
  if (entry.morningRoute) details.push(`Утро, маршрут: ${entry.morningRoute}`);
  if (entry.morningComment) details.push(`Утро: ${entry.morningComment}`);
  if (entry.eveningRoute) details.push(`Вечер, маршрут: ${entry.eveningRoute}`);
  if (entry.eveningComment) details.push(`Вечер: ${entry.eveningComment}`);
  return details.join('\n');
}

function syncMatrixSliders() {
  const matrix = el('navControlMatrix');
  const horizontal = el('navControlHorizontalSlider');
  const horizontalBox = el('navControlHorizontalSliderBox');
  const vertical = el('navControlVerticalSlider');
  const verticalBox = el('navControlVerticalSliderBox');
  if (!matrix || !horizontal || !horizontalBox || !vertical || !verticalBox) return;

  const horizontalMaximum = Math.max(0, matrix.scrollWidth - matrix.clientWidth);
  horizontal.max = String(Math.ceil(horizontalMaximum));
  horizontal.value = String(Math.min(horizontalMaximum, matrix.scrollLeft));
  horizontal.disabled = horizontalMaximum === 0;
  horizontalBox.classList.toggle('disabled', horizontalMaximum === 0);

  const verticalMaximum = Math.max(0, matrix.scrollHeight - matrix.clientHeight);
  vertical.max = String(Math.ceil(verticalMaximum));
  vertical.value = String(Math.min(verticalMaximum, matrix.scrollTop));
  vertical.disabled = verticalMaximum === 0;
  verticalBox.classList.toggle('disabled', verticalMaximum === 0);
}

function scheduleMatrixSlidersSync() {
  requestAnimationFrame(syncMatrixSliders);
}

function renderMatrix() {
  const boards = filteredBoards();
  const days = state.data?.days || [];
  if (!boards.length) {
    el('navControlMatrix').innerHTML = '<div class="nav-control-empty">Борты по выбранному фильтру не найдены.</div>';
    scheduleMatrixSlidersSync();
    return;
  }
  const head = days.map(day => `<th title="${escapeHtml(new Date(`${day}T00:00:00`).toLocaleDateString('ru-RU'))}">${dateRu(day)}</th>`).join('');
  const rows = boards.map(item => `
    <tr>
      <th class="nav-control-board"><b>${escapeHtml(item.board)}</b><small>${escapeHtml(item.model)}</small></th>
      ${item.entries.map(entry => `<td><span class="nav-status-cell ${entry.status}" title="${escapeHtml(entryTitle(item.board, entry))}">${STATUS[entry.status]?.short || '?'}</span></td>`).join('')}
      <td class="nav-control-total"><b>${item.red + item.yellow}</b><small>${item.problemPercent}%</small></td>
    </tr>`).join('');
  el('navControlMatrix').innerHTML = `
    <table class="nav-control-table">
      <thead><tr><th class="nav-control-board">Борт</th>${head}<th>Сбои</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  scheduleMatrixSlidersSync();
}

function renderPriority() {
  const items = state.data?.attention || [];
  el('navControlPriority').innerHTML = items.length ? items.map(item => `
    <article class="nav-priority-item" data-attention-id="${item.id}">
      <div class="nav-priority-head">
        <div><b>Борт ${escapeHtml(item.board)}</b><small>${escapeHtml(item.model)}</small></div>
        <time title="Дата постановки на контроль">с ${escapeHtml(dateRu(item.openedReportDate))}</time>
      </div>
      <p class="nav-priority-reason">${escapeHtml(item.triggerReason)}</p>
      <div class="nav-priority-values">
        <span class="danger">Красные ${item.redPercent}%</span>
        <span class="warning">Жёлтые ${item.yellowPercent}%</span>
        ${item.redStreak ? `<span>${item.redStreak} красн. дн. подряд</span>` : ''}
        <strong>${item.healthyStreak}/7 исправных дней</strong>
      </div>
      ${item.latestText ? `<div class="nav-priority-latest"><small>Последняя запись${item.latestAt ? ` · ${escapeHtml(dateTimeRu(item.latestAt))}` : ''}</small><span>${escapeHtml(item.latestText)}</span></div>` : ''}
      <div class="nav-priority-actions">
        ${item.canManage ? `<button type="button" class="ghost compact" data-attention-action="note" data-id="${item.id}">Заметка</button>
        <button type="button" class="primary compact" data-attention-action="measure" data-id="${item.id}">Принятые меры</button>` : ''}
        <button type="button" class="ghost compact" data-attention-action="history" data-id="${item.id}">История${item.eventCount ? ` (${item.eventCount})` : ''}</button>
        ${item.canManage ? `<button type="button" class="ghost compact danger" data-attention-action="dismiss" data-id="${item.id}">Убрать</button>` : ''}
      </div>
      ${item.canManage ? `<form class="nav-attention-form" data-attention-form="${item.id}" hidden>
        <label><span>Заметка</span><textarea maxlength="4000" rows="3" required></textarea></label>
        <div><button type="submit" class="primary compact">Сохранить</button><button type="button" class="ghost compact" data-attention-action="cancel" data-id="${item.id}">Отмена</button></div>
      </form>` : ''}
      <div class="nav-attention-history" data-attention-history="${item.id}" hidden></div>
    </article>`).join('') : '<div class="nav-control-empty">Нет бортов, требующих внимания.</div>';
}

function renderAttentionHistory(target, data) {
  const items = data?.items || [];
  target.innerHTML = items.length ? `
    <div class="nav-attention-history-title">История борта ${escapeHtml(data.board)}</div>
    ${items.map(item => `
      <div class="nav-attention-history-item">
        <div><b>${item.WorkDone ? 'Выполненные меры' : 'Заметка'}</b><time>${escapeHtml(dateTimeRu(item.CreatedAt))}</time></div>
        <p>${escapeHtml(item.WorkDone || item.Note || item.Description)}</p>
        <small>${escapeHtml(item.CreatedBy || 'Система')} · ${escapeHtml(item.Source || 'Контроль навигации')}</small>
      </div>`).join('')}` : '<div class="nav-control-empty">Записей контроля по этому борту пока нет.</div>';
}

async function handlePriorityClick(event) {
  const button = event.target.closest('[data-attention-action]');
  if (!button) return;
  const id = button.dataset.id;
  const action = button.dataset.attentionAction;
  const card = button.closest('[data-attention-id]');
  if (!card) return;
  const form = card.querySelector('[data-attention-form]');
  const history = card.querySelector('[data-attention-history]');

  if (action === 'cancel') {
    form.reset();
    form.hidden = true;
    return;
  }
  if (action === 'note' || action === 'measure') {
    form.dataset.mode = action;
    form.querySelector('label > span').textContent = action === 'measure' ? 'Принятые меры' : 'Заметка';
    form.querySelector('textarea').placeholder = action === 'measure' ? 'Например: выполнен ремонт навигации' : 'Что нужно учитывать по этому борту';
    form.querySelector('button[type="submit"]').textContent = action === 'measure' ? 'Выполнено' : 'Добавить заметку';
    form.hidden = false;
    form.querySelector('textarea').focus();
    return;
  }
  if (action === 'history') {
    if (!history.hidden) {
      history.hidden = true;
      return;
    }
    history.hidden = false;
    history.innerHTML = '<div class="nav-control-empty">Загрузка истории…</div>';
    button.disabled = true;
    try {
      renderAttentionHistory(history, await apiRequest(`/nav-control/attention/${id}/history`));
    } catch (error) {
      history.innerHTML = `<div class="nav-control-empty">${escapeHtml(error.message)}</div>`;
    } finally {
      button.disabled = false;
    }
    return;
  }
  if (action === 'dismiss') {
    if (!confirm('Убрать этот борт из списка «Требуют внимания»? Он появится снова только после нового проблемного отчёта.')) return;
    button.disabled = true;
    try {
      await apiRequest(`/nav-control/attention/${id}/dismiss`, {method: 'POST', body: JSON.stringify({reason: 'Снято с контроля вручную'})});
      await refresh();
    } catch (error) {
      alert(`Не удалось снять борт с контроля: ${error.message}`);
      button.disabled = false;
    }
  }
}

async function handlePrioritySubmit(event) {
  const form = event.target.closest('[data-attention-form]');
  if (!form) return;
  event.preventDefault();
  const id = form.dataset.attentionForm;
  const mode = form.dataset.mode;
  const text = form.querySelector('textarea').value.trim();
  if (!text) return;
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const endpoint = mode === 'measure' ? 'complete' : 'note';
    await apiRequest(`/nav-control/attention/${id}/${endpoint}`, {method: 'POST', body: JSON.stringify({text})});
    await refresh();
  } catch (error) {
    alert(`Не удалось сохранить запись: ${error.message}`);
    submit.disabled = false;
  }
}

function renderReports() {
  const reports = state.data?.reports || [];
  el('navControlReports').innerHTML = reports.length ? reports.map(item => `
    <div class="nav-report-item${item.IsActive ? '' : ' inactive'}">
      <span class="nav-report-period ${item.Period}">${item.Period === 'morning' ? 'Утро' : 'Вечер'}</span>
      <div><b>${escapeHtml(new Date(`${item.ReportDate}T00:00:00`).toLocaleDateString('ru-RU'))}</b><small>${escapeHtml(item.FileName)}</small>${item.IsActive ? '' : '<small class="nav-report-warning">Заменён более новой версией</small>'}${item.Warning ? `<small class="nav-report-warning">${escapeHtml(item.Warning)}</small>` : ''}</div>
      <div><span>${item.Source === 'email' ? 'Почта' : 'Вручную'}</span><small>${escapeHtml(dateTimeRu(item.ImportedAt))}</small><small>${escapeHtml(item.DetectionReason || '')}</small></div>
    </div>`).join('') : '<div class="nav-control-empty">В базе данных пока нет загруженных отчётов.</div>';
}

function renderMail() {
  const mail = state.data?.mail;
  if (!mail) return;
  if (!state.settingsLoaded && el('navControlMailForm')) {
    el('navMailHost').value = mail.imapHost || '';
    el('navMailPort').value = mail.imapPort || 993;
    el('navMailUser').value = mail.username || '';
    el('navMailFolder').value = mail.mailFolder || 'INBOX';
    el('navMailSender').value = mail.senderFilter || '';
    el('navMailSubject').value = mail.subjectFilter || 'User metro';
    el('navMailPoll').value = mail.pollMinutes || 5;
    el('navMailCutoff').value = mail.morningCutoffHour ?? 12;
    el('navMailDepot').value = mail.depotName || 'Троллейбусное Депо №2';
    el('navMailSsl').checked = Boolean(mail.useSsl);
    el('navMailAuto').checked = Boolean(mail.autoSync);
    el('navMailPassword').placeholder = mail.hasPassword ? 'Пароль сохранён. Оставьте пустым, чтобы не менять' : 'Введите пароль приложения';
    state.settingsLoaded = true;
  }
  el('navControlMailStatus').innerHTML = `
    <span class="${mail.lastError ? 'error' : 'ok'}">${mail.autoSync ? 'Автозагрузка включена' : 'Автозагрузка выключена'}</span>
    <small>Последняя проверка: ${escapeHtml(dateTimeRu(mail.lastCheckAt))}</small>
    ${mail.lastError ? `<small class="error">${escapeHtml(mail.lastError)}</small>` : ''}`;
}

function renderLog() {
  const logs = state.data?.logs || [];
  el('navControlLog').innerHTML = logs.length ? logs.map(item => `
    <div class="nav-log-item ${escapeHtml(item.Level)}"><time>${escapeHtml(dateTimeRu(item.CreatedAt))}</time><span>${escapeHtml(item.Message)}</span></div>`).join('') : '<div class="nav-control-empty">Событий синхронизации пока нет.</div>';
}

function render() {
  renderNavigationStats();
  renderMatrix();
  renderPriority();
  renderReports();
  renderMail();
  renderLog();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Не удалось прочитать файл.'));
    reader.readAsDataURL(file);
  });
}

function showUploadStatus(message, type = 'info') {
  const target = el('navControlUploadStatus');
  target.hidden = false;
  target.className = `nav-control-upload-status glass ${type}`;
  target.textContent = message;
}

async function upload(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  setBusy(true);
  showUploadStatus(`Чтение файла «${file.name}»…`);
  try {
    const result = await apiRequest('/nav-control/import', {
      method: 'POST',
      body: JSON.stringify({
        filename: file.name,
        contentBase64: await fileToBase64(file),
        mode: 'auto'
      })
    });
    const unknown = result.unknownBoards?.length ? ` Пропущены неизвестные борта: ${result.unknownBoards.join(', ')}.` : '';
    const outsideSelectedRange = result.reportDate < el('navControlFrom').value || result.reportDate > el('navControlTo').value;
    const rangeHint = outsideSelectedRange ? ' Отчёт сохранён на свою дату; для просмотра выберите её в периоде выше.' : '';
    const outcome = result.imported
      ? `Загружен «${file.name}»: дата ${new Date(`${result.reportDate}T00:00:00`).toLocaleDateString('ru-RU')}, добавлено периодов ${result.imported}.${unknown}${rangeHint}`
      : `Файл «${file.name}» уже был загружен ранее. Найдено повторов: ${result.duplicates}.${unknown}${rangeHint}`;
    showUploadStatus(outcome, result.imported ? 'success' : 'warning');
    await refresh();
  } catch (error) {
    showUploadStatus(`Не удалось загрузить «${file.name}»: ${error.message}`, 'error');
  } finally {
    event.target.value = '';
    setBusy(false);
  }
}

async function syncMail() {
  try {
    await apiRequest('/nav-control/sync', {method: 'POST'});
    el('navControlMailStatus').innerHTML = '<span class="ok">Проверка почты запущена</span><small>Результат появится в журнале синхронизации.</small>';
    setTimeout(() => refresh().catch(() => {}), 7000);
  } catch (error) {
    alert(`Не удалось запустить проверку: ${error.message}`);
  }
}

function mailSettingsPayload() {
  return {
    imapHost: el('navMailHost').value,
    imapPort: Number(el('navMailPort').value),
    useSsl: el('navMailSsl').checked,
    username: el('navMailUser').value,
    password: el('navMailPassword').value,
    mailFolder: el('navMailFolder').value,
    senderFilter: el('navMailSender').value,
    subjectFilter: el('navMailSubject').value,
    pollMinutes: Number(el('navMailPoll').value),
    morningCutoffHour: Number(el('navMailCutoff').value),
    depotName: el('navMailDepot').value,
    autoSync: el('navMailAuto').checked
  };
}

async function saveMailSettings(button, announce = true) {
  button.disabled = true;
  try {
    await apiRequest('/nav-control/settings', {
      method: 'PUT',
      body: JSON.stringify(mailSettingsPayload())
    });
    el('navMailPassword').value = '';
    state.settingsLoaded = false;
    await refresh();
    if (announce) el('navControlMailStatus').innerHTML = '<span class="ok">Настройки почты сохранены</span>';
    return true;
  } catch (error) {
    alert(`Не удалось сохранить настройки: ${error.message}`);
    return false;
  } finally {
    button.disabled = false;
  }
}

async function saveMail(event) {
  event.preventDefault();
  const button = event.submitter || event.target.querySelector('button[type="submit"]');
  await saveMailSettings(button);
}

async function saveAndSyncMail() {
  if (!el('navControlMailForm').reportValidity()) return;
  const button = el('navControlSaveAndSync');
  if (await saveMailSettings(button, false)) await syncMail();
}

async function buildExcelReport() {
  if (!el('navControlFrom').value) defaultDates();
  const query = new URLSearchParams({from: el('navControlFrom').value, to: el('navControlTo').value});
  const data = await apiRequest(`/nav-control?${query}`);
  const statusRows = [];
  data.boards.forEach(board => board.entries.forEach(entry => statusRows.push([
    entry.date, board.board, board.model, STATUS[entry.status]?.label || entry.status,
    entry.morning ? 'Не работает' : (entry.status === 'incomplete' ? 'Нет отчёта' : 'Работает'),
    entry.evening ? 'Не работает' : (entry.status === 'incomplete' ? 'Нет отчёта' : 'Работает'),
    entry.morningRoute, entry.morningComment, entry.eveningRoute, entry.eveningComment
  ])));
  const summaryRows = data.boards.map(item => [
    item.board, item.model, item.red, item.yellow, item.completeDays, item.problemPercent,
    item.currentStreak, item.longestStreak
  ]);
  return {
    title: 'Контроль работы навигации',
    filename: `ЕСТУ_Контроль_навигации_${data.from}_${data.to}.xlsx`,
    sheets: [
      {name: 'Сводка', subtitle: `Период ${data.from} - ${data.to}`, headers: ['Борт', 'Модель', 'Не работает весь день', 'Частичный сбой', 'Дней с полными отчётами', 'Проблем, %', 'Текущая серия', 'Максимальная серия'], rows: summaryRows, widths: [12, 24, 20, 18, 22, 14, 16, 18]},
      {name: 'По дням', subtitle: 'Утренние и вечерние отчёты', headers: ['Дата', 'Борт', 'Модель', 'Итог', 'Утро', 'Вечер', 'Маршрут утром', 'Комментарий утром', 'Маршрут вечером', 'Комментарий вечером'], rows: statusRows, widths: [13, 10, 22, 26, 16, 16, 16, 34, 16, 34]}
    ]
  };
}

function init() {
  if (state.initialized) return;
  state.initialized = true;
  defaultDates();
  el('navControlRefresh').addEventListener('click', () => refresh().catch(error => alert(error.message)));
  el('navControlSync').addEventListener('click', syncMail);
  el('navControlSaveAndSync').addEventListener('click', saveAndSyncMail);
  el('navControlFile').addEventListener('change', upload);
  el('navControlHorizontalSlider').addEventListener('input', event => {
    el('navControlMatrix').scrollLeft = Number(event.target.value);
  });
  el('navControlVerticalSlider').addEventListener('input', event => {
    el('navControlMatrix').scrollTop = Number(event.target.value);
  });
  const beginSliderDrag = () => document.body.classList.add('nav-control-slider-dragging');
  const endSliderDrag = () => document.body.classList.remove('nav-control-slider-dragging');
  [el('navControlHorizontalSlider'), el('navControlVerticalSlider')].forEach(slider => {
    slider.addEventListener('pointerdown', beginSliderDrag);
  });
  window.addEventListener('pointerup', endSliderDrag);
  window.addEventListener('pointercancel', endSliderDrag);
  el('navControlMatrix').addEventListener('scroll', syncMatrixSliders, {passive: true});
  window.addEventListener('resize', scheduleMatrixSlidersSync);
  if ('ResizeObserver' in window) {
    state.horizontalResizeObserver = new ResizeObserver(scheduleMatrixSlidersSync);
    state.horizontalResizeObserver.observe(el('navControlMatrix'));
  }
  el('navControlSearch').addEventListener('input', renderMatrix);
  el('navControlProblemsOnly').addEventListener('change', renderMatrix);
  el('navControlPriority').addEventListener('click', event => handlePriorityClick(event).catch(error => alert(error.message)));
  el('navControlPriority').addEventListener('submit', event => handlePrioritySubmit(event).catch(error => alert(error.message)));
  el('navControlFrom').addEventListener('change', () => { saveDates(); refresh().catch(() => {}); });
  el('navControlTo').addEventListener('change', () => { saveDates(); refresh().catch(() => {}); });
  el('navControlMailForm').addEventListener('submit', saveMail);
}

export { buildExcelReport, init, refresh };
