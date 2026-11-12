import { API_BASE, apiRequest } from '../core/api.js';
import { ACCESS_SCOPES, MODULES, PERMISSION_LABELS, ROLE_META, STATUS_META } from '../core/catalog.js';
import { asArray, byId, compareRequests, dt, ruDate, ruDateTime, todayISO } from '../core/format.js';
import { loadState, refreshPromise } from '../core/refresh.js';
import { can, currentModule, state } from '../core/state.js';
import { getBsoExcelSheets, refreshBsoHistory, refreshBsoState, showBsoToast } from './equipment.js';
import { compareFleetBoards } from './fleet.js';
import { getNavigationRecord } from './navigation.js';
import * as Shifts from './shifts.js';
import * as NavControl from './nav-control.js';
import * as Warehouse from './warehouse.js';
import * as RequestFlow from './request-flow.js';
import * as Xlsx from '../shared/xlsx.js';

function exportData() {
  const exportState = {
    fleet: state.fleet,
    requests: state.requests,
    history: state.history,
    exportedAt: new Date().toISOString()
  };
  const blob = new Blob([JSON.stringify(exportState, null, 2)], {type: 'application/json'});
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'uzr-journal-data.json';
  link.click();
  URL.revokeObjectURL(link.href);
}

async function exportPortableData() {
  const button = byId('portableExport');
  button.disabled = true;
  try {
    const response = await fetch(`${API_BASE}/portable/export`, {
      cache: 'no-store',
      credentials: 'same-origin'
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || 'Не удалось сформировать выгрузку.');
    }
    const disposition = response.headers.get('Content-Disposition') || '';
    const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const filename = encodedName ? decodeURIComponent(encodedName) : `ESTU-Test-${todayISO()}.zip`;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(await response.blob());
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  } catch (error) {
    alert(`Не удалось выгрузить тестовые данные: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

function reportSubtitle() {
  return `ЕСТУ · ${state.currentUser?.displayName || 'Пользователь'}`;
}

function buildJournalExcelReport() {
  const activeRows = [...state.requests].sort(compareRequests).map(item => [
    item.board,
    item.model,
    item.description,
    RequestFlow.label(item) || STATUS_META[item.status]?.label || item.status,
    [item.department, item.flow?.shiftId ? Shifts.name(item.flow.shiftId) : ''].filter(Boolean).join(' · '),
    item.createdBy || '',
    ruDateTime(item.createdAt),
    ruDate(item.flow?.plannedDate)
  ]);
  const historyRows = [...state.history].sort((left, right) => dt(right.date) - dt(left.date)).map(item => [
    ruDate(item.date),
    item.board,
    item.model,
    item.description,
    item.workDone || '',
    item.completedBy || '',
    item.source || 'журнал',
    item.note || '',
    STATUS_META[item.status || 'completed']?.label || ''
  ]);
  return {
    title: 'Электронный журнал заявочного ремонта',
    filename: `ЕСТУ_Журнал_${todayISO()}.xlsx`,
    sheets: [
      {name: 'Активные заявки', subtitle: reportSubtitle(), headers: ['Борт', 'Модель', 'Неисправность', 'Очередь', 'Участок / смена', 'От участка', 'Создано', 'Плановая дата'], rows: activeRows, widths: [10, 30, 46, 28, 38, 22, 20, 16]},
      {name: 'История ремонтов', subtitle: reportSubtitle(), headers: ['Дата', 'Борт', 'Модель', 'Неисправность', 'Выполненные работы', 'Исполнитель', 'Источник', 'Примечание', 'Результат'], rows: historyRows, widths: [14, 10, 28, 42, 48, 22, 18, 32, 18]},
      {name: 'Решения', subtitle: reportSubtitle(), headers: ['Борт', 'Время', 'Кто', 'Действие', 'Заметка', 'Участок-получатель', 'Смена', 'Плановая дата'], rows: [...state.requests,...state.history].flatMap(r => (r.flow?.events || []).map(e => [r.board,ruDateTime(e.created_at),e.actor,RequestFlow.actionLabel(e.action)||e.action,e.note,e.to_department,e.to_shift ? Shifts.name(e.to_shift) : '',ruDate(e.planned_date)])), widths: [10,22,24,28,60,38,24,16]},
      {name: 'Заметки ремонта', subtitle: reportSubtitle(), headers: ['Борт', 'Ремонт', 'Время', 'Автор', 'Заметка'], rows: [...state.requests,...state.history].flatMap(r => (r.flow?.notes || []).map(n => [r.board,r.description,ruDateTime(n.createdAt),n.actor,n.text])), widths: [10,42,22,28,70]}
    ]
  };
}

function buildNavigationExcelReport() {
  const rows = [...state.fleet].sort(compareFleetBoards).map(vehicle => {
    const record = getNavigationRecord(vehicle);
    return [vehicle.board, vehicle.model, record.informer, record.orbita ? 'Есть' : 'Нет', record.ai ? 'Да' : 'Нет', record.note || ''];
  });
  return {
    title: 'Учёт информаторов и навигации на подвижном составе',
    filename: `ЕСТУ_Информаторы_${todayISO()}.xlsx`,
    sheets: [{name: 'Информаторы', subtitle: reportSubtitle(), headers: ['Борт', 'Модель', 'Информатор', 'Орбита', 'А/И Орбита', 'Заметка'], rows, widths: [10, 32, 18, 16, 16, 42]}]
  };
}

function buildFleetExcelReport() {
  const requestCounts = state.requests.reduce((result, item) => ({...result, [item.board]: (result[item.board] || 0) + 1}), {});
  const historyCounts = state.history.filter(item => item.status !== 'rejected').reduce((result, item) => ({...result, [item.board]: (result[item.board] || 0) + 1}), {});
  const rows = [...state.fleet].sort(compareFleetBoards).map(vehicle => [
    vehicle.board,
    vehicle.model,
    requestCounts[vehicle.board] || 0,
    historyCounts[vehicle.board] || 0
  ]);
  return {
    title: 'Парк подвижного состава',
    filename: `ЕСТУ_Парк_${todayISO()}.xlsx`,
    sheets: [
      {name: 'Парк', subtitle: reportSubtitle(), headers: ['Борт', 'Модель', 'Активных заявок', 'Ремонтов в истории'], rows, widths: [10, 34, 20, 22]},
      ...buildJournalExcelReport().sheets
    ]
  };
}

function buildUsersExcelReport(users) {
  const rows = users.map(user => {
    const modules = (user.modules || []).map(moduleId => MODULES[moduleId]?.label || moduleId).join(', ');
    const permissions = Object.entries(user.permissions || {}).filter(([, enabled]) => enabled).map(([permission]) => PERMISSION_LABELS[permission] || permission).join(', ');
    return [
      user.displayName,
      ACCESS_SCOPES[user.accessScope]?.label || '',
      ROLE_META[user.role] || user.role,
      user.isActive ? 'Да' : 'Нет',
      user.lastLoginAt ? ruDateTime(user.lastLoginAt) : 'Не входил',
      modules,
      permissions,
      user.department || '',
      Shifts.name(user.shiftId) || 'Без смены'
    ];
  });
  return {
    title: 'Роли и права доступа',
    filename: `ЕСТУ_Роли_${todayISO()}.xlsx`,
    sheets: [{name: 'Роли и права', subtitle: reportSubtitle(), headers: ['Название', 'Блок входа', 'Роль', 'Активна', 'Последний вход', 'Доступные системы', 'Права', 'Участок', 'Смена'], rows, widths: [24, 20, 18, 12, 20, 44, 60, 38, 26]}]
  };
}

async function exportCurrentModuleExcel() {
  const button = byId('excelExportButton');
  if (!currentModule || button.disabled) return;
  const moduleId = currentModule;
  const auditTab = document.querySelector('.panel.active-panel')?.id === 'audit';
  button.disabled = true;
  try {
    let report;
    if (auditTab) {
      if (!can('viewAudit')) throw new Error('Нет доступа к журналу действий.');
      const entries = asArray(await apiRequest('/audit'));
      report = {title: 'Журнал действий', filename: `ЕСТУ_Действия_${todayISO()}.xlsx`, sheets: [{name: 'Журнал действий', subtitle: 'Последние 300 действий · ' + reportSubtitle(), headers: ['Время', 'Сотрудник', 'Действие', 'Объект', 'Идентификатор'], rows: entries.map(e => [ruDateTime(e.createdAt), e.actor, e.action, e.entityType, e.entityId || '']), widths: [22, 28, 28, 28, 40]}]};
    } else if (['journal', 'fleet', 'navigation'].includes(moduleId)) {
      if (refreshPromise) await refreshPromise;
      await loadState(false, {includeHistory: moduleId !== 'navigation', includeNavigation: moduleId === 'navigation', preserveDrafts: true, render: false});
      report = moduleId === 'journal' ? buildJournalExcelReport() : moduleId === 'fleet' ? buildFleetExcelReport() : buildNavigationExcelReport();
    } else if (moduleId === 'navcontrol') report = await NavControl.buildExcelReport();
    else if (moduleId === 'warehouse') report = await Warehouse.buildExcelReport();
    else if (moduleId === 'shifts') report = await Shifts.buildExcelReport();
    else if (moduleId === 'bso') {
      await refreshBsoState({force: true});
      await refreshBsoHistory({force: true});
      report = {title: 'Учёт касс и кубов БСО', filename: `ЕСТУ_БСО_${todayISO()}.xlsx`, sheets: getBsoExcelSheets(reportSubtitle())};
    } else if (moduleId === 'users') {
      if (!can('manageUsers')) throw new Error('Нет доступа к ролям и правам.');
      const profiles = asArray(await apiRequest('/users'));
      report = buildUsersExcelReport(profiles);
    }
    if (!report) throw new Error('Для выбранной системы отчёт пока не настроен.');
    Xlsx.downloadWorkbook(report);
    if (moduleId === 'bso') showBsoToast('Excel-отчёт БСО сформирован');
  } catch (error) {
    alert(`Не удалось сформировать Excel: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

export { exportCurrentModuleExcel, exportData, exportPortableData };
