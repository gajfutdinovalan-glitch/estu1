import { syncContactAlignment } from '../animation/contact-wire.js';
import { selectedAccessScope, setAccessScope } from '../core/access.js';
import { apiRequest } from '../core/api.js';
import { ACCESS_SCOPES } from '../core/catalog.js';
import { byId } from '../core/format.js';
import { loadState, pollApplication, resetRefreshState } from '../core/refresh.js';
import { activateTab, applyPermissions, renderCurrentView } from '../core/shell.js';
import { setCurrentModule, state } from '../core/state.js';
import { resetBsoState } from './equipment.js';
import { resetNotifications, setupNotifications } from './notifications.js';
import * as Shifts from './shifts.js';

const APP_REFRESH_INTERVAL_MS = 30000;

let authMode = 'none';

let refreshTimer = null;



function applyAccessBlocks() {
  const scope = ACCESS_SCOPES[selectedAccessScope] || ACCESS_SCOPES.rel;
  document.querySelectorAll('.access-block[data-access-scope]').forEach(button => {
    const active = button.dataset.accessScope === selectedAccessScope;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const title = byId('authTitle');
  if (title && authMode === 'login') title.textContent = scope.label;
  const selectedTitle = byId('selectedAccessTitle');
  const loginButton = byId('loginButton');
  if (selectedTitle) selectedTitle.textContent = scope.label;
  if (loginButton) loginButton.textContent = 'Войти';
  if (authMode === 'login') {
    const unavailable = scope.available === false;
    byId('loginForm').hidden = unavailable;
    byId('authDevelopment').hidden = !unavailable;
    byId('authDevelopmentText').textContent = unavailable ? `${scope.label}: участок ещё в разработке` : '';
  } else {
    byId('authDevelopment').hidden = true;
  }
  byId('loginShiftField').hidden = selectedAccessScope !== 'master';
}

function selectAccessScope(scopeId) {
  if (!ACCESS_SCOPES[scopeId]) return;
  setAccessScope(scopeId);
  applyAccessBlocks();
  byId('authMessage').textContent = '';
  if (!byId('loginForm')?.hidden) byId('loginPassword').focus();
}

function syncAccessScopeWithUser() {
  if (!state.currentUser) return;
  const scopeByRole = {
    admin: 'admin',
    manager: 'master',
    executor: 'rel'
  };
  const scope = state.currentUser.accessScope || scopeByRole[state.currentUser.role] || selectedAccessScope;
  setAccessScope(scope);
  applyAccessBlocks();
}

function showAuth(mode, message = '') {
  authMode = mode;
  clearInterval(refreshTimer);
  refreshTimer = null;
  byId('appShell').hidden = true;
  byId('authGate').hidden = false;
  syncContactAlignment();
  byId('accessBlocks').hidden = mode !== 'login';
  byId('loginForm').hidden = mode !== 'login';
  byId('setupForm').hidden = mode !== 'setup';
  byId('authMessage').textContent = message;
  applyAccessBlocks();
  if (mode === 'setup') byId('authTitle').textContent = 'Первый администратор';
  if (mode === 'none') byId('authTitle').textContent = 'ЕСТУ';
  if (mode === 'login') byId('loginPassword').focus();
  if (mode === 'setup') byId('setupDisplayName').focus();
}

async function checkAuthentication() {
  try {
    const status = await apiRequest('/auth/status');
    Shifts.showLoginCurrent(status.shiftSchedule);
    if (status.setupRequired) {
      if (status.setupAllowed) {
        showAuth('setup');
      } else {
        showAuth('none', 'Первого администратора нужно создать на серверном компьютере.');
      }
      return;
    }
    if (!status.authenticated) {
      showAuth('login');
      return;
    }
    await enterApplication(status.user);
  } catch (error) {
    showAuth('none', error.message);
  }
}

async function enterApplication(initialUser = null) {
  clearInterval(refreshTimer);
  refreshTimer = null;
  resetRefreshState();
  if (initialUser) {
    state.currentUser = initialUser;
    state.permissions = initialUser.permissions || {};
    syncAccessScopeWithUser();
  }
  byId('authGate').hidden = true;
  byId('appShell').hidden = false;
  syncContactAlignment();
  applyPermissions();
  setCurrentModule(null);
  activateTab('moduleHub');
  setupNotifications();
  const loadInitialState = async () => {
    await loadState(false, {render: false, includeHistory: false, includeNavigation: false});
    renderCurrentView();
  };
  if (initialUser) {
    loadInitialState().catch(error => {
      console.warn('Не удалось загрузить данные после входа.', error);
      showAuth('login', 'Не удалось загрузить данные. Войдите снова.');
    });
  } else {
    await loadInitialState();
  }
  refreshTimer = setInterval(() => pollApplication(), APP_REFRESH_INTERVAL_MS);
}

async function handleLogin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  const submitLabel = submitButton.textContent;
  byId('authMessage').textContent = '';
  form.setAttribute('aria-busy', 'true');
  submitButton.disabled = true;
  submitButton.textContent = 'Вход...';
  try {
    const result = await apiRequest('/auth/block-login', {
      method: 'POST',
      body: JSON.stringify({
        scope: selectedAccessScope,
        shiftId: selectedAccessScope === 'master' ? byId('loginShift').value || null : null,
        password: byId('loginPassword').value
      })
    });
    event.target.reset();
    await enterApplication(result.user);
  } catch (error) {
    byId('authMessage').textContent = error.message;
  } finally {
    form.removeAttribute('aria-busy');
    submitButton.disabled = false;
    submitButton.textContent = submitLabel;
  }
}

async function handleInitialSetup(event) {
  event.preventDefault();
  const password = byId('setupPassword').value;
  if (password !== byId('setupPasswordConfirm').value) {
    byId('authMessage').textContent = 'Пароли не совпадают.';
    return;
  }
  byId('authMessage').textContent = '';
  try {
    const result = await apiRequest('/auth/setup', {
      method: 'POST',
      body: JSON.stringify({
        displayName: byId('setupDisplayName').value.trim(),
        username: byId('setupUsername').value.trim(),
        password
      })
    });
    event.target.reset();
    await enterApplication(result.user);
  } catch (error) {
    byId('authMessage').textContent = error.message;
  }
}

async function logout() {
  try {
    await apiRequest('/auth/logout', {method: 'POST'});
  } catch {
    // Showing the login screen also protects the interface if the server stopped.
  }
  state.currentUser = null;
  setCurrentModule(null);
  resetBsoState();
  resetRefreshState();
  resetNotifications();
  showAuth('login');
}

function handlePasswordVisibility(event) {
  const toggle = event.target.closest('[data-toggle-password], [data-toggle-password-selector]');
  if (!toggle) return;
  const root = toggle.dataset.togglePasswordRoot
    ? toggle.closest(toggle.dataset.togglePasswordRoot)
    : document;
  const inputs = toggle.dataset.togglePasswordSelector
    ? Array.from((root || document).querySelectorAll(toggle.dataset.togglePasswordSelector))
    : String(toggle.dataset.togglePassword || '')
      .split(/\s+/)
      .filter(Boolean)
      .map(id => byId(id))
      .filter(Boolean);
  inputs.forEach(input => {
    if ('type' in input) input.type = toggle.checked ? 'text' : 'password';
  });
}

export { checkAuthentication, handleInitialSetup, handleLogin, handlePasswordVisibility, logout, selectAccessScope, showAuth, syncAccessScopeWithUser };
