import { STATUS_META } from './catalog.js';
import { esc } from './format.js';
import { state } from './state.js';

function statusOptions(selected, includeAll = false) {
  const options = [];
  if (includeAll) options.push('<option value="all">Все статусы</option>');
  for (const status of ['new', 'waiting', 'in_progress']) {
    options.push(`<option value="${status}" ${status === selected ? 'selected' : ''}>${STATUS_META[status].label}</option>`);
  }
  return options.join('');
}

function assigneeOptions(department, selectedId = '') {
  const options = ['<option value="">Не назначен</option>'];
  for (const user of state.assignableUsers.filter(item => item.department === department)) {
    const selected = String(user.id) === String(selectedId) ? 'selected' : '';
    options.push(`<option value="${esc(user.id)}" ${selected}>${esc(user.displayName)}</option>`);
  }
  return options.join('');
}

function statusBadge(status) {
  const meta = STATUS_META[status] || STATUS_META.waiting;
  return `<span class="badge ${meta.className}">${meta.label}</span>`;
}

export { assigneeOptions, statusBadge, statusOptions };
