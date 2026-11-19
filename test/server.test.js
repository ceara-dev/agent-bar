'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventStream } = require('../lib/server');

test('lê eventos SSE e ignora heartbeat', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/event')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': heartbeat\n\n');
      res.write('data: {"id":"evt_1","type":"server.connected","data":{}}\n\n');
      setTimeout(() => res.end(), 20);
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const address = server.address();
  const stream = new EventStream({
    baseUrl: `http://127.0.0.1:${address.port}`,
    maxBackoffMs: 50,
  });

  const event = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout SSE')), 1500);
    stream.on('event', (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    stream.on('parse-error', (error) => {
      clearTimeout(timer);
      reject(new Error(error.error));
    });
    stream.start();
  });

  stream.stop();
  assert.equal(event.type, 'server.connected');
});

test('emite parse-error para evento inválido', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {inválido}\n\n');
    setTimeout(() => res.end(), 20);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const address = server.address();
  const stream = new EventStream({
    baseUrl: `http://127.0.0.1:${address.port}`,
    maxBackoffMs: 50,
  });

  const error = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout SSE')), 1500);
    stream.on('parse-error', (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    stream.start();
  });

  stream.stop();
  assert.match(error.raw, /inválido/);
});
