'use strict';
(() => {
  const player = document.getElementById('replay');
  let finish;
  function stop() {
    finish?.(false); finish = null;
    player.pause(); player.removeAttribute('src'); player.load();
  }
  async function play(url, timeoutMs, outputDevice = "default") {
    stop();
    if (player.setSinkId) await player.setSinkId(await DotDialDevices.resolve(outputDevice, 'audiooutput'));
    else if (outputDevice !== "default") throw new Error("output_device_unsupported");
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => failed(), timeoutMs);
      const done = (complete, error) => {
        clearTimeout(timeout); player.onended = null; player.onerror = null; finish = null;
        if (error) reject(error); else resolve(complete);
      };
      const failed = () => done(false, new Error('playback_failed'));
      finish = done; player.onended = () => done(true); player.onerror = failed;
      player.src = url;
      player.play().catch(failed);
    });
  }
  window.MissedPlayer = { play, stop };
})();
