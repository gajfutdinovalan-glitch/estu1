import { REQUEST_STATUS_ORDER } from './catalog.js';

const byId = (id) => document.getElementById(id);

const todayISO = () => new Date().toISOString().slice(0, 10);

const ruDate = (iso) => iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('ru-RU') : '—';

const ruDateTime = (iso) => iso ? new Date(iso).toLocaleString('ru-RU') : '—';

const dt = (iso) => new Date(iso || 0).getTime();

const compareRequests = (left, right) => {
  const statusDifference = (REQUEST_STATUS_ORDER[left.status] ?? 1) - (REQUEST_STATUS_ORDER[right.status] ?? 1);
  return statusDifference || dt(right.createdAt) - dt(left.createdAt);
};

const esc = (value = '') => String(value).replace(/[&<>'"]/g, char => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  "'": '&#39;',
  '"': '&quot;'
}[char]));

const asArray = (value) => Array.isArray(value) ? value : (value == null ? [] : [value]);

export { asArray, byId, compareRequests, dt, esc, ruDate, ruDateTime, todayISO };
