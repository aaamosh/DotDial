'use strict';
(() => {
  const player = document.getElementById('replay');
  let finish;
  let generation = 0;
  function stop() {
    generation++;
    finish?.(false); finish = null;
    player.pause(); player.removeAttribute('src'); player.load();
  }
  async function play(url, timeoutMs, outputDevice = "default") {
    stop();
    const playbackGeneration = ++generation;
    const current = () => playbackGeneration === generation;
    if (player.setSinkId) {
      const sinkId = await DotDialDevices.resolve(outputDevice, 'audiooutput');
      if (!current()) return false;
      await player.setSinkId(sinkId);
      if (!current()) return false;
    }
    else if (outputDevice !== "default") throw new Error("output_device_unsupported");
    if (!current()) return false;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => failed(), timeoutMs);
      const done = (complete, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (finish === done) finish = null;
        if (player.onended === ended) player.onended = null;
        if (player.onerror === failed) player.onerror = null;
        if (error) reject(error); else resolve(complete);
      };
      const failed = () => done(false, new Error('playback_failed'));
      const ended = () => done(true);
      finish = done; player.onended = ended; player.onerror = failed;
      player.src = url;
      player.play().catch(failed);
    });
  }
  window.MissedPlayer = { play, stop };
})();
