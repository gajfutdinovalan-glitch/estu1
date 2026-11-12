import { hasModuleAccess } from '../core/access.js';
import { apiRequest } from '../core/api.js';
import { byId, esc, todayISO } from '../core/format.js';
import { state } from '../core/state.js';

const catalog = [
  {id: 'day_1', name: 'Дневная смена №1', kind: 'day', team: 1},
  {id: 'day_2', name: 'Дневная смена №2', kind: 'day', team: 2},
  {id: 'night_1', name: 'Ночная смена №1', kind: 'night', team: 1},
  {id: 'night_2', name: 'Ночная смена №2', kind: 'night', team: 2}
];
let sequence = 0;
let settingsDirty = false;
let pending = null;
const name = id => catalog.find(shift => shift.id === id)?.name || '';
const dateLabel = value => new Date(`${value}T12:00:00+03:00`).toLocaleDateString('ru-RU', {day: '2-digit', month: '2-digit', weekday: 'short', timeZone: 'Europe/Moscow'});

function configureProfile(form, scope, departments, profile = {}) {
  const departmentLabel = form.querySelector('[data-profile-department]');
  const shiftLabel = form.querySelector('[data-profile-shift]');
  const department = departmentLabel.querySelector('select');
  const shift = shiftLabel.querySelector('select');
  departmentLabel.hidden = scope !== 'rel';
  department.required = scope === 'rel';
  department.innerHTML = departments.filter(item => item !== 'Участок заявочных ремонтов').map(item => `<option value="${esc(item)}">${esc(item)}</option>`).join('');
  if (profile.department && [...department.options].some(item => item.value === profile.department)) department.value = profile.department;
  const legacy = Boolean(profile.id && profile.accessScope === 'master' && !profile.shiftId);
  shiftLabel.hidden = scope !== 'master';
  shift.required = scope === 'master' && !legacy;
  shift.innerHTML = `<option value="">${legacy ? 'Общий профиль участка (без смены)' : 'Выберите смену'}</option>`
    + catalog.map(item => `<option value="${item.id}">${item.name}</option>`).join('');
  shift.value = profile.shiftId || '';
}

function showLoginCurrent(data) {
  const current = data?.current;
  byId('loginShiftCurrent').textContent = current ? `Сейчас: ${name(current.id)} · до ${new Date(current.endsAt).toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow'})}` : '';
}

function render(data) {
  const {settings, current} = data;
  byId('shiftCurrent').textContent = `Сейчас: ${name(current.id)} · ${dateLabel(current.workDate)} · до ${new Date(current.endsAt).toLocaleString('ru-RU', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow'})}`;
  if (!byId('shiftFrom').value && data.calendar.length) byId('shiftFrom').value = data.calendar[0].date;
  byId('shiftCalendar').innerHTML = data.calendar.map(day => `<tr class="${day.date === current.workDate ? 'shift-today' : ''}"><th scope="row">${esc(dateLabel(day.date))}</th>${catalog.map(shift => {
    const working = day.team === shift.team;
    const active = day.date === current.workDate && shift.id === current.id;
    const hours = shift.kind === 'day' ? `${settings.dayStart}–${settings.nightStart}` : `${settings.nightStart}–${settings.dayStart}`;
    return `<td class="${working ? 'shift-working' : 'shift-off'}${active ? ' shift-now' : ''}">${working ? esc(hours) : 'Выходной'}${active ? '<span>Сейчас</span>' : ''}</td>`;
  }).join('')}</tr>`).join('');
  byId('shiftSettings').hidden = !data.canManage;
  if (!settingsDirty) {
    byId('shiftAnchor').value = settings.anchorDate;
    byId('shiftDayStart').value = settings.dayStart;
    byId('shiftNightStart').value = settings.nightStart;
  }
}

async function refresh(force = false) {
  if (!state.currentUser || !hasModuleAccess('shifts')) return;
  if (pending && !force) return pending;
  const version = ++sequence;
  const query = new URLSearchParams({days: byId('shiftDays').value});
  if (byId('shiftFrom').value) query.set('from', byId('shiftFrom').value);
  const task = (async () => {
    try {
      const data = await apiRequest(`/shifts?${query}`);
      if (version !== sequence || byId('appShell').hidden) return;
      render(data);
      byId('shiftMessage').textContent = '';
    } catch (error) {
      if (version === sequence) byId('shiftMessage').textContent = error.status === 404 ? 'Для работы со сменами перезапустите сервер ЕСТУ.' : error.message;
    }
  })();
  pending = task;
  try { await task; } finally { if (pending === task) pending = null; }
}

function init() {
  byId('shiftRefresh').addEventListener('click', () => refresh(true));
  byId('shiftFrom').addEventListener('change', () => refresh(true));
  byId('shiftDays').addEventListener('change', () => refresh(true));
  byId('shiftSettings').addEventListener('input', () => { settingsDirty = true; });
  byId('shiftSettings').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      await apiRequest('/shifts', {method: 'PUT', body: JSON.stringify({anchorDate: byId('shiftAnchor').value, dayStart: byId('shiftDayStart').value, nightStart: byId('shiftNightStart').value})});
      settingsDirty = false;
      await refresh(true);
    } catch (error) {
      byId('shiftMessage').textContent = error.message;
    } finally { button.disabled = false; }
  });
}

async function buildExcelReport() {
  const query = new URLSearchParams({days: byId('shiftDays').value});
  if (byId('shiftFrom').value) query.set('from', byId('shiftFrom').value);
  const data = await apiRequest(`/shifts?${query}`);
  const {settings, calendar} = data;
  const from = calendar[0]?.date || todayISO(), to = calendar.at(-1)?.date || from;
  return {title: 'График смен участка заявочных ремонтов', filename: `ЕСТУ_Смены_${from}_${to}.xlsx`, sheets: [
    {name: 'График 2-2', subtitle: `Период ${from} - ${to} · Московское время`, headers: ['Дата', ...catalog.map(s => s.name)], rows: calendar.map(day => [day.date, ...catalog.map(s => day.team === s.team ? (s.kind === 'day' ? `${settings.dayStart} - ${settings.nightStart}` : `${settings.nightStart} - ${settings.dayStart} следующего дня`) : 'Выходной')]), widths: [16, 36, 36, 42, 42]},
    {name: 'Параметры', headers: ['Параметр', 'Значение'], rows: [['Начало цикла смен №1', settings.anchorDate], ['Начало дневной смены', settings.dayStart], ['Начало ночной смены', settings.nightStart], ['Часовой пояс', 'Europe/Moscow'], ['Текущая смена', name(data.current.id)]], widths: [36, 40]}
  ]};
}

export { buildExcelReport, configureProfile, init, name, refresh, showLoginCurrent };
