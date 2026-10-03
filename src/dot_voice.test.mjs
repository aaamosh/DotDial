import test from "node:test";
import assert from "node:assert/strict";
import { DotVoiceError, DotVoiceSession } from "./dot_voice.mjs";

const DOTDIAL_THREAD_ID = "00000000-0000-4000-8000-000000000001";
const PROFILE_ID = "00000000-0000-4000-8000-000000000002~fixture-profile";
const ACCOUNT_ID = "fixture-owner-account";
const identity = async () => ({ email: "owner@example.com", accountId: ACCOUNT_ID, accessToken: "fixture-token" });

test("requires an explicitly supplied identity provider", () => {
  assert.throws(() => new DotVoiceSession(), error => error instanceof DotVoiceError && error.code === "identity_provider_required");
});

test("resolves DotDial's tilde-containing profile and uses it for the full call lifecycle", async () => {
  const requests = [];
  const replies = [
    Response.json({ id: PROFILE_ID, display_name: "DotDial" }),
    new Response("v=0\r\nanswer", { status: 201, headers: { Location: "/v1/realtime/calls/fixture-call?ephemeral=discarded" } }),
    new Response(null, { status: 204 }),
    new Response(null, { status: 204 }),
  ];
  const client = new DotVoiceSession({ threadId: DOTDIAL_THREAD_ID, expectedEmail: "owner@example.com", identity, fetchImpl: async (url, init) => { requests.push({ url, init }); return replies.shift(); } });

  assert.deepEqual(await client.resolveProfile(), {
    profileId: PROFILE_ID,
    threadId: DOTDIAL_THREAD_ID,
    displayName: "DotDial",
  });
  assert.deepEqual(await client.create("v=0\r\noffer"), { answerSdp: "v=0\r\nanswer" });
  await client.attach();
  await client.stop();

  assert.deepEqual(requests.map(({ url, init }) => [init.method, new URL(url).pathname]), [
    ["GET", `/backend-api/tbo/by-thread/${DOTDIAL_THREAD_ID}`],
    ["POST", `/backend-api/tbo/${PROFILE_ID}/voice/calls`],
    ["POST", `/backend-api/tbo/${PROFILE_ID}/voice/calls/fixture-call/attach`],
    ["POST", `/backend-api/tbo/${PROFILE_ID}/voice/calls/fixture-call/stop`],
  ]);
  assert.equal(requests[1].init.body, JSON.stringify({ sdp: "v=0\r\noffer" }));
  for (const { init } of requests) {
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, "Bearer fixture-token");
    assert.equal(init.headers["ChatGPT-Account-ID"], ACCOUNT_ID);
  }
  assert.equal(client.callId, null);
  assert.equal(Object.hasOwn(client, "accessToken"), false);
});

test("rejects another account before making a request", async () => {
  let sent = 0;
  const client = new DotVoiceSession({ threadId: DOTDIAL_THREAD_ID, expectedEmail: "owner@example.com",
    identity: async () => ({ email: "other@example.com", accountId: ACCOUNT_ID, accessToken: "fixture-token" }),
    fetchImpl: async () => { sent++; return Response.json({ id: PROFILE_ID }); },
  });

  await assert.rejects(client.resolveProfile(), { code: "account_mismatch" });
  assert.equal(sent, 0);
});

test("rejects an account switch between profile lookup and call creation", async () => {
  let reads = 0;
  let sent = 0;
  const client = new DotVoiceSession({ threadId: DOTDIAL_THREAD_ID, expectedEmail: "owner@example.com",
    identity: async () => ({ email: "owner@example.com", accountId: ++reads === 1 ? ACCOUNT_ID : "different-account", accessToken: "fixture-token" }),
    fetchImpl: async () => { sent++; return Response.json({ id: PROFILE_ID, display_name: "DotDial" }); },
  });

  await client.resolveProfile();
  await assert.rejects(client.create("v=0\r\noffer"), { code: "account_changed_during_call" });
  assert.equal(sent, 1);
});

test("a lost allocation response cannot trigger a duplicate create", async () => {
  let sent = 0;
  const client = new DotVoiceSession({ threadId: DOTDIAL_THREAD_ID, expectedEmail: "owner@example.com",
    identity,
    fetchImpl: async () => {
      if (++sent === 1) return Response.json({ id: PROFILE_ID, display_name: "DotDial" });
      throw new Error("private transport detail");
    },
  });

  await client.resolveProfile();
  await assert.rejects(client.create("v=0\r\noffer"), error => error.code === "request_outcome_unknown" && !error.message.includes("private"));
  await assert.rejects(client.create("v=0\r\noffer"), { code: "call_creation_already_attempted" });
  assert.equal(sent, 2);
});

test("retains the created call ID when the answer SDP is invalid so cleanup can stop it", async () => {
  const paths = [];
  const replies = [
    Response.json({ id: PROFILE_ID, display_name: "DotDial" }),
    new Response("invalid answer", { status: 201, headers: { Location: "/v1/realtime/calls/fixture-call" } }),
    new Response(null, { status: 204 }),
  ];
  const client = new DotVoiceSession({ threadId: DOTDIAL_THREAD_ID, expectedEmail: "owner@example.com", identity, fetchImpl: async (url, init) => { paths.push([new URL(url).pathname, init.method]); return replies.shift(); } });

  await client.resolveProfile();
  await assert.rejects(client.create("v=0\r\noffer"), { code: "invalid_sdp_answer" });
  await client.stop();
  assert.deepEqual(paths.at(-1), [`/backend-api/tbo/${PROFILE_ID}/voice/calls/fixture-call/stop`, "POST"]);
});

test('plain API detail is classified without retaining raw response text', async () => {
  const client = new DotVoiceSession({ threadId: DOTDIAL_THREAD_ID, expectedEmail: "owner@example.com", identity,
    fetchImpl: async () => Response.json({ detail: 'Call private-call-id was not found; private diagnostic text' }, { status: 409 }),
  });
  await assert.rejects(client.resolveProfile(), error => {
    assert.equal(error.status, 409);
    assert.equal(error.apiReason, 'call_not_found');
    assert.equal(JSON.stringify(error).includes('private'), false);
    return true;
  });
});
