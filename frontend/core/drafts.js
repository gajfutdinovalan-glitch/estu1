import { byId } from './format.js';
import { assigneeOptions } from './request-fields.js';
import { state } from './state.js';

function draftFieldEntries(form) {
  const counters = {};
  return Array.from(form.querySelectorAll('input, textarea, select'))
    .filter(field => !['button', 'submit', 'reset', 'file', 'hidden'].includes((field.type || '').toLowerCase()))
    .map((field, index) => {
      const base = field.name
        ? `name:${field.name}`
        : (field.id ? `id:${field.id}` : `index:${index}`);
      const count = counters[base] || 0;
      counters[base] = count + 1;
      return {field, key: `${base}:${count}`};
    });
}

function formDraftKey(form) {
  if (form.id) return `id:${form.id}`;
  const requestCard = form.closest('.request-card[data-id]');
  if (requestCard) {
    const type = form.classList.contains('edit-request-form') ? 'edit' : 'complete';
    return `request:${requestCard.dataset.id}:${type}`;
  }
  const historyCard = form.closest('.history-card[data-id]');
  if (historyCard) return `history:${historyCard.dataset.id}:edit`;
  const userCard = form.closest('.user-card[data-id]');
  if (userCard) {
    const type = form.classList.contains('reset-password-form') ? 'password' : 'edit';
    return `user:${userCard.dataset.id}:${type}`;
  }
  return null;
}

function captureUiDrafts() {
  const root = byId('appShell');
  if (!root || root.hidden) return null;
  const activeElement = document.activeElement;
  const forms = Array.from(root.querySelectorAll('form'))
    .map(form => {
      const key = formDraftKey(form);
      if (!key) return null;
      return {
        key,
        hidden: form.hidden,
        fields: draftFieldEntries(form).map(({field, key: fieldKey}) => ({
          key: fieldKey,
          value: field.value,
          checked: field.checked
        }))
      };
    })
    .filter(Boolean);

  let focus = null;
  const focusForm = activeElement?.closest?.('form');
  if (focusForm && root.contains(focusForm)) {
    const formKey = formDraftKey(focusForm);
    const focusEntry = draftFieldEntries(focusForm).find(entry => entry.field === activeElement);
    if (formKey && focusEntry) {
      focus = {
        formKey,
        fieldKey: focusEntry.key,
        selectionStart: typeof activeElement.selectionStart === 'number' ? activeElement.selectionStart : null,
        selectionEnd: typeof activeElement.selectionEnd === 'number' ? activeElement.selectionEnd : null
      };
    }
  }

  return {forms, focus};
}

function restoreFormVisibility(form, hidden) {
  form.hidden = hidden;
  const requestCard = form.closest('.request-card');
  if (requestCard && form.classList.contains('edit-request-form')) {
    const isEditing = !hidden;
    const completeForm = requestCard.querySelector('.complete-form');
    const editButton = requestCard.querySelector('[data-action="edit-request"]');
    if (completeForm) completeForm.hidden = isEditing;
    if (editButton) editButton.hidden = isEditing;
  }
  const historyCard = form.closest('.history-card');
  if (historyCard && form.classList.contains('edit-history-form')) {
    const editButton = historyCard.querySelector('[data-action="edit-history"]');
    if (editButton) editButton.hidden = !hidden;
  }
}

function restoreFormFields(form, savedForm) {
  const fields = new Map(draftFieldEntries(form).map(entry => [entry.key, entry.field]));
  savedForm.fields.forEach(savedField => {
    const field = fields.get(savedField.key);
    if (!field) return;
    if (field.type === 'checkbox' || field.type === 'radio') {
      field.checked = savedField.checked;
      return;
    }
    if (field.tagName === 'SELECT') {
      const hasOption = Array.from(field.options).some(option => option.value === savedField.value);
      if (hasOption) field.value = savedField.value;
      return;
    }
    field.value = savedField.value;
  });
}

function syncDraftDependentSelects() {
  const requestAssignee = byId('requestAssignee');
  const roleDepartment = state.currentUser?.department || state.departments[0] || '';
  if (requestAssignee) requestAssignee.innerHTML = assigneeOptions(roleDepartment, requestAssignee.value);
}

function restoreUiDrafts(draft) {
  if (!draft) return;
  const root = byId('appShell');
  if (!root || root.hidden) return;
  const forms = new Map(Array.from(root.querySelectorAll('form')).map(form => [formDraftKey(form), form]));
  draft.forms.forEach(savedForm => {
    const form = forms.get(savedForm.key);
    if (!form) return;
    restoreFormVisibility(form, savedForm.hidden);
    restoreFormFields(form, savedForm);
  });
  syncDraftDependentSelects();
  draft.forms.forEach(savedForm => {
    const form = forms.get(savedForm.key);
    if (form) restoreFormFields(form, savedForm);
  });
  if (!draft.focus) return;
  const focusForm = forms.get(draft.focus.formKey);
  if (!focusForm || focusForm.hidden) return;
  const focusField = draftFieldEntries(focusForm).find(entry => entry.key === draft.focus.fieldKey)?.field;
  if (!focusField) return;
  focusField.focus({preventScroll: true});
  if (draft.focus.selectionStart !== null && typeof focusField.setSelectionRange === 'function') {
    focusField.setSelectionRange(draft.focus.selectionStart, draft.focus.selectionEnd);
  }
}

export { captureUiDrafts, restoreUiDrafts };
