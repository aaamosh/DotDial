'use strict';

const { serialize, deserialize } = require('node:v8');

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const SAFE_CODE = /^[a-z0-9_]{1,80}$/i;

function codedError(code, status = null) {
  const error = new Error(code);
  error.code = code;
  if (Number.isInteger(status) && status >= 100 && status <= 599) error.status = status;
  return error;
}

function safeErrorCode(error, fallback = 'media_worker_failed') {
  const code = error && error.code;
  return typeof code === 'string' && SAFE_CODE.test(code) ? code : fallback;
}

function encodeFrame(message) {
  let payload;
  try { payload = serialize(message); }
  catch { throw codedError('media_worker_protocol_error'); }
  if (payload.length === 0 || payload.length > MAX_FRAME_BYTES) {
    throw codedError('media_worker_frame_too_large');
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload], payload.length + 4);
}

function writeFrame(stream, message) {
  if (!stream || stream.destroyed || stream.writableEnded) {
    throw codedError('media_worker_closed');
  }
  try { return stream.write(encodeFrame(message)); }
  catch (error) { throw codedError(safeErrorCode(error, 'media_worker_protocol_error')); }
}

class FrameReader {
  constructor(onMessage, onError = () => {}) {
    this.onMessage = onMessage;
    this.onError = onError;
    this.buffer = Buffer.alloc(0);
    this.failed = false;
  }

  push(chunk) {
    if (this.failed || !chunk?.length) return;
    const input = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let offset = 0;
    while (input.length - offset >= 4) {
      const length = input.readUInt32BE(offset);
      if (length === 0 || length > MAX_FRAME_BYTES) {
        this.fail(length > MAX_FRAME_BYTES ? 'media_worker_frame_too_large' : 'media_worker_protocol_error');
        return;
      }
      if (input.length - offset < length + 4) break;
      const frame = input.subarray(offset + 4, offset + length + 4);
      offset += length + 4;
      let message;
      try { message = deserialize(frame); }
      catch { this.fail('media_worker_protocol_error'); return; }
      try { this.onMessage(message); }
      catch { this.fail('media_worker_protocol_error'); return; }
      if (this.failed) return;
    }
    this.buffer = Buffer.from(input.subarray(offset));
    if (this.buffer.length > MAX_FRAME_BYTES + 4) this.fail('media_worker_frame_too_large');
  }

  end() {
    if (this.failed) return;
    if (this.buffer.length) this.fail('media_worker_protocol_error');
  }

  fail(code) {
    if (this.failed) return;
    this.failed = true;
    this.buffer = Buffer.alloc(0);
    try { this.onError(codedError(code)); } catch {}
  }
}

class RpcConnection {
  constructor(readable, writable, {
    idPrefix = 'p',
    requestTimeoutMs = 30_000,
    onRequest = async () => { throw codedError('media_worker_protocol_error'); },
    onNotification = () => {},
    onEvent = () => {},
    onFailure = () => {},
  } = {}) {
    this.idPrefix = idPrefix;
    this.writable = writable;
    this.requestTimeoutMs = requestTimeoutMs;
    this.onRequest = onRequest;
    this.onNotification = onNotification;
    this.onEvent = onEvent;
    this.onFailure = onFailure;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.failureNotified = false;
    this.reader = new FrameReader(message => this.receive(message), error => this.fail(error));
    this.onData = chunk => this.reader.push(chunk);
    this.onEnd = () => {
      this.reader.end();
      this.fail(codedError('media_worker_eof'));
    };
    this.onReadError = () => this.fail(codedError('media_worker_transport_error'));
    this.onWriteError = () => this.fail(codedError('media_worker_transport_error'));
    readable.on('data', this.onData);
    readable.once('end', this.onEnd);
    readable.once('error', this.onReadError);
    writable.once('error', this.onWriteError);
    readable.resume?.();
  }

  request(method, args = [], timeoutMs = this.requestTimeoutMs) {
    if (this.closed) return Promise.reject(codedError('media_worker_closed'));
    if (typeof method !== 'string' || !/^[a-z][a-z0-9_.-]{0,79}$/i.test(method) || !Array.isArray(args)) {
      return Promise.reject(codedError('media_worker_protocol_error'));
    }
    const id = `${this.idPrefix || 'p'}${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const duration = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : this.requestTimeoutMs;
      const timer = setTimeout(() => {
        const record = this.pending.get(id);
        if (!record) return;
        this.pending.delete(id);
        reject(codedError('media_worker_timeout'));
      }, duration);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try { writeFrame(this.writable, { type: 'request', id, method, args }); }
      catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(codedError(safeErrorCode(error, 'media_worker_transport_error')));
      }
    });
  }

  notify(method, args = []) {
    if (this.closed) return false;
    if (typeof method !== 'string' || !/^[a-z][a-z0-9_.-]{0,79}$/i.test(method) || !Array.isArray(args)) {
      throw codedError('media_worker_protocol_error');
    }
    writeFrame(this.writable, { type: 'notification', method, args });
    return true;
  }

  event(name, payload = null) {
    if (this.closed) return false;
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_.-]{0,79}$/i.test(name)) {
      throw codedError('media_worker_protocol_error');
    }
    writeFrame(this.writable, { type: 'event', name, payload });
    return true;
  }

  receive(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw codedError('media_worker_protocol_error');
    }
    if (message.type === 'response') {
      if (typeof message.id !== 'string') throw codedError('media_worker_protocol_error');
      const pending = this.pending.get(message.id);
      if (!pending) return; // A bounded call timed out; ignore its late response.
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok === true) pending.resolve(message.value);
      else pending.reject(codedError(safeErrorCode(message.error, 'media_worker_failed'), message.error?.status));
      return;
    }
    if (message.type === 'request') {
      if (typeof message.id !== 'string' || typeof message.method !== 'string' || !Array.isArray(message.args)) {
        throw codedError('media_worker_protocol_error');
      }
      Promise.resolve().then(() => this.onRequest(message.method, message.args)).then(
        value => this.respond(message.id, true, value),
        error => this.respond(message.id, false, null, error),
      );
      return;
    }
    if (message.type === 'notification') {
      if (typeof message.method !== 'string' || !Array.isArray(message.args)) throw codedError('media_worker_protocol_error');
      try { this.onNotification(message.method, message.args); } catch {}
      return;
    }
    if (message.type === 'event') {
      if (typeof message.name !== 'string') throw codedError('media_worker_protocol_error');
      try { this.onEvent(message.name, message.payload); } catch {}
      return;
    }
    throw codedError('media_worker_protocol_error');
  }

  respond(id, ok, value = null, error = null) {
    if (this.closed) return;
    const response = ok
      ? { type: 'response', id, ok: true, value }
      : { type: 'response', id, ok: false, error: { code: safeErrorCode(error), status: error?.status } };
    try { writeFrame(this.writable, response); }
    catch (sendError) { this.fail(codedError(safeErrorCode(sendError, 'media_worker_transport_error'))); }
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(codedError(safeErrorCode(error, 'media_worker_closed'), error?.status));
    }
    this.pending.clear();
    if (!this.failureNotified) {
      this.failureNotified = true;
      try { this.onFailure(codedError(safeErrorCode(error, 'media_worker_closed'), error?.status)); } catch {}
    }
  }
}

module.exports = { MAX_FRAME_BYTES, FrameReader, RpcConnection, codedError, safeErrorCode, encodeFrame, writeFrame };
