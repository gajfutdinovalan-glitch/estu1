import { apiRequest } from './api.js';
import { captureUiDrafts, restoreUiDrafts } from './drafts.js';
import { byId } from './format.js';
import { normalizeState, replaceState, state } from './state.js';

let refreshPromise = null;

let stateControlsSignature = '';

let loadedStateParts = {history: false, navigation: false};

async function loadState(announce = false, options = {}) {
  const draft = options.preserveDrafts ? captureUiDrafts() : null;
  const includeHistory = options.includeHistory !== false;
  const includeNavigation = options.includeNavigation !== false;
  const query = new URLSearchParams({
    history: includeHistory ? '1' : '0',
    navigation: includeNavigation ? '1' : '0'
  });
  const payload = await apiRequest(`/state?${query}`);
  replaceState(normalizeState({
    ...payload,
    history: includeHistory ? payload?.history : state.history,
    navigation: includeNavigation ? payload?.navigation : state.navigation
  }));
  if (includeHistory) loadedStateParts.history = true;
  if (includeNavigation) loadedStateParts.navigation = true;
  refreshView.syncFeatures(includeNavigation);
  const nextControlsSignature = JSON.stringify({
    fleet: state.fleet.map(item => [item.board, item.model]),
    departments: state.departments,
    assignees: state.assignableUsers.map(item => [item.id, item.displayName, item.department]),
    user: [state.currentUser?.id, state.currentUser?.displayName, state.currentUser?.department, state.currentUser?.accessScope, state.currentUser?.shiftId, state.currentUser?.modules],
    permissions: state.permissions
  });
  if (nextControlsSignature !== stateControlsSignature) {
    stateControlsSignature = nextControlsSignature;
    refreshView.updateControls();
  }
  if (options.render !== false) refreshView.render();
  restoreUiDrafts(draft);
  refreshView.afterRender({announce, includeNavigation});
}

async function refreshFromServer(announce = true, options = {}) {
  if (byId('appShell').hidden) return;
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const requirements = activeStateRequirements();
      await loadState(announce, {
        preserveDrafts: options.preserveDrafts === true,
        includeHistory: options.includeHistory ?? requirements.includeHistory,
        includeNavigation: options.includeNavigation ?? requirements.includeNavigation
      });
    } catch (error) {
      if (error.status === 401) {
        refreshView.onSessionExpired();
      } else {
        console.warn('Не удалось обновить журнал.', error);
      }
    }
  })();
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

function activeStateRequirements() {
  const activePanelId = document.querySelector('.panel.active-panel')?.id || '';
  return {
    includeHistory: ['dashboard', 'history', 'fleet'].includes(activePanelId),
    includeNavigation: activePanelId === 'navigation'
  };
}

async function ensureActiveStateParts() {
  const requirements = activeStateRequirements();
  const needsHistory = requirements.includeHistory && !loadedStateParts.history;
  const needsNavigation = requirements.includeNavigation && !loadedStateParts.navigation;
  if (!needsHistory && !needsNavigation) return;
  await refreshFromServer(false, {...requirements, preserveDrafts: true});
}

async function pollApplication() {
  if (document.hidden || byId('appShell').hidden) return;
  const requirements = activeStateRequirements();
  await refreshFromServer(true, {...requirements, preserveDrafts: true});
  await refreshView.pollFeatures();
}

function resetRefreshState() {
  refreshPromise = null;
  stateControlsSignature = '';
  loadedStateParts = {history: false, navigation: false};
}

let refreshView;

function configureRefresh(view) {
  refreshView = view;
}

export { configureRefresh, ensureActiveStateParts, loadState, loadedStateParts, pollApplication, refreshFromServer, refreshPromise, resetRefreshState };
