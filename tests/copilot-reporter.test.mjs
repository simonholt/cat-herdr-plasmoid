import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	AGENT,
	SOURCE,
	inHerdr,
	pickSessionId,
	lastModelChange,
	modelForSession,
	resolvePaneId,
	runHook,
} from "../plugins/copilot/cat-herdr-model-reporter.mjs";

test("Copilot reporter identifies its canonical agent and source", () => {
	assert.equal(AGENT, "copilot");
	assert.equal(SOURCE, "user:copilot-model");
});

test("Copilot hook gating and session payload parsing are conservative", () => {
	assert.equal(inHerdr({}), false);
	assert.equal(inHerdr({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/s" }), true);
	assert.equal(pickSessionId({ sessionId: "a" }), "a");
	assert.equal(pickSessionId({ session_id: "b" }), "b");
	assert.equal(pickSessionId({}), undefined);
});

test("lastModelChange reads the newest valid model-change event", async () => {

	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cat-herdr-copilot-"));
	const events = path.join(dir, "events.jsonl");
	await fs.writeFile(events, [
		JSON.stringify({ type: "session.model_change", data: { newModel: "old" } }),
		"not json",
		JSON.stringify({ type: "session.model_change", data: { newModel: "new" } }),
	].join("\n"));
	assert.equal(lastModelChange(events), "new");
});

test("modelForSession does not retry or claim an unidentified switch", () => {
	let reads = 0;
	assert.equal(
		modelForSession("s", { HOME: "/tmp" }, () => {
			reads += 1;
			return undefined;
		}),
		undefined,
	);
	assert.equal(reads, 1);
});

test("resolvePaneId rejects a known mismatching pane owner", () => {
	assert.equal(
		resolvePaneId(
			[{ pane_id: "p", agent: "copilot", agent_session: { value: "other" } }],
			"mine",
			"p",
		),
		undefined,
	);
});

test("runHook fails open for pane and socket failures", async () => {
	const calls = [];
	await runHook(
		{ sessionId: "s" },
		{ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/s", HERDR_PANE_ID: "p" },
		async (method, params) => {
			calls.push({ method, params });
			throw new Error("socket down");
		},
		{ readModel: () => "gpt-5" },
	);
	assert.deepEqual(calls, [{ method: "pane.list", params: {} }]);
});

test("runHook preserves canonical metadata for an event-backed model", async () => {
	const calls = [];
	await runHook(
		{ sessionId: "s" },
		{ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/s" },
		async (method, params) => {
			calls.push({ method, params });
			if (method === "pane.list") {
				return { result: { panes: [{ pane_id: "p", agent: "copilot", agent_session: { value: "s" } }] } };
			}
			return { result: { type: "ok" } };
		},
		{ readModel: () => "gpt-5" },
	);
	assert.deepEqual(calls[1], {
		method: "pane.report_metadata",
		params: {
			pane_id: "p",
			source: SOURCE,
			agent: AGENT,
			tokens: { model: "gpt-5" },
		},
	});
});
