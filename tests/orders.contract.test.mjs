import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// HTTP test doubles verify Orders' contracts, not the other members' services.
test('Orders: contrats HTTP et persistance avec dependances simulees', async (t) => {
  const key = 'contract-test-only-key-not-for-deployment-32-characters';
  const data = mkdtempSync(join(tmpdir(), 'msoa-orders-contract-'));
  const stubs = [];
  const calls = [];
  const controls = { catalogUnavailable: false, stockUnavailable: false };
  let child;
  let logs = '';
  let firstOrder;
  let orderPort;
  const env = { ...process.env, HOST: '127.0.0.1', DATA_DIR: data, INTERNAL_KEY: key };
  const customer = { name: 'Client test', address: 'Adresse de test', city: 'Casablanca' };
  const body = (quantity = 1) => ({ userId: 'user-test', customer, items: [{ productId: 1, quantity }] });

  async function stub(name, handler) {
    const server = http.createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const input = raw ? JSON.parse(raw) : {};
      calls.push({ service: name, path: req.url, method: req.method, body: input, key: req.headers['x-internal-key'] });
      const result = handler(req, input);
      res.writeHead(result.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    stubs.push(server);
    env[name.toUpperCase() + '_URL'] = 'http://127.0.0.1:' + server.address().port;
  }

  async function request(path, method = 'GET', input, expected = 200, extra = {}) {
    const res = await fetch('http://127.0.0.1:' + orderPort + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token', ...extra },
      body: input === undefined ? undefined : JSON.stringify(input),
      signal: AbortSignal.timeout(5000),
    });
    const output = await res.json();
    assert.equal(res.status, expected, JSON.stringify(output));
    return output;
  }

  async function start() {
    child = spawn(process.execPath, ['backend/services/orders/index.mjs'], {
      env: { ...env, PORT: String(orderPort) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (x) => { logs += x; });
    child.stderr.on('data', (x) => { logs += x; });
    for (let i = 0; i < 60; i++) {
      try { await request('/health'); return; }
      catch {
        if (child.exitCode !== null) throw new Error(logs);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error('Orders startup failed: ' + logs);
  }

  async function stop() {
    if (child && child.exitCode === null) {
      const done = once(child, 'exit');
      child.kill('SIGTERM');
      await done;
    }
  }

  try {
    await stub('auth', (req) => ({
      status: req.headers.authorization?.startsWith('Bearer ') ? 200 : 401,
      body: { id: req.headers.authorization === 'Bearer other-token' ? 'other-user' : 'user-test', role: 'CUSTOMER' },
    }));
    await stub('catalog', () => controls.catalogUnavailable
      ? { status: 503, body: { message: 'Catalog unavailable' } }
      : { body: { id: 1, name: 'Produit test', price: 12.50 } });
    await stub('inventory', () => controls.stockUnavailable
      ? { status: 409, body: { message: 'Insufficient stock' } }
      : { body: { success: true } });
    await stub('payments', (req, input) => ({ body: req.url.endsWith('/refund')
      ? { success: true }
      : { id: 'payment-test', orderId: input.order.id, amount: input.order.total, status: 'SUCCESS' } }));
    await stub('shipping', (req, input) => ({ body: req.url.endsWith('/cancel')
      ? { success: true }
      : { id: 'shipment-test', status: input.status ?? 'PREPARING' } }));
    const socket = net.createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    orderPort = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    await start();

    await t.test('health independant de lauthentification', async () => {
      const result = await request('/health', 'GET', undefined, 200, { Authorization: '' });
      assert.equal(result.service, 'orders');
      assert.equal(result.status, 'UP');
    });
    await t.test('requete anonyme refusee', () => request('/api/orders', 'GET', undefined, 401, { Authorization: '' }));
    await t.test('prix client ignores et produits dupliques agreges', async () => {
      firstOrder = await request('/api/orders', 'POST', {
        ...body(), total: 0.01,
        items: [{ productId: 1, quantity: 1, price: 0.01 }, { productId: 1, quantity: 2, price: 0.01 }],
      });
      assert.equal(firstOrder.total, 37.50);
      assert.equal(firstOrder.status, 'PENDING_PAYMENT');
      assert.equal(firstOrder.items.length, 1);
      assert.equal(firstOrder.items[0].quantity, 3);
      const reserve = calls.find((x) => x.path === '/api/inventory/reserve');
      assert.equal(reserve.body.reservationId, firstOrder.id);
      assert.equal(reserve.key, key);
    });
    await t.test('identite et quantites invalides refusees', async () => {
      await request('/api/orders', 'POST', { ...body(), userId: 'someone-else' }, 403);
      await request('/api/orders', 'POST', body(0), 400);
    });
    await t.test('lecture protegee par le proprietaire', async () => {
      await request('/api/orders/' + firstOrder.id, 'GET', undefined, 403, { Authorization: 'Bearer other-token' });
      await request('/api/orders?userId=someone-else', 'GET', undefined, 403);
      const list = await request('/api/orders');
      assert.equal(list.length, 1);
    });
    await t.test('creation idempotente et conflit de contenu', async () => {
      const headers = { 'Idempotency-Key': 'same-checkout' };
      const a = await request('/api/orders', 'POST', body(), 200, headers);
      const b = await request('/api/orders', 'POST', body(), 200, headers);
      assert.equal(a.id, b.id);
      assert.equal(calls.filter((x) => x.path === '/api/inventory/reserve' && x.body.reservationId === a.id).length, 1);
      await request('/api/orders', 'POST', body(2), 409, headers);
    });
    await t.test('stock insuffisant refuse sans paiement', async () => {
      controls.stockUnavailable = true;
      const before = calls.filter((x) => x.service === 'payments').length;
      try { await request('/api/orders', 'POST', body(), 409); }
      finally { controls.stockUnavailable = false; }
      assert.equal(calls.filter((x) => x.service === 'payments').length, before);
    });
    await t.test('panne Catalog renvoyee en 503', async () => {
      controls.catalogUnavailable = true;
      try { await request('/api/orders', 'POST', body(), 503); }
      finally { controls.catalogUnavailable = false; }
    });
    await t.test('client interdit de forcer PAID ou une action interne', async () => {
      await request('/api/orders/' + firstOrder.id + '/status', 'PATCH', { status: 'PAID' }, 403);
      await request('/internal/orders/' + firstOrder.id + '/action', 'POST', { action: 'PAY', method: 'CARD' }, 403);
    });
    await t.test('paiement et livraison coordonnes par Orders', async () => {
      const path = '/internal/orders/' + firstOrder.id + '/action';
      const headers = { 'X-Internal-Key': key };
      await request(path, 'POST', { action: 'PAY', method: 'CARD' }, 200, headers);
      assert.equal((await request('/api/orders/' + firstOrder.id)).status, 'PAID');
      const payment = calls.find((x) => x.path === '/internal/payments/' + firstOrder.id + '/capture');
      assert.equal(payment.body.order.total, 37.50);
      await request(path, 'POST', { action: 'PREPARE' }, 200, headers);
      await request(path, 'POST', { action: 'SHIP' }, 200, headers);
      await request('/api/orders/' + firstOrder.id + '/cancel', 'POST', {}, 409);
      await request(path, 'POST', { action: 'TRANSIT' }, 200, headers);
      await request(path, 'POST', { action: 'DELIVER' }, 200, headers);
      assert.equal((await request('/api/orders/' + firstOrder.id)).status, 'DELIVERED');
    });
    await t.test('annulation repetee sans double liberation', async () => {
      const order = await request('/api/orders', 'POST', body());
      await request('/api/orders/' + order.id + '/cancel', 'POST', {});
      await request('/api/orders/' + order.id + '/cancel', 'POST', {});
      assert.equal((await request('/api/orders/' + order.id)).status, 'CANCELLED');
      assert.equal(calls.filter((x) => x.path === '/api/inventory/release' && x.body.reservationId === order.id).length, 1);
    });
    await t.test('commandes conservees apres redemarrage', async () => {
      await stop();
      await start();
      assert.equal((await request('/api/orders/' + firstOrder.id)).status, 'DELIVERED');
    });
  } finally {
    await stop();
    await Promise.all(stubs.map((server) => new Promise((resolve) => server.close(resolve))));
    rmSync(data, { recursive: true, force: true });
  }
});
