// REST client for the local design store.

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export const api = {
  list: () => request('GET', '/api/designs'),
  get: (id) => request('GET', `/api/designs/${id}`),
  create: (payload) => request('POST', '/api/designs', payload),
  update: (id, payload) => request('PUT', `/api/designs/${id}`, payload),
  remove: (id) => request('DELETE', `/api/designs/${id}`),
};
