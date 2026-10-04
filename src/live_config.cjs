'use strict';

// Wake recognition owns a separate local listener. Its settings can change
// while a call, recovery or replay keeps the remaining configuration pinned.
function selectLiveConfig(current, requested, busy) {
  const config = busy ? { ...current, wakeWord: requested.wakeWord } : requested;
  return { config, pending: JSON.stringify(config) !== JSON.stringify(requested) };
}

module.exports = { selectLiveConfig };
