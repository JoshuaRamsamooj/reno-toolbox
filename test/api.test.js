import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDesignStore } from '../server/db.js';
import { createApp } from '../server/app.js';
import { addRectangle, createDesign, normalize } from '../public/js/core/model.js';

let server;
let base;
let store;

before(async () => {
  store = openDesignStore(':memory:');
  server = createApp(store).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  store.close();
});

const json = (method, path, body) =>
  fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });

function sampleDesign() {
  const d = createDesign('metric');
  addRectangle(d, { x: 0, y: 0 }, { x: 4000, y: 3000 });
  normalize(d);
  d.rooms[0].name = 'Kitchen';
  return d;
}

test('create, list, fetch, update and delete a design', async () => {
  const created = await json('POST', '/api/designs', { name: 'Ground floor', data: sampleDesign(), thumbnail: '<svg/>' });
  assert.equal(created.status, 201);
  const rec = await created.json();
  assert.equal(rec.name, 'Ground floor');
  assert.equal(rec.data.rooms[0].name, 'Kitchen');

  const list = await (await json('GET', '/api/designs')).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].thumbnail, '<svg/>');
  assert.equal(list[0].data, undefined, 'list omits the full design');

  const d = sampleDesign();
  d.rooms[0].name = 'Pantry';
  const updated = await (await json('PUT', `/api/designs/${rec.id}`, { name: 'Ground floor v2', data: d })).json();
  assert.equal(updated.name, 'Ground floor v2');
  const fetched = await (await json('GET', `/api/designs/${rec.id}`)).json();
  assert.equal(fetched.data.rooms[0].name, 'Pantry');
  assert.equal(fetched.data.units, 'metric');

  assert.equal((await json('DELETE', `/api/designs/${rec.id}`)).status, 204);
  assert.equal((await json('GET', `/api/designs/${rec.id}`)).status, 404);
});

test('rejects invalid payloads and ids', async () => {
  assert.equal((await json('POST', '/api/designs', { name: '', data: sampleDesign() })).status, 400);
  assert.equal((await json('POST', '/api/designs', { name: 'x', data: { walls: [] } })).status, 400);
  assert.equal((await json('GET', '/api/designs/abc')).status, 400);
  assert.equal((await json('PUT', '/api/designs/999', { name: 'x', data: sampleDesign() })).status, 404);
  const bad = await fetch(`${base}/api/designs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
  assert.equal(bad.status, 400);
});

test('serves the web app', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Reno Toolbox/);
  assert.equal((await fetch(`${base}/js/core/model.js`)).status, 200);
});
