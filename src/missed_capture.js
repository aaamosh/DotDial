'use strict';

(function installMissedCapture(global) {
  const PROCESSOR_NAME = 'dotdial-missed-capture';
  const SAMPLE_RATE = 48_000;
  const MAX_SEGMENT_SAMPLES = 2_880_000;
  const MAX_PENDING_SEGMENTS = 2;
  const DEFAULT_ACK_TIMEOUT_MS = 1_500;
  const moduleLoads = new WeakMap();

  function codedError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  function safeCode(error, fallback) {
    const code = error && error.code;
    return typeof code === 'string' && /^[a-z0-9_]{1,80}$/i.test(code) ? code : fallback;
  }

  function workletUrl() {
    const base = global.document?.baseURI || global.location?.href || 'file:///';
    return new URL('./missed_worklet.js', base).href;
  }

  class MissedCapture {
    static prepare(context) {
      if (!context || typeof context !== 'object' || !context.audioWorklet ||
          typeof context.audioWorklet.addModule !== 'function') {
        return Promise.reject(codedError('recording_unavailable'));
      }
      const loaded = moduleLoads.get(context);
      if (loaded) return loaded;
      let pending;
      pending = Promise.resolve()
        .then(() => context.audioWorklet.addModule(workletUrl()))
        .catch(() => {
          if (moduleLoads.get(context) === pending) moduleLoads.delete(context);
          throw codedError('recording_unavailable');
        });
      moduleLoads.set(context, pending);
      return pending;
    }

    constructor(context, remoteStream, {
      sourceNode = null,
      onSegment,
      onRecording = () => {},
      onError = () => {},
      ackTimeoutMs = DEFAULT_ACK_TIMEOUT_MS,
    } = {}) {
      this.context = context;
      this.remoteStream = remoteStream;
      this.sourceNode = sourceNode;
      this.onSegment = onSegment;
      this.onRecording = onRecording;
      this.onError = onError;
      this.ackTimeoutMs = Number.isFinite(ackTimeoutMs) && ackTimeoutMs > 0
        ? Math.floor(ackTimeoutMs) : DEFAULT_ACK_TIMEOUT_MS;
      this.source = null;
      this.node = null;
      this.muted = false;
      this.recording = false;
      this.closing = false;
      this.closed = false;
      this.failure = null;
      this.errorSent = false;
      this.nextRequestId = 1;
      this.pendingAcks = new Map();
      this.pendingSegments = new Set();
      this.delivery = Promise.resolve();
      this.assembly = null;
      this.readyWaiter = null;
      this.transition = Promise.resolve();
      this.closePromise = null;

      this.readyPromise = this.initialize();
      this.ready = this.readyPromise;
      // The public promise remains rejectable, while an omitted observer does
      // not create an unhandled-rejection warning in the renderer.
      this.readyPromise.catch(() => {});
    }

    async initialize() {
      try {
        if (typeof this.onSegment !== 'function' ||
            !this.context || this.context.sampleRate !== SAMPLE_RATE ||
            (this.sourceNode
              ? typeof this.sourceNode.connect !== 'function' || typeof this.sourceNode.disconnect !== 'function'
              : typeof this.context.createMediaStreamSource !== 'function' ||
                !this.remoteStream || typeof this.remoteStream.getAudioTracks !== 'function' ||
                this.remoteStream.getAudioTracks().length === 0) ||
            typeof global.AudioWorkletNode !== 'function') {
          throw codedError('recording_unavailable');
        }
        await MissedCapture.prepare(this.context);
        if (this.closing) throw codedError('recording_unavailable');

        this.source = this.sourceNode || this.context.createMediaStreamSource(this.remoteStream);
        this.node = new global.AudioWorkletNode(this.context, PROCESSOR_NAME, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        this.node.port.onmessage = event => this.handleMessage(event && event.data);
        if (typeof this.node.port.start === 'function') this.node.port.start();
        if (typeof this.node.addEventListener === 'function') {
          this.node.addEventListener('processorerror', () => this.fail('recording_failed'));
        } else {
          this.node.onprocessorerror = () => this.fail('recording_failed');
        }

        // Without sourceNode this is a receive-only tap. A supplied sourceNode
        // can also feed a separate live-output branch; disconnect only this tap.
        this.source.connect(this.node);
        this.node.connect(this.context.destination);
        await this.waitUntilReady();
        if (this.failure) throw this.failure;
        return this;
      } catch (error) {
        const failure = this.fail(safeCode(error, 'recording_unavailable'));
        this.disconnect();
        throw failure;
      }
    }

    waitUntilReady() {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.readyWaiter = null;
          reject(this.fail('recording_unavailable'));
        }, this.ackTimeoutMs);
        this.readyWaiter = {
          resolve: () => { clearTimeout(timer); this.readyWaiter = null; resolve(); },
          reject: error => { clearTimeout(timer); this.readyWaiter = null; reject(error); },
        };
      });
    }

    setMuted(muted) {
      if (this.closing || this.closed) return Promise.reject(codedError('recording_unavailable'));
      const nextMuted = muted === true;
      const request = this.transition.then(() => this.applyMuted(nextMuted));
      this.transition = request.catch(() => {});
      return request;
    }

    flush() {
      if (this.closing || this.closed) return Promise.reject(codedError('recording_unavailable'));
      const request = this.transition.then(() => this.applyFlush());
      this.transition = request.catch(() => {});
      return request;
    }

    async applyFlush() {
      if (this.failure) throw this.failure;
      await this.readyPromise;
      if (this.failure) throw this.failure;
      await this.request({ type: 'flush' });
      await this.drainSegments();
      if (this.failure) throw this.failure;
    }

    async applyMuted(muted) {
      if (this.failure) throw this.failure;
      await this.readyPromise;
      if (this.failure) throw this.failure;
      if (this.muted === muted) return;
      await this.request({ type: 'set-muted', muted });
      this.muted = muted;
      this.notifyRecording(muted);
      if (!muted) await this.drainSegments();
      if (this.failure) throw this.failure;
    }

    close() {
      if (this.closePromise) return this.closePromise;
      this.closing = true;
      this.closePromise = this.finishClose();
      return this.closePromise;
    }

    async finishClose() {
      let resultError = null;
      try {
        await this.readyPromise;
        await this.transition;
        if (!this.failure && !this.closed) {
          // The processor flushes an active muted segment before its ACK. Its
          // port remains live until every persistence callback has completed.
          await this.request({ type: 'close' });
          this.muted = false;
          this.notifyRecording(false);
        }
      } catch (error) {
        resultError = this.failure || codedError(safeCode(error, 'recording_unavailable'));
      }

      try {
        await this.drainSegments();
      } catch (error) {
        resultError ||= this.failure || codedError(safeCode(error, 'recording_failed'));
      } finally {
        this.muted = false;
        this.notifyRecording(false);
        this.closed = true;
        this.disconnect();
      }
      if (resultError) throw resultError;
    }

    request(message) {
      if (this.failure) return Promise.reject(this.failure);
      if (!this.node || !this.node.port || typeof this.node.port.postMessage !== 'function') {
        return Promise.reject(this.fail('recording_unavailable'));
      }
      const requestId = this.nextRequestId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const pending = this.pendingAcks.get(requestId);
          if (!pending) return;
          this.pendingAcks.delete(requestId);
          clearTimeout(pending.timer);
          const error = this.fail('recording_unavailable');
          reject(error);
        }, this.ackTimeoutMs);
        this.pendingAcks.set(requestId, { resolve, reject, timer });
        try {
          this.node.port.postMessage({ ...message, requestId });
        } catch {
          this.pendingAcks.delete(requestId);
          clearTimeout(timer);
          reject(this.fail('recording_unavailable'));
        }
      });
    }

    handleMessage(message) {
      if (!message || typeof message !== 'object' || this.failure || this.closed) return;
      if (message.type === 'ready') {
        if (message.sampleRate !== SAMPLE_RATE) {
          const error = this.fail('recording_unavailable');
          this.readyWaiter?.reject(error);
          return;
        }
        this.readyWaiter?.resolve();
        return;
      }
      if (message.type === 'ack') {
        const pending = this.pendingAcks.get(message.requestId);
        if (!pending) return;
        this.pendingAcks.delete(message.requestId);
        clearTimeout(pending.timer);
        pending.resolve(message);
        return;
      }
      if (message.type === 'segment-start') {
        this.startAssembly(message);
        return;
      }
      if (message.type === 'segment-chunk') {
        this.appendChunk(message);
        return;
      }
      if (message.type === 'segment-end') this.endAssembly(message);
    }

    startAssembly(message) {
      if (this.assembly || !Number.isSafeInteger(message.segmentId) ||
          !Number.isSafeInteger(message.preRollSamples) || message.preRollSamples < 0 ||
          this.pendingSegments.size >= MAX_PENDING_SEGMENTS) {
        this.fail('recording_failed');
        return;
      }
      this.assembly = {
        segmentId: message.segmentId,
        continued: message.continued === true,
        parts: [],
        samples: 0,
      };
    }

    appendChunk(message) {
      const assembly = this.assembly;
      if (!assembly || message.segmentId !== assembly.segmentId ||
          !Number.isSafeInteger(message.samples) || message.samples <= 0 ||
          Object.prototype.toString.call(message.pcm) !== '[object ArrayBuffer]' ||
          message.pcm.byteLength !== message.samples * 2 ||
          assembly.samples + message.samples > MAX_SEGMENT_SAMPLES) {
        this.fail('recording_failed');
        return;
      }
      assembly.parts.push(new Uint8Array(message.pcm));
      assembly.samples += message.samples;
    }

    endAssembly(message) {
      const assembly = this.assembly;
      if (!assembly || message.segmentId !== assembly.segmentId ||
          message.sampleRate !== SAMPLE_RATE || !Number.isSafeInteger(message.validSamples) ||
          message.validSamples < 0 || message.validSamples > assembly.samples) {
        this.fail('recording_failed');
        return;
      }
      this.assembly = null;
      if (message.emit !== true || message.validSamples === 0) return;

      const task = this.delivery.then(() => {
        if (this.failure) throw this.failure;
        return this.deliverSegment(assembly.parts, message.validSamples);
      });
      this.delivery = task.catch(error => {
        this.fail(safeCode(error, 'recording_failed'));
      });
      this.pendingSegments.add(task);
      task.catch(error => {
        this.fail(safeCode(error, 'recording_failed'));
      }).finally(() => {
        this.pendingSegments.delete(task);
      });
    }

    async deliverSegment(parts, validSamples) {
      if (typeof global.Blob !== 'function') throw codedError('recording_unavailable');
      const validBytes = validSamples * 2;
      const pcm = await new global.Blob(parts).slice(0, validBytes).arrayBuffer();
      if (this.failure) throw this.failure;
      await this.onSegment({ sampleRate: SAMPLE_RATE, pcm });
    }

    async drainSegments() {
      while (this.pendingSegments.size) {
        await Promise.allSettled(Array.from(this.pendingSegments));
      }
      if (this.failure) throw this.failure;
    }

    notifyRecording(recording) {
      if (this.recording === recording) return;
      this.recording = recording;
      // This reports the muted capture gate, not whether speech currently
      // crosses the VAD threshold.
      try { this.onRecording(recording); } catch {}
    }

    fail(code) {
      if (this.failure) return this.failure;
      this.failure = codedError(code);
      this.muted = false;
      this.notifyRecording(false);
      if (!this.errorSent) {
        this.errorSent = true;
        try { this.onError(this.failure.code); } catch {}
      }
      const error = this.failure;
      this.readyWaiter?.reject(error);
      this.readyWaiter = null;
      for (const pending of this.pendingAcks.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pendingAcks.clear();
      try { this.node?.port?.postMessage({ type: 'abort' }); } catch {}
      this.disconnect();
      return error;
    }

    disconnect() {
      try { if (this.node) this.source?.disconnect(this.node); } catch {}
      try { this.node?.disconnect(); } catch {}
      try { this.node?.port?.close?.(); } catch {}
      this.source = null;
      this.node = null;
    }
  }

  global.MissedCapture = MissedCapture;
})(globalThis);
