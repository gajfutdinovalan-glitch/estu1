import { hasModuleAccess, selectedAccessScope } from './access.js';
import { ACCESS_SCOPES, MODULES } from './catalog.js';
import { byId, esc } from './format.js';
import { ensureActiveStateParts, loadedStateParts } from './refresh.js';
import { assigneeOptions, statusOptions } from './request-fields.js';
import { can, currentModule, setCurrentModule, state } from './state.js';
import { refreshBsoHistory, refreshBsoState, renderBsoEditor, renderBsoFleet, renderBsoTable } from '../features/equipment.js';
import { renderFleet } from '../features/fleet.js';
import { renderHistory } from '../features/history.js';
import { renderActive, renderDashboard, renderStats } from '../features/journal.js';
import { renderNavigation } from '../features/navigation.js';
import { fillProfileForm, loadAudit, loadUsers } from '../features/users.js';
import * as Shifts from '../features/shifts.js';
import * as NavControl from '../features/nav-control.js';
import * as Warehouse from '../features/warehouse.js';

function applyModuleAccess() {
  if (!state.currentUser) return;
  if (currentModule && !hasModuleAccess(currentModule)) setCurrentModule(null);
  const appShell = byId('appShell');
  if (appShell) appShell.dataset.currentModule = currentModule || '';
  document.querySelectorAll('[data-module-card]').forEach(card => {
    card.hidden = !hasModuleAccess(card.dataset.moduleCard);
  });
  document.querySelectorAll('[data-system-tabs]').forEach(button => {
    const systems = (button.dataset.systemTabs || '').split(/\s+/).filter(Boolean);
    button.hidden = !currentModule || !systems.includes(currentModule) || !hasModuleAccess(currentModule);
  });
  const auditButton = document.querySelector('.tab[data-tab="audit"]');
  if (auditButton) auditButton.hidden = !can('viewAudit') || !currentModule;
  const soundToggle = byId('soundToggle');
  if (soundToggle) soundToggle.hidden = currentModule !== 'journal';
  const excelExportButton = byId('excelExportButton');
  if (excelExportButton) excelExportButton.hidden = !currentModule;
  const appHeroTitle = byId('appHeroTitle');
  const appHeroSubtitle = byId('appHeroSubtitle');
  const activeModule = currentModule ? MODULES[currentModule] : null;
  if (appHeroTitle) {
    appHeroTitle.textContent = activeModule?.heroTitle || '';
    appHeroTitle.hidden = !activeModule;
  }
  if (appHeroSubtitle) appHeroSubtitle.textContent = activeModule?.heroSubtitle || 'Единая система технического учёта';
  document.title = activeModule
    ? `${activeModule.heroTitle} — ЕСТУ`
    : 'ЕСТУ — Единая система технического учёта';
  const title = byId('moduleHubTitle');
  const subtitle = byId('moduleHubSubtitle');
  const scope = ACCESS_SCOPES[selectedAccessScope] || ACCESS_SCOPES.rel;
  if (title) title.textContent = scope.label;
  if (subtitle) subtitle.textContent = scope.hint;
}

function applyPermissions() {
  if (!state.currentUser) return;
  document.querySelectorAll('[data-permission]').forEach(element => {
    element.hidden = !can(element.dataset.permission);
  });
  document.querySelectorAll('[data-admin-only]').forEach(element => {
    element.hidden = state.currentUser.role !== 'admin';
  });
  const scope = ACCESS_SCOPES[selectedAccessScope] || ACCESS_SCOPES.rel;
  byId('userBadge').textContent = scope.label + (state.currentUser.shiftId ? ` · ${Shifts.name(state.currentUser.shiftId) || ''}` : '');
  byId('newRequestScope').textContent = `От участка: ${state.currentUser.displayName}`;
  const activePanel = document.querySelector('.panel.active-panel');
  applyModuleAccess();
  if (activePanel?.hidden) activateTab('moduleHub');
}





function fillSelects() {
  if (!state.currentUser) return;
  const roleDepartment = state.currentUser.department || state.departments[0] || '';
  byId('requestStatus').innerHTML = statusOptions(byId('requestStatus').value || 'waiting');
  byId('activeStatus').innerHTML = statusOptions(byId('activeStatus').value, true);
  byId('requestAssignee').innerHTML = assigneeOptions(roleDepartment, byId('requestAssignee').value);
  byId('fleetBoards').innerHTML = state.fleet
    .map(item => `<option value="${esc(item.board)}">${esc(item.model)}</option>`)
    .join('');
  fillProfileForm();
}

function activateTab(tabId) {
  const targetButton = document.querySelector(`.tab[data-tab="${tabId}"]`);
  const targetPanel = byId(tabId);
  if (!targetButton || !targetPanel || targetButton.hidden || targetPanel.hidden) return;
  if (tabId === 'moduleHub') {
    setCurrentModule(null);
    applyModuleAccess();
  } else {
    const systemTabs = (targetButton.dataset.systemTabs || '').split(/\s+/).filter(Boolean);
    if (systemTabs.length && (!currentModule || !systemTabs.includes(currentModule))) return;
  }
  document.querySelectorAll('.tab').forEach(button => button.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(panel => panel.classList.remove('active-panel'));
  targetButton.classList.add('active');
  targetPanel.classList.add('active-panel');
  renderCurrentView();
  ensureActiveStateParts().catch(error => console.warn('Не удалось загрузить данные открытого раздела.', error));
  if (MODULES.bso.tabs.includes(tabId)) {
    refreshBsoState().catch(error => {
      console.warn('Не удалось загрузить учёт БСО.', error);
      if (tabId === 'bsoFleet') byId('bsoFleetGrid').innerHTML = `<div class="bso-empty">${esc(error.message)}</div>`;
    });
  }
  if (tabId === 'users') loadUsers();
  if (tabId === 'warehouse') Warehouse.refresh();
  if (tabId === 'audit') loadAudit();
  if (tabId === 'navControl' || tabId === 'navControlMail') {
    NavControl.refresh().catch(error => console.warn('Не удалось обновить контроль навигации.', error));
  }
}

function openModule(moduleId) {
  if (!hasModuleAccess(moduleId)) return;
  setCurrentModule(moduleId);
  if (moduleId === 'journal' || moduleId === 'fleet') loadedStateParts.history = false;
  if (moduleId === 'navigation') loadedStateParts.navigation = false;
  applyModuleAccess();
  activateTab(MODULES[moduleId].defaultTab);
  if (moduleId === 'bso') {
    refreshBsoHistory().catch(error => console.warn('Не удалось заранее загрузить историю БСО.', error));
  }
}

function renderCurrentView() {
  if (!state.currentUser) return;
  const activePanel = document.querySelector('.panel.active-panel');
  switch (activePanel?.id) {
    case 'shifts':
      Shifts.refresh();
      break;
    case 'dashboard':
      renderStats();
      renderDashboard();
      break;
    case 'active':
      renderActive();
      break;
    case 'history':
      renderHistory();
      break;
    case 'fleet':
      renderFleet();
      break;
    case 'navigation':
      renderNavigation();
      break;
    case 'bsoFleet':
      renderBsoFleet();
      break;
    case 'bsoEditor':
      renderBsoEditor();
      break;
    case 'bsoTable':
      renderBsoTable();
      break;
    case 'moduleHub':
    default:
      break;
  }
}

export { activateTab, applyPermissions, fillSelects, openModule, renderCurrentView };
