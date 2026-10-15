import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ExperimentalAgyTransport,
  PersistentTransportError,
} from "../lib/agy/persistent-transport.js";

const fixture = fileURLToPath(new URL("./fixtures/persistent-worker-real.mjs", import.meta.url));

function transport(overrides = {}) {
  return new ExperimentalAgyTransport({
    executable: process.execPath,
    args: [fixture],
    maxWorkers: 8,
    maxFrameBytes: 32 * 1024,
    maxOutputBytes: 256 * 1024,
    maxStderrBytes: 8 * 1024,
    idleTtlMs: 5_000,
    readyTimeoutMs: 2_000,
    shutdownTimeoutMs: 500,
    defaultRequestTimeoutMs: 2_000,
    ...overrides,
  });
}

function wait(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function waitForWorkers(tv, expected, attempts=40){
  for(let i=0;i<attempts;i++){
    if(tv.getStats().totalWorkers===expected) return;
    await wait(25);
  }
  assert.equal(tv.getStats().totalWorkers, expected);
}

test("persistent-transport real: 100 sequential same session reuses one worker", async () => {
  const v = transport();
  try{
    for(let i=0;i<100;i++){
      const r = await v.request({ sessionId: "serial-session", text: `message-${i}` });
      assert.equal(r.events.length, 3); // user_input, agent_response, result (init not counted per turn)
      assert.equal(typeof r.firstEventMs, "number");
      assert.equal(r.sessionId, "serial-session");
    }
    assert.deepEqual(v.getStats(), {
      totalWorkers: 1,
      startingWorkers: 0,
      idleWorkers: 1,
      busyWorkers: 0,
      stoppingWorkers: 0,
      maxWorkers: 8,
      disposed: false,
    });
  } finally { await v.dispose(); }
  assert.equal(v.getStats().totalWorkers, 0);
});

test("persistent-transport real: 8 concurrent sessions and max workers", async () => {
  const v = transport({ maxWorkers: 8 });
  try{
    const sessions = Array.from({length:8}, (_,i)=>`session-${i}`);
    const results = await Promise.all(sessions.map(sid=> v.request({ sessionId: sid, text: sid })));
    assert.deepEqual(results.map(r=>r.sessionId).sort(), sessions.sort());
    assert.equal(v.getStats().totalWorkers, 8);
  } finally { await v.dispose(); }

  const limited = transport({ maxWorkers: 2 });
  try{
    const first = limited.request({ sessionId: "limited-a", text: "mode:delay delayMs:100" });
    const second = limited.request({ sessionId: "limited-b", text: "mode:delay delayMs:100" });
    await wait(25);
    await assert.rejects(
      limited.request({ sessionId: "limited-c", text: "normal" }),
      e=> e.code==="WORKER_LIMIT"
    );
    await Promise.all([first, second]);
  } finally { await limited.dispose(); }
});

test("persistent-transport real: idle TTL and crash recovery", async () => {
  const v = transport({ idleTtlMs: 40 });
  try{
    await v.request({ sessionId: "idle-session", text: "normal" });
    await waitForWorkers(v, 1);
    await waitForWorkers(v, 0, 40);
    await assert.rejects(
      v.request({ sessionId: "crash-session", text: "mode:crash" }),
      e=> e.code==="WORKER_CRASHED"
    );
    await waitForWorkers(v, 0);
    const rec = await v.request({ sessionId: "crash-session", text: "recovered" });
    assert.match(rec.events.find(e=>e.event==="result")?.result?.response ?? "", /recovered/);
  } finally { await v.dispose(); }
});

test("persistent-transport real: abort/timeout/output-limit/malformed reset", async () => {
  const v = transport({ idleTtlMs: 5_000 });
  const sid="fault-session";
  try{
    const ac=new AbortController();
    const aborted=v.request({ sessionId: sid, text: "mode:delay delayMs:500", signal: ac.signal });
    setTimeout(()=>ac.abort(),25);
    await assert.rejects(aborted, e=> e.code==="ABORTED");
    await waitForWorkers(v,0);
    const afterAbort=await v.request({ sessionId: sid, text: "after-abort" });
    assert.match(afterAbort.events.find(e=>e.event==="result")?.result?.response ?? "", /after-abort/);

    await assert.rejects(
      v.request({ sessionId: sid, text: "mode:delay delayMs:500", timeoutMs: 25 }),
      e=> e.code==="TIMEOUT"
    );
    await waitForWorkers(v,0);
    const afterTimeout=await v.request({ sessionId: sid, text: "after-timeout" });
    assert.match(afterTimeout.events.find(e=>e.event==="result")?.result?.response ?? "", /after-timeout/);

    await assert.rejects(
      v.request({ sessionId: sid, text: "mode:burst", maxOutputBytes: 256 }),
      e=> e.code==="OUTPUT_LIMIT"
    );
    await waitForWorkers(v,0);
    const afterLimit=await v.request({ sessionId: sid, text: "after-limit" });
    assert.match(afterLimit.events.find(e=>e.event==="result")?.result?.response ?? "", /after-limit/);

    await assert.rejects(
      v.request({ sessionId: sid, text: "mode:malformed" }),
      e=> e.code==="PROTOCOL_ERROR"
    );
    await waitForWorkers(v,0);
    const afterMalformed=await v.request({ sessionId: sid, text: "after-malformed" });
    assert.match(afterMalformed.events.find(e=>e.event==="result")?.result?.response ?? "", /after-malformed/);
  } finally { await v.dispose(); }
});

// A worker cannot answer for a route it was not launched with, and a fresh
// worker that ignores the stored conversation answers without any context.
// Both must be structurally impossible, so the request carries its route.
test("persistent-transport real: route args reach the spawned worker", async () => {
  const v = transport();
  try {
    const r = await v.request({
      sessionId: "route-session",
      text: "mode:argv",
      agent: "dsh-agy-mcp-executor",
      model: "claude-sonnet-4-6",
      reasoningEffort: "medium",
      conversation: "conv-route-1",
      extraArgs: ["--mode", "plan"],
    });
    const response = r.events.find(e=>e.event==="result")?.result?.response ?? "";
    const argv = JSON.parse(response).argv;
    assert.deepEqual(argv, [
      "--agent", "dsh-agy-mcp-executor",
      "--model", "claude-sonnet-4-6",
      "--conversation", "conv-route-1",
      "--effort", "medium",
      "--mode", "plan",
    ], "AGY reads the route at process start, so it must be in the spawn argv");
    assert.equal(r.events.find(e=>e.event==="result")?.result?.conversation_id, "conv-route-1");
  } finally { await v.dispose(); }
});

test("persistent-transport real: a different route gets its own worker", async () => {
  const v = transport();
  try {
    await v.request({ sessionId: "switch-session", text: "first", model: "gemini-3.8-flash" });
    await v.request({ sessionId: "switch-session", text: "second", model: "claude-sonnet-4-6" });
    assert.equal(v.getStats().totalWorkers, 2,
      "one session can switch models; a frozen argv would silently answer with the old one");
  } finally { await v.dispose(); }
});

test("persistent-transport real: a worker that ignores the seed conversation fails before any delta", async () => {
  const v = transport();
  try {
    // `no-resume-*` makes the fixture start a *fresh* id, the shape a stale or
    // evicted conversation has in real AGY. The request must fail, not answer.
    await assert.rejects(
      v.request({ sessionId: "seed-session", text: "mode:argv", conversation: "no-resume-stale-1" }),
      e => e instanceof PersistentTransportError && e.code === "CONVERSATION_MISMATCH",
    );
    await waitForWorkers(v, 0);
  } finally { await v.dispose(); }
});

test("persistent-transport real: a non-SUCCESS result carries AGY's own error text", async () => {
  const v = transport();
  try {
    // The worker's result frame is the only place AGY's failure text appears.
    // The adapter classifies that text (see asLlmError), so it must survive
    // intact here: a proxy-cut stream has to stay recognisable as TRANSPORT.
    const error = await v.request({ sessionId: "error-session", text: "mode:error-eof" })
      .then(() => undefined, e => e);
    assert.ok(error instanceof PersistentTransportError);
    assert.equal(error.code, "WORKER_ERROR");
    assert.match(error.message, /\bEOF\b/);
    assert.match(error.message, /streamGenerateContent/);
  } finally { await v.dispose(); }
});
