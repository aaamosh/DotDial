'use strict';

function installQuitBarrier(app, beginShutdown) {
  let started = false;
  app.on('before-quit', event => {
    event.preventDefault();
    if (started) return;
    started = true;
    beginShutdown();
  });
  return () => started;
}

module.exports = { installQuitBarrier };
