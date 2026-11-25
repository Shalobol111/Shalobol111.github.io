import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createSiteServer } from './server.mjs';

const sample = {
  name: 'Тест Заявки', phone: '8 (900) 000-00-00',
  service: 'launch', comment: 'Проверка формы', consent: true,
};

async function fixture(t, deliver) {
  const server = createSiteServer({ deliver, logger: { error() {} } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  return {
    origin,
    post: (body = sample, headers = {}) => fetch(origin + '/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, ...headers },
      body: JSON.stringify(body),
    })
  };
}

test('site and document pages serve from the same origin', async t => {
  const { origin } = await fixture(t);
  const main = await fetch(origin);
  assert.equal(main.status, 200);
  assert.match(await main.text(), /Онлайн-бухгалтерия/);
  const documents = await fetch(origin + '/documents');
  assert.equal(documents.status, 200);
  assert.match(await documents.text(), /Политика конфиденциальности/);
  assert.equal((await fetch(origin + '/assets/golos-cyrillic.woff2')).status, 200);
  assert.equal((await fetch(origin + '/assets/viktoria.webp')).status, 200);
});

test('success follows delivery and the service and phone are normalized', async t => {
  let captured;
  const { post } = await fixture(t, async lead => { captured = lead; });
  const response = await post();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(captured, {
    name: 'Тест Заявки', phone: '+79000000000',
    service: 'Открытие онлайн-бизнеса', comment: 'Проверка формы',
  });
});

test('invalid input, wrong origin and excessive bodies never reach delivery', async t => {
  let sent = 0;
  const { post } = await fixture(t, async () => { sent += 1; });
  assert.equal((await post({ ...sample, phone: '123' })).status, 400);
  assert.equal((await post({ ...sample, consent: false })).status, 400);
  assert.equal((await post({ ...sample, service: 'toString' })).status, 400);
  assert.equal((await post({ ...sample, website: 'https://example.test' })).status, 400);
  assert.equal((await post({ ...sample, comment: 'x'.repeat(10_000) })).status, 413);
  assert.equal((await post(sample, { Origin: 'https://example.test' })).status, 403);
  assert.equal(sent, 0);
});

test('failed delivery and preview never report success', async t => {
  const live = await fixture(t, async () => { throw new Error('SMTP down'); });
  const preview = await fixture(t);
  for (const site of [live, preview]) {
    const response = await site.post();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false });
  }
});

test('per-address request limit stops excess deliveries', async t => {
  let sent = 0;
  const { post } = await fixture(t, async () => { sent += 1; });
  for (let i = 0; i < 5; i++) assert.equal((await post()).status, 200);
  const response = await post();
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '900');
  assert.equal(sent, 5);
});

