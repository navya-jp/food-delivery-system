/**
 * Real HTTP test client (fetch-based).
 * Every call goes over a real TCP connection to the running stack (default http://localhost:8080,
 * i.e. the gateway container started by `docker compose up`). Nothing is invoked in-process.
 */
export const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';

async function call(method, path, body, headers = {}) {
  const res = await fetch(BASE_URL + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed, headers: Object.fromEntries(res.headers.entries()) };
}

export const request = {
  get: (path, headers) => call('GET', path, undefined, headers),
  post: (path, body = {}, headers) => call('POST', path, body, headers),
  put: (path, body = {}, headers) => call('PUT', path, body, headers),
  patch: (path, body = {}, headers) => call('PATCH', path, body, headers)
};
