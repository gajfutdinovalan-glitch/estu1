import { hasModuleAccess } from '../core/access.js';
import { apiRequest } from '../core/api.js';
import { byId, esc, ruDateTime, todayISO } from '../core/format.js';
import { can, state } from '../core/state.js';

const BSO_CUBE_SLOTS = 5;

let bsoFleet = [];
let bsoLoaded = false;
let bsoLoading = null;
let bsoEventsBound = false;
let bsoToastTimer = null;
let bsoHistory = [];
let bsoHistoryLoaded = false;
let bsoHistoryLoading = null;
let bsoDataSignature = '';

function resetBsoState() {
  bsoFleet = [];
  bsoLoaded = false;
  bsoLoading = null;
  bsoHistory = [];
  bsoHistoryLoaded = false;
  bsoHistoryLoading = null;
  bsoDataSignature = '';
}

function normalizeBsoDevice(device) {
  const status = ['installed', 'removed', 'empty'].includes(device?.status) ? device.status : 'empty';
  const full = status === 'installed' ? String(device?.full || '').trim() : '';
  const short = status === 'installed' ? String(device?.short || '').trim() : '';
  return {
    full,
    short,
    status: status === 'installed' && !full && !short ? 'empty' : status
  };
}

function normalizeBsoRecord(value, vehicle = null) {
  const board = String(vehicle?.board ?? value?.board ?? value?.number ?? '').trim();
  const sourceCubes = Array.isArray(value?.cubes) ? value.cubes : [];
  return {
    number: board,
    board,
    model: String(vehicle?.model ?? value?.model ?? '').trim(),
    cash: normalizeBsoDevice(value?.cash),
    cubes: Array.from({length: BSO_CUBE_SLOTS}, (_, index) => normalizeBsoDevice(sourceCubes[index])),
    note: String(value?.note || '').trim()
  };
}

function syncBsoWithFleet(records = bsoFleet) {
  const source = new Map((Array.isArray(records) ? records : []).map(item => [
    String(item?.board ?? item?.number ?? ''),
    item
  ]));
  bsoFleet = (Array.isArray(state?.fleet) ? state.fleet : []).map(vehicle =>
    normalizeBsoRecord(source.get(String(vehicle.board)) || {}, vehicle)
  );
}

async function refreshBsoState({force = false, render = true} = {}) {
  if (!state?.currentUser || !hasModuleAccess('bso')) return;
  if (bsoLoading) return bsoLoading;
  if (bsoLoaded && !force) {
    syncBsoWithFleet();
    if (render) renderBsoCurrentView();
    return;
  }
  bsoLoading = (async () => {
    const records = await apiRequest('/bso');
    const normalizedRecords = (Array.isArray(records) ? records : []).map(item => normalizeBsoRecord(item));
    const nextSignature = JSON.stringify(normalizedRecords);
    const changed = !bsoLoaded || nextSignature !== bsoDataSignature;
    bsoDataSignature = nextSignature;
    bsoFleet = normalizedRecords;
    syncBsoWithFleet();
    bsoLoaded = true;
    if (render && changed) renderBsoCurrentView();
  })();
  try {
    await bsoLoading;
  } finally {
    bsoLoading = null;
  }
}

function renderBsoCurrentView() {
  const activeId = document.querySelector('.panel.active-panel')?.id;
  if (activeId === 'bsoFleet') renderBsoFleet();
  if (activeId === 'bsoEditor') renderBsoEditor();
  if (activeId === 'bsoTable') {
    renderBsoTable();
    refreshBsoHistory().catch(error => {
      byId('bsoHistoryList').innerHTML = `<div class="bso-empty">${esc(error.message)}</div>`;
    });
  }
}

function bsoIsInstalled(device) {
  return device?.status === 'installed' && Boolean(String(device.full || device.short || '').trim());
}

function bsoInstalledCubeCount(bus) {
  return bus.cubes.filter(bsoIsInstalled).length;
}

function bsoAllRemoved(bus) {
  const anyRemoved = bus.cash.status === 'removed' || bus.cubes.some(cube => cube.status === 'removed');
  const noInstalled = !bsoIsInstalled(bus.cash) && bus.cubes.every(cube => !bsoIsInstalled(cube));
  return anyRemoved && noInstalled;
}

function bsoKitState(bus) {
  if (bsoAllRemoved(bus)) return {key: 'removed', text: 'БСО снята', className: 'danger'};
  const count = bsoInstalledCubeCount(bus);
  if (count >= 3) return {key: 'complete', text: `Комплект ${count}/${BSO_CUBE_SLOTS}`, className: 'success'};
  return {key: 'incomplete', text: `Неполный комплект · ${count}/${BSO_CUBE_SLOTS}`, className: 'warn'};
}

function bsoStatusText(device) {
  if (device.status === 'removed') return 'БСО снята';
  if (device.status === 'installed') return 'Установлена';
  return 'Не указана';
}

function bsoDeviceDisplay(device) {
  if (device.status === 'removed') return {short: 'БСО снята', full: '', className: 'danger'};
  if (!bsoIsInstalled(device)) return {short: '—', full: 'Номер не указан', className: 'gray'};
  return {
    short: device.short || 'Короткий № не указан',
    full: device.full || 'Полный № не указан',
    className: 'success'
  };
}

function bsoSearchable(bus) {
  return [
    bus.board,
    bus.model,
    bus.cash.full,
    bus.cash.short,
    bsoStatusText(bus.cash),
    ...bus.cubes.flatMap(cube => [cube.full, cube.short, bsoStatusText(cube)]),
    bus.note
  ].join(' ').toLowerCase();
}

function bsoSort(left, right) {
  const a = Number(left.board);
  const b = Number(right.board);
  if (Number.isFinite(a) && Number.isFinite(b)) return a - b;
  return String(left.board).localeCompare(String(right.board), 'ru', {numeric: true});
}

function sortedBsoFleet(items = bsoFleet) {
  return [...items].sort(bsoSort);
}

function filteredBsoFleet() {
  const query = byId('bsoSearch').value.trim().toLowerCase();
  const cashFilter = byId('bsoCashFilter').value;
  const kitFilter = byId('bsoKitFilter').value;
  return sortedBsoFleet().filter(bus => {
    const kit = bsoKitState(bus);
    return (!query || bsoSearchable(bus).includes(query))
      && (cashFilter === 'all' || bus.cash.status === cashFilter)
      && (kitFilter === 'all' || kit.key === kitFilter);
  });
}

function renderBsoStats() {
  if (!bsoLoaded) {
    byId('bsoStats').innerHTML = '';
    return;
  }
  const values = [
    ['Всего бортов', bsoFleet.length],
    ['Касс установлено', bsoFleet.filter(bus => bsoIsInstalled(bus.cash)).length],
    ['Кубов установлено', bsoFleet.reduce((sum, bus) => sum + bsoInstalledCubeCount(bus), 0)],
    ['Полных комплектов', bsoFleet.filter(bus => bsoKitState(bus).key === 'complete').length],
    ['Неполных комплектов', bsoFleet.filter(bus => bsoKitState(bus).key === 'incomplete').length],
    ['БСО полностью снята', bsoFleet.filter(bsoAllRemoved).length]
  ];
  byId('bsoStats').innerHTML = values.map(([label, value]) =>
    `<div class="stat"><b>${value}</b><span>${esc(label)}</span></div>`
  ).join('');
}

function bsoCashHtml(bus) {
  const cash = bsoDeviceDisplay(bus.cash);
  return `
    <div class="bso-device-block">
      <div class="bso-device-head"><span class="bso-device-title">Касса</span><span class="bso-pill ${cash.className}">${esc(bsoStatusText(bus.cash))}</span></div>
      <div class="bso-short-number">${esc(cash.short)}</div>
      <div class="bso-full-number">${esc(cash.full)}</div>
    </div>`;
}

function bsoCubeHtml(cube) {
  const display = bsoDeviceDisplay(cube);
  const stateClass = cube.status === 'removed' ? 'removed' : (!bsoIsInstalled(cube) ? 'empty' : '');
  return `<div class="bso-cube-item ${stateClass}" title="${esc(display.full)}"><span class="bso-cube-short">${esc(display.short)}</span><span class="bso-cube-full">${esc(display.full)}</span></div>`;
}

function bsoCardHtml(bus) {
  const kit = bsoKitState(bus);
  const editButton = can('manageBso')
    ? `<button type="button" data-bso-action="edit" data-board="${esc(bus.board)}">Изменить</button>`
    : '';
  return `
    <article class="bso-bus-card">
      <div class="bso-bus-top">
        <div><div class="bso-number">№ ${esc(bus.board)}</div><div class="bso-model">${esc(bus.model)}</div></div>
        <span class="bso-pill ${kit.className}">${esc(kit.text)}</span>
      </div>
      ${bsoCashHtml(bus)}
      <div class="bso-device-block">
        <div class="bso-device-head"><span class="bso-device-title">Кубы</span><span class="bso-pill gray">${bsoInstalledCubeCount(bus)}/${BSO_CUBE_SLOTS}</span></div>
        <div class="bso-cube-grid">${bus.cubes.map(bsoCubeHtml).join('')}</div>
      </div>
      <div class="bso-card-footer"><div class="bso-note">${esc(bus.note || 'Заметок нет')}</div>${editButton}</div>
    </article>`;
}

function renderBsoFleet() {
  if (!bsoLoaded) {
    byId('bsoFleetGrid').innerHTML = '<div class="bso-empty">Загрузка данных БСО…</div>';
    byId('bsoResultsCount').textContent = '';
    return;
  }
  renderBsoStats();
  const items = filteredBsoFleet();
  byId('bsoResultsCount').textContent = `Показано: ${items.length} из ${bsoFleet.length}`;
  byId('bsoFleetGrid').innerHTML = items.length
    ? items.map(bsoCardHtml).join('')
    : '<div class="bso-empty">По заданным условиям ничего не найдено.</div>';
}

function renderBsoEditor() {
  if (!can('manageBso')) return;
  fillBsoBoardOptions();
  const query = byId('bsoEditorSearch').value.trim().toLowerCase();
  const items = sortedBsoFleet().filter(bus => !query || bsoSearchable(bus).includes(query));
  byId('bsoEditableList').innerHTML = items.length ? items.map(bus => {
    return `
      <div class="bso-editable-row">
        <b>№ ${esc(bus.board)}</b>
        <span>${esc(bus.model)} · касса ${esc(bsoDeviceDisplay(bus.cash).short)} · кубов ${bsoInstalledCubeCount(bus)}</span>
        <div class="bso-row-actions"><button type="button" data-bso-action="edit" data-board="${esc(bus.board)}">Изменить</button></div>
      </div>`;
  }).join('') : '<div class="bso-empty">Борты не найдены.</div>';
  const selectedBoard = byId('bsoBoard').value;
  if (selectedBoard && byId('bsoForm').dataset.loadedBoard !== selectedBoard) {
    loadBsoRecordIntoForm(selectedBoard);
  }
}

function bsoTableDeviceValue(device, field) {
  if (device.status === 'removed') return 'БСО снята';
  if (!bsoIsInstalled(device)) return '—';
  return device[field] || '—';
}

function bsoTableNumberList(bus, field) {
  return bus.cubes.map(cube => `<span>${esc(bsoTableDeviceValue(cube, field))}</span>`).join('');
}

function renderBsoTable() {
  if (!bsoLoaded) {
    byId('bsoSummaryTableBody').innerHTML = '<tr><td colspan="7">Загрузка данных БСО…</td></tr>';
    return;
  }
  const query = byId('bsoTableSearch').value.trim().toLowerCase();
  const items = sortedBsoFleet().filter(bus => !query || bsoSearchable(bus).includes(query));
  byId('bsoSummaryTableBody').innerHTML = items.map(bus => {
    const kit = bsoKitState(bus);
    return `
      <tr>
        <td><b>${esc(bus.board)}</b></td><td>${esc(bus.model)}</td>
        <td>${esc(bsoTableDeviceValue(bus.cash, 'short'))}</td><td>${esc(bsoTableDeviceValue(bus.cash, 'full'))}</td>
        <td><div class="bso-table-number-list">${bsoTableNumberList(bus, 'short')}</div></td>
        <td><div class="bso-table-number-list">${bsoTableNumberList(bus, 'full')}</div></td>
        <td><span class="bso-pill ${kit.className}">${esc(kit.text)}</span></td>
      </tr>`;
  }).join('');
  renderBsoHistory();
}

function bsoHistoryNumber(full, short) {
  const values = [];
  if (short) values.push(`короткий № ${short}`);
  if (full) values.push(`полный № ${full}`);
  return values.length ? values.join(' · ') : 'номер не указан';
}

function bsoExcelDeviceValue(device, field) {
  if (device.status === 'removed') return 'БСО снята';
  if (!bsoIsInstalled(device)) return 'Не указано';
  return device[field] || 'Не указано';
}

function getBsoExcelSheets(subtitle) {
  const fleet = sortedBsoFleet();
  const numberHeaders = ['Борт', 'Модель', 'Касса', 'Куб 1', 'Куб 2', 'Куб 3', 'Куб 4', 'Куб 5', 'Заметка'];
  const makeRows = field => fleet.map(bus => [
    bus.board,
    bus.model,
    bsoExcelDeviceValue(bus.cash, field),
    ...bus.cubes.map(cube => bsoExcelDeviceValue(cube, field)),
    bus.note || ''
  ]);
  const historyRows = bsoHistory.map(item => [
    ruDateTime(item.createdAt),
    item.board,
    item.deviceLabel,
    item.oldShort || '',
    item.oldFull || '',
    item.newShort || '',
    item.newFull || '',
    item.actor
  ]);
  return [
    {name: 'Полные номера', title: 'Учёт БСО — полные номера', subtitle, headers: numberHeaders, rows: makeRows('full'), widths: [10, 30, 24, 24, 24, 24, 24, 24, 34]},
    {name: 'Короткие номера', title: 'Учёт БСО — короткие номера', subtitle, headers: numberHeaders, rows: makeRows('short'), widths: [10, 30, 18, 18, 18, 18, 18, 18, 34]},
    {name: 'История замен', title: 'История замены номеров БСО', subtitle, headers: ['Дата и время', 'Борт', 'Устройство', 'Старый короткий №', 'Старый полный №', 'Новый короткий №', 'Новый полный №', 'Изменил'], rows: historyRows, widths: [20, 10, 16, 20, 26, 20, 26, 24]}
  ];
}

function renderBsoHistory() {
  const root = byId('bsoHistoryList');
  if (!root) return;
  if (!bsoHistoryLoaded) {
    root.innerHTML = '<div class="bso-empty">Загрузка истории замен…</div>';
    return;
  }
  const query = byId('bsoHistorySearch').value.trim().toLowerCase();
  const items = bsoHistory.filter(item => [
    item.board,
    item.deviceLabel,
    item.oldFull,
    item.oldShort,
    item.newFull,
    item.newShort,
    item.actor
  ].some(value => String(value || '').toLowerCase().includes(query)));
  root.innerHTML = items.length ? items.map(item => `
    <article class="bso-history-row">
      <div class="bso-history-meta">
        <b>Борт ${esc(item.board)} · ${esc(item.deviceLabel)}</b>
        <time>${esc(ruDateTime(item.createdAt))}</time>
      </div>
      <div class="bso-number-change">
        <span class="old">${esc(bsoHistoryNumber(item.oldFull, item.oldShort))}</span>
        <span class="arrow" aria-hidden="true">→</span>
        <span class="new">${esc(bsoHistoryNumber(item.newFull, item.newShort))}</span>
      </div>
      <small>Изменил: ${esc(item.actor)}</small>
    </article>`).join('') : '<div class="bso-empty">Замены номеров пока не зафиксированы.</div>';
}

async function refreshBsoHistory({force = false} = {}) {
  if (bsoHistoryLoading) return bsoHistoryLoading;
  if (bsoHistoryLoaded && !force) {
    renderBsoHistory();
    return;
  }
  bsoHistoryLoading = (async () => {
    const records = await apiRequest('/bso/history');
    bsoHistory = Array.isArray(records) ? records : [];
    bsoHistoryLoaded = true;
    renderBsoHistory();
  })();
  try {
    await bsoHistoryLoading;
  } finally {
    bsoHistoryLoading = null;
  }
}

function renderBsoCubeFields() {
  byId('bsoCubeFields').innerHTML = Array.from({length: BSO_CUBE_SLOTS}, (_, index) => `
    <div class="bso-device-editor-row">
      <label>Куб ${index + 1}, состояние
        <select id="bsoCubeStatus${index}" data-bso-device-status="cube" data-index="${index}">
          <option value="installed">Установлен</option><option value="removed">БСО снята</option><option value="empty">Не указано</option>
        </select>
      </label>
      <label>Полный номер<input id="bsoCubeFull${index}" inputmode="numeric" placeholder="2004…" /></label>
      <label>Короткий номер<input id="bsoCubeShort${index}" inputmode="numeric" placeholder="90004377" /></label>
    </div>`).join('');
  document.querySelectorAll('[data-bso-device-status="cube"]').forEach(select => {
    select.addEventListener('change', () => syncBsoDeviceInputs('cube', Number(select.dataset.index)));
  });
}

function syncBsoDeviceInputs(type, index = null) {
  const status = type === 'cash' ? byId('bsoCashStatus').value : byId(`bsoCubeStatus${index}`).value;
  const fullInput = type === 'cash' ? byId('bsoCashFull') : byId(`bsoCubeFull${index}`);
  const shortInput = type === 'cash' ? byId('bsoCashShort') : byId(`bsoCubeShort${index}`);
  const disabled = status !== 'installed';
  fullInput.disabled = disabled;
  shortInput.disabled = disabled;
  if (disabled) {
    fullInput.value = '';
    shortInput.value = '';
  }
}

function setBsoDeviceFields(type, index, device) {
  const suffix = index == null ? '' : index;
  byId(`bso${type === 'cash' ? 'Cash' : 'Cube'}Status${suffix}`).value = device.status;
  byId(`bso${type === 'cash' ? 'Cash' : 'Cube'}Full${suffix}`).value = device.full || '';
  byId(`bso${type === 'cash' ? 'Cash' : 'Cube'}Short${suffix}`).value = device.short || '';
  syncBsoDeviceInputs(type, index);
}

function fillBsoBoardOptions() {
  const select = byId('bsoBoard');
  const selected = select.value;
  select.innerHTML = sortedBsoFleet().map(bus => `<option value="${esc(bus.board)}">№ ${esc(bus.board)} · ${esc(bus.model)}</option>`).join('');
  if (bsoFleet.some(bus => bus.board === selected)) select.value = selected;
  if (!select.value && bsoFleet.length) select.value = sortedBsoFleet()[0].board;
  updateBsoModelField();
}

function updateBsoModelField() {
  const bus = bsoFleet.find(item => item.board === byId('bsoBoard').value);
  byId('bsoModel').value = bus?.model || '';
}

function loadBsoRecordIntoForm(board) {
  const bus = bsoFleet.find(item => item.board === String(board));
  if (!bus) return;
  byId('bsoForm').dataset.loadedBoard = bus.board;
  byId('bsoFormTitle').textContent = `Комплект БСО борта № ${bus.board}`;
  byId('bsoBoard').value = bus.board;
  byId('bsoModel').value = bus.model;
  byId('bsoNote').value = bus.note;
  setBsoDeviceFields('cash', null, bus.cash);
  bus.cubes.forEach((cube, index) => setBsoDeviceFields('cube', index, cube));
}

function readBsoDevice(statusId, fullId, shortId) {
  let status = byId(statusId).value;
  const full = byId(fullId).value.trim();
  const short = byId(shortId).value.trim();
  if (status === 'installed' && !full && !short) status = 'empty';
  return {status, full: status === 'installed' ? full : '', short: status === 'installed' ? short : ''};
}

function collectBsoDuplicateWarnings(items) {
  const full = new Map();
  const short = new Map();
  const duplicates = [];
  items.forEach(bus => {
    const devices = [{label: 'касса', value: bus.cash}, ...bus.cubes.map((value, index) => ({label: `куб ${index + 1}`, value}))];
    devices.forEach(({label, value}) => {
      if (!bsoIsInstalled(value)) return;
      for (const [field, map] of [['full', full], ['short', short]]) {
        const number = value[field];
        if (!number) continue;
        const location = `борт ${bus.board}, ${label}`;
        if (map.has(number)) duplicates.push(`${field === 'full' ? 'Полный' : 'Короткий'} номер ${number}: ${map.get(number)} и ${location}`);
        else map.set(number, location);
      }
    });
  });
  return duplicates;
}

async function saveBsoForm(event) {
  event.preventDefault();
  const board = byId('bsoBoard').value;
  const payload = {
    cash: readBsoDevice('bsoCashStatus', 'bsoCashFull', 'bsoCashShort'),
    cubes: Array.from({length: BSO_CUBE_SLOTS}, (_, index) =>
      readBsoDevice(`bsoCubeStatus${index}`, `bsoCubeFull${index}`, `bsoCubeShort${index}`)
    ),
    note: byId('bsoNote').value.trim()
  };
  const candidate = normalizeBsoRecord({...payload, board}, bsoFleet.find(item => item.board === board));
  const duplicates = collectBsoDuplicateWarnings([...bsoFleet.filter(item => item.board !== board), candidate]);
  if (duplicates.length) {
    alert(`Номера устройств не должны повторяться:\n${duplicates.join('\n')}`);
    return;
  }
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    await apiRequest(`/bso/${encodeURIComponent(board)}`, {method: 'PUT', body: JSON.stringify(payload)});
    bsoHistoryLoaded = false;
    await refreshBsoState({force: true, render: false});
    openEquipmentTab('bsoFleet');
    renderBsoFleet();
    showBsoToast(`Комплект борта ${board} сохранён`);
  } catch (error) {
    alert(`Не удалось сохранить данные БСО: ${error.message}`);
  } finally {
    submit.disabled = false;
  }
}

function handleBsoAction(event) {
  const button = event.target.closest('[data-bso-action]');
  if (!button) return;
  const board = button.dataset.board;
  if (button.dataset.bsoAction === 'edit') {
    openEquipmentTab('bsoEditor');
    loadBsoRecordIntoForm(board);
    document.querySelector('main')?.scrollIntoView({block: 'start', behavior: 'smooth'});
  }
}

function csvBsoEscape(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function downloadBsoBlob(content, filename, mimeType) {
  const blob = new Blob([content], {type: mimeType});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function exportBsoCsv() {
  const headers = ['Борт', 'Модель', 'Статус кассы', 'Касса полный №', 'Касса короткий №'];
  for (let index = 1; index <= BSO_CUBE_SLOTS; index += 1) {
    headers.push(`Куб ${index} статус`, `Куб ${index} полный №`, `Куб ${index} короткий №`);
  }
  headers.push('Заметка');
  const rows = sortedBsoFleet().map(bus => {
    const row = [bus.board, bus.model, bsoStatusText(bus.cash), bsoTableDeviceValue(bus.cash, 'full'), bsoTableDeviceValue(bus.cash, 'short')];
    bus.cubes.forEach(cube => row.push(bsoStatusText(cube), bsoTableDeviceValue(cube, 'full'), bsoTableDeviceValue(cube, 'short')));
    row.push(bus.note);
    return row;
  });
  const csv = [headers, ...rows].map(row => row.map(csvBsoEscape).join(';')).join('\r\n');
  downloadBsoBlob(`\uFEFF${csv}`, `БСО_ТЛ2_${todayISO()}.csv`, 'text/csv;charset=utf-8');
  showBsoToast('CSV-файл сформирован');
}

function exportBsoJson() {
  downloadBsoBlob(JSON.stringify(sortedBsoFleet(), null, 2), `БСО_ТЛ2_резервная_копия_${todayISO()}.json`, 'application/json;charset=utf-8');
  showBsoToast('Резервная копия сформирована');
}

async function replaceBsoRecords(records, successMessage) {
  await apiRequest('/bso/import', {method: 'POST', body: JSON.stringify({records})});
  bsoHistoryLoaded = false;
  await refreshBsoState({force: true, render: false});
  renderBsoCurrentView();
  showBsoToast(successMessage);
}

async function importBsoJson(file) {
  if (!file) return;
  try {
    const records = JSON.parse(await file.text());
    if (!Array.isArray(records)) throw new Error('Корневой элемент должен быть массивом');
    const activeBoards = new Set(state.fleet.map(item => String(item.board)));
    const unknown = records.map(item => String(item?.board ?? item?.number ?? '')).filter(board => !activeBoards.has(board));
    if (unknown.length) throw new Error(`В общем парке отсутствуют борта: ${[...new Set(unknown)].join(', ')}`);
    if (!confirm('Загрузить резервную копию? Текущие данные БСО будут заменены.')) return;
    await replaceBsoRecords(records, `Загружено записей: ${records.length}`);
  } catch (error) {
    alert(`Не удалось загрузить резервную копию БСО: ${error.message}`);
  } finally {
    byId('bsoImportJson').value = '';
  }
}

function showBsoToast(message) {
  clearTimeout(bsoToastTimer);
  const toast = byId('bsoToast');
  toast.textContent = message;
  toast.classList.add('show');
  bsoToastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

let openEquipmentTab;

function bindBsoEvents(openTab) {
  openEquipmentTab = openTab;
  if (bsoEventsBound) return;
  bsoEventsBound = true;
  renderBsoCubeFields();
  byId('bsoCashStatus').addEventListener('change', () => syncBsoDeviceInputs('cash'));
  byId('bsoBoard').addEventListener('change', () => loadBsoRecordIntoForm(byId('bsoBoard').value));
  byId('bsoForm').addEventListener('submit', saveBsoForm);
  ['bsoSearch', 'bsoCashFilter', 'bsoKitFilter'].forEach(id => byId(id).addEventListener('input', renderBsoFleet));
  byId('bsoEditorSearch').addEventListener('input', renderBsoEditor);
  byId('bsoTableSearch').addEventListener('input', renderBsoTable);
  byId('bsoHistorySearch').addEventListener('input', renderBsoHistory);
  byId('bsoRefreshHistory').addEventListener('click', () => refreshBsoHistory({force: true}));
  byId('bsoResetFilters').addEventListener('click', () => {
    byId('bsoSearch').value = '';
    byId('bsoCashFilter').value = 'all';
    byId('bsoKitFilter').value = 'all';
    renderBsoFleet();
  });
  byId('bsoFleetGrid').addEventListener('click', handleBsoAction);
  byId('bsoEditableList').addEventListener('click', handleBsoAction);
  byId('bsoExportCsv').addEventListener('click', exportBsoCsv);
  byId('bsoExportJson').addEventListener('click', exportBsoJson);
  byId('bsoImportJson').addEventListener('change', event => importBsoJson(event.target.files?.[0]));
  syncBsoDeviceInputs('cash');
}

export { bindBsoEvents, bsoLoaded, getBsoExcelSheets, refreshBsoHistory, refreshBsoState, renderBsoEditor, renderBsoFleet, renderBsoTable, resetBsoState, showBsoToast, syncBsoWithFleet };
