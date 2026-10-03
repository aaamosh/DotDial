'use strict';

function attachClient(client, dispatch) {
  let buffer = '', accepted = false;
  client.on('error', () => client.destroy());
  client.setTimeout(4000, () => client.destroy());
  client.on('data', data => {
    if (accepted) return;
    buffer += data.toString();
    if (buffer.length > 128) return client.destroy();
    if (!buffer.includes('\n')) return;
    accepted = true;
    const respond = result => {
      if (client.destroyed || !client.writable || client.writableEnded) return;
      client.end(JSON.stringify(result) + '\n');
    };
    try {
      const result = dispatch(buffer.split('\n', 1)[0].trim());
      if (result?.then) result.then(respond, () => respond({ status: 'error', code: 'command_failed' }));
      else respond(result);
    } catch { respond({ status: 'error', code: 'command_failed' }); }
  });
}

module.exports = { attachClient };
