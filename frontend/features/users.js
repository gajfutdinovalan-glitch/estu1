import { apiRequest } from '../core/api.js';
import { ACCESS_SCOPES, ACCESS_SCOPE_ROLE, MODULES, PERMISSION_LABELS, ROLE_META } from '../core/catalog.js';
import { asArray, byId, esc, ruDateTime } from '../core/format.js';
import { refreshFromServer } from '../core/refresh.js';
import { can, state } from '../core/state.js';
import * as Shifts from './shifts.js';

let users = [];

let auditEntries = [];

let lastAutoUserDisplayName = '';

function defaultModulesForScope(scope) {
  if (scope === 'warehouse') return ['warehouse'];
  const role = ACCESS_SCOPE_ROLE[scope] || 'executor';
  return Object.entries(MODULES)
    .filter(([, module]) => module.roles.includes(role))
    .map(([id]) => id);
}

function defaultPermissionsForScope(scope) {
  if (scope === 'warehouse') return Object.fromEntries(Object.keys(PERMISSION_LABELS).map(key => [key, false]));
  const role = ACCESS_SCOPE_ROLE[scope] || 'executor';
  return {
    viewAllRequests: role === 'admin' || scope === 'management',
    createRequests: true,
    editRequests: true,
    reassignRequests: ['manager', 'admin'].includes(role),
    completeRequests: scope !== 'management',
    deleteRequests: role === 'admin',
    manageFleet: role === 'admin',
    manageNavigation: ['admin', 'executor'].includes(role),
    manageNavControl: ['admin', 'executor'].includes(role),
    configureNavMail: role === 'admin',
    manageBso: ['admin', 'executor'].includes(role),
    manageHistory: role === 'admin',
    manageUsers: role === 'admin',
    viewAudit: role === 'admin',
    manageShifts: role === 'admin' || scope === 'management'
  };
}

function renderAccessChecks(containerId, source, selected, type) {
  byId(containerId).innerHTML = accessChecksHtml(source, selected, type);
}

function accessChecksHtml(source, selected, type) {
  const selectedSet = new Set(Array.isArray(selected) ? selected : Object.entries(selected || {}).filter(([, value]) => value).map(([key]) => key));
  return Object.entries(source).map(([value, meta]) => {
    const label = typeof meta === 'string' ? meta : meta.label;
    return `<label class="access-check"><input type="checkbox" data-access-${type}="${esc(value)}" ${selectedSet.has(value) ? 'checked' : ''} /> ${esc(label)}</label>`;
  }).join('');
}

function getCheckedValues(root, attribute) {
  return Array.from(root.querySelectorAll(`input[${attribute}]:checked`)).map(input => input.getAttribute(attribute));
}

function getCheckedPermissions(root) {
  return Object.fromEntries(Object.keys(PERMISSION_LABELS).map(permission => [
    permission,
    Boolean(root.querySelector(`input[data-access-permission="${permission}"]`)?.checked)
  ]));
}

function syncNewUserDisplayName(force = false) {
  const input = byId('newUserDisplayName');
  const scopeSelect = byId('newUserAccessScope');
  if (!input || !scopeSelect) return;
  const shift = byId('newUserShift')?.value;
  const label = (ACCESS_SCOPES[scopeSelect.value]?.label || '') + (scopeSelect.value === 'master' && shift ? ` · ${Shifts.name(shift) || ''}` : '');
  if (force || !input.value.trim() || input.value === lastAutoUserDisplayName) {
    input.value = label;
    lastAutoUserDisplayName = label;
  }
}

async function loadUsers() {
  if (!can('manageUsers')) return;
  try {
    users = asArray(await apiRequest('/users'));
    renderUsers();
  } catch (error) {
    alert(`Не удалось загрузить роли: ${error.message}`);
  }
}

async function createUser(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = {
    displayName: byId('newUserDisplayName').value.trim(),
    accessScope: byId('newUserAccessScope').value,
    department: byId('newUserAccessScope').value === 'rel' ? byId('newUserDepartment').value : null,
    shiftId: byId('newUserAccessScope').value === 'master' ? byId('newUserShift').value || null : null,
    password: byId('newUserPassword').value,
    modules: getCheckedValues(form, 'data-access-module'),
    permissions: getCheckedPermissions(form)
  };
  try {
    await apiRequest('/users', {method: 'POST', body: JSON.stringify(payload)});
    event.target.reset();
    fillProfileForm();
    await loadUsers();
    await refreshFromServer(false);
  } catch (error) {
    alert(`Не удалось создать роль: ${error.message}`);
  }
}

function accessScopeOptions(selected) {
  return Object.entries(ACCESS_SCOPES).filter(([, meta]) => meta.available !== false)
    .map(([value, meta]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${meta.label}</option>`)
    .join('');
}

function renderUsers() {
  byId('usersList').innerHTML = users.length ? users.map(user => `
    <article class="user-card" data-id="${esc(user.id)}">
      <form class="edit-user-form">
        <div class="user-card-head">
          <div><b>${esc(user.displayName)}</b><div class="meta">${esc(ACCESS_SCOPES[user.accessScope]?.label || ROLE_META[user.role] || user.role)}${user.shiftId ? ` · ${esc(Shifts.name(user.shiftId) || '')}` : ''}${user.lastLoginAt ? ` · вход: ${ruDateTime(user.lastLoginAt)}` : ''}</div></div>
          <span class="badge ${user.isActive ? 'ok' : ''}">${user.isActive ? 'Активен' : 'Отключён'}</span>
        </div>
        <div class="user-form-grid">
          <label>Название<input name="displayName" value="${esc(user.displayName)}" required /></label>
          <label>Роль / блок входа<select name="accessScope">${accessScopeOptions(user.accessScope || 'rel')}</select></label>
          <label data-profile-department>Участок<select name="department"></select></label>
          <label data-profile-shift hidden>Смена ТО<select name="shiftId"></select></label>
          <label class="checkbox-label"><input name="isActive" type="checkbox" ${user.isActive ? 'checked' : ''} /> Активный профиль</label>
        </div>
        <div class="access-editor compact-access-editor">
          <div>
            <h3>Системы</h3>
            <div class="check-grid">${accessChecksHtml(MODULES, user.modules || defaultModulesForScope(user.accessScope || 'rel'), 'module')}</div>
          </div>
          <div>
            <h3>Права</h3>
            <div class="check-grid permissions-grid">${accessChecksHtml(PERMISSION_LABELS, user.permissions || defaultPermissionsForScope(user.accessScope || 'rel'), 'permission')}</div>
          </div>
        </div>
        <div class="form-actions"><button type="submit">Сохранить</button></div>
      </form>
      <form class="reset-password-form">
        <label>Новый пароль<input name="password" type="password" minlength="4" required autocomplete="new-password" /></label>
        <label class="password-toggle"><input type="checkbox" data-toggle-password-selector='input[name="password"]' data-toggle-password-root=".reset-password-form" /> Показать пароль</label>
        <div class="profile-actions">
          <button type="submit" class="ghost">Сменить пароль</button>
          <button type="button" class="ghost danger delete-user-button" ${String(user.id) === String(state.currentUser?.id) ? 'disabled title="Нельзя удалить текущий профиль"' : ''}>Удалить роль</button>
        </div>
      </form>
    </article>`).join('') : '<div class="empty">Роли не созданы</div>';
  document.querySelectorAll('.edit-user-form').forEach(form => {
    const scopeSelect = form.querySelector('[name="accessScope"]');
    const profile = users.find(user => String(user.id) === form.closest('.user-card').dataset.id);
    Shifts.configureProfile(form, scopeSelect.value, state.departments, profile);
    scopeSelect.addEventListener('change', () => {
      const scope = scopeSelect.value;
      Shifts.configureProfile(form, scope, state.departments, {...profile, shiftId: scope === profile.accessScope ? profile.shiftId : null});
      form.querySelector('.check-grid').innerHTML = accessChecksHtml(MODULES, defaultModulesForScope(scope), 'module');
      form.querySelector('.permissions-grid').innerHTML = accessChecksHtml(PERMISSION_LABELS, defaultPermissionsForScope(scope), 'permission');
    });
    form.addEventListener('submit', updateUser);
  });
  document.querySelectorAll('.reset-password-form').forEach(form => {
    form.addEventListener('submit', resetUserPassword);
  });
  document.querySelectorAll('.delete-user-button').forEach(button => {
    button.addEventListener('click', deleteUser);
  });
}

async function updateUser(event) {
  event.preventDefault();
  const card = event.target.closest('.user-card');
  const form = new FormData(event.target);
  const accessScope = String(form.get('accessScope'));
  const payload = {
    displayName: String(form.get('displayName')).trim(),
    accessScope,
    department: accessScope === 'rel' ? String(form.get('department') || '') : null,
    shiftId: accessScope === 'master' ? String(form.get('shiftId') || '') || null : null,
    isActive: form.get('isActive') === 'on',
    modules: getCheckedValues(event.target, 'data-access-module'),
    permissions: getCheckedPermissions(event.target)
  };
  try {
    await apiRequest(`/users/${encodeURIComponent(card.dataset.id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    await loadUsers();
    await refreshFromServer(false);
  } catch (error) {
    alert(`Не удалось сохранить роль: ${error.message}`);
  }
}

async function resetUserPassword(event) {
  event.preventDefault();
  const card = event.target.closest('.user-card');
  const password = new FormData(event.target).get('password');
  try {
    await apiRequest(`/users/${encodeURIComponent(card.dataset.id)}/password`, {
      method: 'POST',
      body: JSON.stringify({password})
    });
    event.target.reset();
    await loadUsers();
    alert('Пароль изменён.');
  } catch (error) {
    alert(`Не удалось изменить пароль: ${error.message}`);
  }
}

async function deleteUser(event) {
  const card = event.target.closest('.user-card');
  const title = card?.querySelector('.user-card-head b')?.textContent?.trim() || 'эту роль';
  if (!card || !confirm(`Удалить роль «${title}»? Это действие нельзя отменить.`)) return;
  try {
    await apiRequest(`/users/${encodeURIComponent(card.dataset.id)}`, {method: 'DELETE'});
    await loadUsers();
    await refreshFromServer(false);
  } catch (error) {
    alert(`Не удалось удалить роль: ${error.message}`);
  }
}

async function loadAudit() {
  if (!can('viewAudit')) return;
  try {
    auditEntries = asArray(await apiRequest('/audit'));
    renderAudit();
  } catch (error) {
    alert(`Не удалось загрузить журнал действий: ${error.message}`);
  }
}

function renderAudit() {
  byId('auditList').innerHTML = auditEntries.length ? auditEntries.map(entry => `
    <article class="audit-row">
      <div><b>${esc(entry.actor)}</b><span>${esc(entry.action)} · ${esc(entry.entityType)}${entry.entityId ? ` · ${esc(entry.entityId)}` : ''}</span></div>
      <time>${ruDateTime(entry.createdAt)}</time>
    </article>`).join('') : '<div class="empty">Действий пока нет</div>';
}

function fillProfileForm() {
  byId('newUserAccessScope').innerHTML = Object.entries(ACCESS_SCOPES).filter(([, meta]) => meta.available !== false)
    .map(([value, meta]) => `<option value="${value}">${meta.label}</option>`)
    .join('');
  Shifts.configureProfile(byId('createUserForm'), byId('newUserAccessScope').value, state.departments);
  syncNewUserDisplayName(true);
  renderAccessChecks('newUserModules', MODULES, defaultModulesForScope(byId('newUserAccessScope').value), 'module');
  renderAccessChecks('newUserPermissions', PERMISSION_LABELS, defaultPermissionsForScope(byId('newUserAccessScope').value), 'permission');
}

export { createUser, defaultModulesForScope, defaultPermissionsForScope, fillProfileForm, loadAudit, loadUsers, renderAccessChecks, syncNewUserDisplayName };
