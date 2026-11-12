import { MODULES, PERMISSION_LABELS } from './catalog.js';
import { byId } from './format.js';
import { pollApplication } from './refresh.js';
import { activateTab, openModule } from './shell.js';
import { state } from './state.js';
import { handleInitialSetup, handleLogin, handlePasswordVisibility, logout, selectAccessScope } from '../features/auth.js';
import { bindBsoEvents } from '../features/equipment.js';
import { addFleetVehicle, renderFleet } from '../features/fleet.js';
import { renderHistory } from '../features/history.js';
import { createRequest, renderActive } from '../features/journal.js';
import { handleNavigationFieldChange, renderNavigation } from '../features/navigation.js';
import { exportCurrentModuleExcel, exportData, exportPortableData } from '../features/reports.js';
import { createUser, defaultModulesForScope, defaultPermissionsForScope, loadAudit, renderAccessChecks, syncNewUserDisplayName } from '../features/users.js';
import * as Shifts from '../features/shifts.js';

function handleDatePickerClick(event) {
  const button = event.target.closest('.date-picker-button');
  if (!button) return;
  const input = button.dataset.datePicker
    ? byId(button.dataset.datePicker)
    : button.closest('.date-input-shell')?.querySelector('input[type="date"]');
  if (!input || input.disabled) return;
  event.preventDefault();
  input.focus();
  if (typeof input.showPicker === 'function') {
    try {
      input.showPicker();
      return;
    } catch (error) {
      console.debug('Native date picker is unavailable.', error);
    }
  }
  input.click();
}

function bindStaticEvents() {
  window.lucide?.createIcons();
  Shifts.init();
  bindBsoEvents(activateTab);
  document.querySelectorAll('.access-block[data-access-scope]').forEach(button => {
    button.addEventListener('click', () => selectAccessScope(button.dataset.accessScope));
  });
  document.querySelectorAll('[data-module-card]').forEach(button => {
    button.addEventListener('click', () => openModule(button.dataset.moduleCard));
  });
  byId('loginForm').addEventListener('submit', handleLogin);
  byId('setupForm').addEventListener('submit', handleInitialSetup);
  byId('logoutButton').addEventListener('click', logout);
  byId('excelExportButton').addEventListener('click', exportCurrentModuleExcel);
  document.addEventListener('change', handlePasswordVisibility);
  document.addEventListener('click', handleDatePickerClick);
  document.querySelectorAll('.tab').forEach(button => {
    button.addEventListener('click', () => activateTab(button.dataset.tab));
  });
  byId('requestForm').addEventListener('submit', createRequest);
  ['activeSearch', 'activeStatus']
    .forEach(id => byId(id).addEventListener('input', renderActive));
  ['historySearch', 'dateFrom', 'dateTo']
    .forEach(id => byId(id).addEventListener('input', renderHistory));
  byId('fleetSearch').addEventListener('input', renderFleet);
  byId('navigationSearch').addEventListener('input', renderNavigation);
  ['navigationInformer', 'navigationOrbita'].forEach(id => byId(id).addEventListener('change', renderNavigation));
  byId('resetActive').addEventListener('click', () => {
    byId('activeSearch').value = '';
    byId('activeStatus').value = 'all';
    renderActive();
  });
  byId('resetNavigationFilters').addEventListener('click', () => {
    byId('navigationSearch').value = '';
    byId('navigationInformer').value = 'all';
    byId('navigationOrbita').value = 'all';
    renderNavigation();
  });
  byId('navigationGrid').addEventListener('input', handleNavigationFieldChange);
  byId('navigationGrid').addEventListener('change', handleNavigationFieldChange);
  byId('exportJson').addEventListener('click', exportData);
  byId('portableExport')?.addEventListener('click', exportPortableData);
  byId('addFleetForm').addEventListener('submit', addFleetVehicle);
  byId('createUserForm').addEventListener('submit', createUser);
  byId('newUserAccessScope').addEventListener('change', () => {
    const scope = byId('newUserAccessScope').value;
    Shifts.configureProfile(byId('createUserForm'), scope, state.departments);
    syncNewUserDisplayName();
    renderAccessChecks('newUserModules', MODULES, defaultModulesForScope(scope), 'module');
    renderAccessChecks('newUserPermissions', PERMISSION_LABELS, defaultPermissionsForScope(scope), 'permission');
  });
  byId('newUserShift').addEventListener('change', () => syncNewUserDisplayName());
  byId('refreshAudit').addEventListener('click', loadAudit);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !byId('appShell').hidden) pollApplication();
  });
}

export { bindStaticEvents };
