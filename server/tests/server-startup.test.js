'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function replaceModule(modulePath, exports) {
  const mock = new Module(modulePath);
  mock.filename = modulePath;
  mock.loaded = true;
  mock.exports = exports;
  require.cache[modulePath] = mock;
}

function loadServerWith(dependencies) {
  const serverPath = require.resolve('../server.js');
  const modulePaths = [
    require.resolve('../app'),
    require.resolve('../config/db'),
    require.resolve('../config/ensure-indexes'),
    require.resolve('../services/break-glass-expiration.service'),
    require.resolve('mongoose')
  ];
  const previous = new Map(modulePaths.map((path) => [path, require.cache[path]]));
  replaceModule(modulePaths[0], dependencies.app);
  replaceModule(modulePaths[1], dependencies.connectDB);
  replaceModule(modulePaths[2], dependencies.ensureIndexes);
  replaceModule(modulePaths[3], dependencies.expireBreakGlass);
  replaceModule(modulePaths[4], dependencies.mongoose);
  delete require.cache[serverPath];

  return {
    server: require(serverPath),
    restore() {
      delete require.cache[serverPath];
      for (const path of modulePaths) {
        if (previous.get(path)) require.cache[path] = previous.get(path);
        else delete require.cache[path];
      }
    }
  };
}

test('server connects, verifies indexes, runs expiry, then begins listening', async () => {
  const events = [];
  const { server, restore } = loadServerWith({
    app: { listen(_port, callback) { events.push('listen'); callback(); return { close(done) { done(); } }; } },
    connectDB: async () => events.push('connect'),
    ensureIndexes: { ensureIndexes: async () => { events.push('indexes'); return { modelCount: 22 }; } },
    expireBreakGlass: { expireBreakGlassAuthorizations: async () => { events.push('expiry'); return { expiredCount: 0 }; } },
    mongoose: { disconnect: async () => events.push('disconnect') }
  });
  try {
    await server.startServer();
    assert.deepEqual(events, ['connect', 'indexes', 'expiry', 'listen']);
    await server.shutdown('test');
  } finally {
    restore();
  }
});

test('index readiness failure prevents HTTP listen and safely disconnects MongoDB', async () => {
  const events = [];
  const indexError = new Error('MongoDB index initialization failed for User');
  indexError.name = 'IndexReadinessError';
  indexError.modelName = 'User';
  const { server, restore } = loadServerWith({
    app: { listen() { events.push('listen'); throw new Error('must not listen'); } },
    connectDB: async () => events.push('connect'),
    ensureIndexes: { ensureIndexes: async () => { events.push('indexes'); throw indexError; } },
    expireBreakGlass: { expireBreakGlassAuthorizations: async () => { events.push('expiry'); return { expiredCount: 0 }; } },
    mongoose: { disconnect: async () => events.push('disconnect') }
  });
  try {
    await assert.rejects(server.startServer(), (error) => error === indexError);
    assert.deepEqual(events, ['connect', 'indexes', 'disconnect']);
  } finally {
    restore();
  }
});
