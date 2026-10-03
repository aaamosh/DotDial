'use strict';

// Technical counters only: no SDP, addresses, device identifiers or conversation.
(() => {
  const inboundCounters = ['packetsReceived', 'packetsLost', 'packetsDiscarded', 'bytesReceived',
    'totalSamplesReceived', 'concealedSamples', 'silentConcealedSamples', 'concealmentEvents',
    'jitterBufferDelay', 'jitterBufferEmittedCount', 'jitterBufferTargetDelay', 'jitterBufferMinimumDelay',
    'totalAudioEnergy', 'insertedSamplesForDeceleration', 'removedSamplesForAcceleration'];
  const playoutCounters = ['synthesizedSamplesDuration', 'synthesizedSamplesEvents', 'totalPlayoutDelay',
    'totalSamplesCount', 'totalSamplesDuration'];
  const pick = (r, keys) => Object.fromEntries(keys.filter(k => Number.isFinite(r[k])).map(k => [k, r[k]]));
  const sum = (rows, keys) => Object.fromEntries(keys.filter(k => rows.some(r => Number.isFinite(r[k])))
    .map(k => [k, rows.reduce((n, r) => n + (r[k] || 0), 0)]));
  const maximum = (rows, key) => Math.max(0, ...rows.map(r => r[key] || 0));
  class AudioDiagnostics {
    constructor() { this.previous = new Map(); this.history = []; this.lastTimestamp = null; }
    collect(reports) {
      const incoming = [], outgoing = [], playout = [], remote = [], deltas = [];
      let input, pair, latestTimestamp = 0;
      const next = new Map();
      for (const r of reports.values()) {
        latestTimestamp = Math.max(latestTimestamp, r.timestamp || 0);
        if (r.type === 'inbound-rtp' && r.kind === 'audio') {
          const row = { ...pick(r, [...inboundCounters, 'ssrc', 'jitter', 'audioLevel']),
            codec: reports.get(r.codecId)?.mimeType };
          incoming.push(row);
          const previous = this.previous.get(r.id);
          if (previous && r.totalSamplesReceived >= previous.totalSamplesReceived) {
            deltas.push(Object.fromEntries(inboundCounters.map(k => [k, Math.max(0, (r[k] || 0) - (previous[k] || 0))])));
          }
          next.set(r.id, row);
        }
        if (r.type === 'outbound-rtp' && r.kind === 'audio') {
          outgoing.push(pick(r, ['packetsSent', 'bytesSent', 'totalPacketSendDelay']));
          // replaceTrack leaves old media-source reports in some Chromium builds.
          // Follow the active sender rather than selecting the longest-lived silence.
          input = reports.get(r.mediaSourceId) || input;
        }
        if (r.type === 'remote-inbound-rtp' && r.kind === 'audio') remote.push(pick(r, ['ssrc', 'packetsLost', 'fractionLost', 'jitter', 'roundTripTime']));
        if (r.type === 'media-playout' && r.kind === 'audio') playout.push(pick(r, playoutCounters));
        if (r.type === 'transport' && r.selectedCandidatePairId) pair = reports.get(r.selectedCandidatePairId);
      }
      const result = { ...sum(incoming, inboundCounters), ...sum(outgoing, ['packetsSent', 'bytesSent', 'totalPacketSendDelay']),
        jitter: maximum(incoming, 'jitter'), audioLevel: maximum(incoming, 'audioLevel'),
        inbound_streams: incoming, microphone_transport: remote, playout: sum(playout, playoutCounters) };
      if (input) { result.inputAudioLevel = input.audioLevel; result.inputAudioDuration = input.totalSamplesDuration; }
      if (pair) {
        Object.assign(result, { roundTripTime: pair.currentRoundTripTime, availableOutgoingBitrate: pair.availableOutgoingBitrate,
          transport: reports.get(pair.localCandidateId)?.protocol,
          local_candidate_type: reports.get(pair.localCandidateId)?.candidateType,
          remote_candidate_type: reports.get(pair.remoteCandidateId)?.candidateType });
      }
      if (deltas.length && this.lastTimestamp !== null && latestTimestamp > this.lastTimestamp) {
        const delta = sum(deltas, inboundCounters);
        const interval = { duration_ms: Math.round(latestTimestamp - this.lastTimestamp), packets: delta.packetsReceived,
          lost: delta.packetsLost, samples: delta.totalSamplesReceived, concealed: delta.concealedSamples,
          concealed_voiced: Math.max(0, delta.concealedSamples - delta.silentConcealedSamples),
          stretched: delta.insertedSamplesForDeceleration, compressed: delta.removedSamplesForAcceleration,
          jitter_ms: Math.round(result.jitter * 1000), rtt_ms: Math.round((result.roundTripTime || 0) * 1000) };
        if (delta.jitterBufferEmittedCount > 0) {
          interval.buffer_ms = Math.round(1000 * delta.jitterBufferDelay / delta.jitterBufferEmittedCount);
          interval.target_ms = Math.round(1000 * delta.jitterBufferTargetDelay / delta.jitterBufferEmittedCount);
        }
        this.history.push(interval);
        if (this.history.length > 60) this.history.shift();
      }
      this.previous = next; this.lastTimestamp = latestTimestamp;
      result.recent_intervals = this.history.slice();
      return result;
    }
  }
  if (typeof module !== 'undefined') module.exports = { AudioDiagnostics };
  else globalThis.AudioDiagnostics = AudioDiagnostics;
})();
