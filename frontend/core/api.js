const API_BASE = '/api';

async function apiRequest(path, options = {}) {
  const headers = {...(options.headers || {})};
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
  }
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      cache: 'no-store',
      credentials: 'same-origin'
    });
  } catch {
    const error = new Error('Сервер журнала недоступен.');
    error.status = 0;
    throw error;
  }

  const text = response.status === 204 ? '' : await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const error = new Error(payload?.error || payload || response.statusText);
    error.status = response.status;
    throw error;
  }
  return payload;
}

export { API_BASE, apiRequest };
