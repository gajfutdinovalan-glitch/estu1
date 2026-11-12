import { ACCESS_SCOPES, MODULES } from './catalog.js';
import { state } from './state.js';

const ACCESS_SCOPE_KEY = 'estu_access_scope';

let selectedAccessScope = ACCESS_SCOPES[localStorage.getItem(ACCESS_SCOPE_KEY)]
  ? localStorage.getItem(ACCESS_SCOPE_KEY)
  : 'rel';

function hasModuleAccess(moduleId) {
  if (!state.currentUser) return false;
  const module = MODULES[moduleId];
  if (!module) return false;
  if (state.currentUser.role === 'admin') return module.roles.includes('admin');
  if (Array.isArray(state.currentUser.modules)) return state.currentUser.modules.includes(moduleId);
  return module.roles.includes(state.currentUser.role);
}

function setAccessScope(scope) {
  selectedAccessScope = scope;
  localStorage.setItem(ACCESS_SCOPE_KEY, scope);
}

export { hasModuleAccess, selectedAccessScope, setAccessScope };
