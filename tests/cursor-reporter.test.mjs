import { test } from "node:test";
import assert from "node:assert/strict";
import {
	AGENT,
	inHerdr,
	isSubagent,
	pickModel,
	pickSessionId,
	resolvePaneId,
	runHook,
} from "../plugins/cursor/cat-herdr-model-reporter.mjs";

test("AGENT is the Herdr cursor kind slug", () => {
	assert.equal(AGENT, "cursor");
});

test("inHerdr requires HERDR_ENV=1 and a socket path", () => {
	assert.equal(inHerdr({}), false);
	assert.equal(inHerdr({ HERDR_ENV: "1" }), false);
	assert.equal(inHerdr({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/s" }), true);
	assert.equal(inHerdr({ HERDR_ENV: "0", HERDR_SOCKET_PATH: "/tmp/s" }), false);
});

test("isSubagent detects nested Cursor task hooks", () => {
	assert.equal(isSubagent({}), false);
	assert.equal(isSubagent({ subagent_id: "abc" }), true);
	assert.equal(isSubagent({ parent_conversation_id: "conv-1" }), true);
});

test("pickModel prefers model_id over model", () => {
	assert.equal(pickModel({ model: "slug", model_id: "id" }), "id");
	assert.equal(pickModel({ model: "slug", model_id: "" }), "slug");
	assert.equal(pickModel({ model: "slug" }), "slug");
	assert.equal(pickModel({}), undefined);
});

test("runHook clears stale metadata for Cursor sessionStart stand-in models", async () => {
	const calls = [];
	const requestFn = async (method, params) => {
		calls.push({ method, params });
		if (method === "pane.list") {
			return { result: { panes: [] } };
		}
		return {};
	};
	await runHook(
		{
			hook_event_name: "sessionStart",
			model: "nemotron-ultra-3-free",
			session_id: "conv-1",
		},
		{
			HERDR_ENV: "1",
			HERDR_SOCKET_PATH: "/tmp/s",
			HERDR_PANE_ID: "w1:p1",
		},
		requestFn,
	);
	assert.equal(calls.filter((c) => c.method === "pane.report_metadata").length, 1);
	assert.deepEqual(calls.at(-1).params.tokens, { model: null });
});

test("pickSessionId prefers session_id over conversation_id", () => {
	assert.equal(pickSessionId({ session_id: "s", conversation_id: "c" }), "s");
	assert.equal(pickSessionId({ conversation_id: "c" }), "c");
	assert.equal(pickSessionId({}), undefined);
});

test("resolvePaneId matches cursor agent_session then env pane", () => {
	const panes = [
		{ pane_id: "w1:p1", agent: "claude", agent_session: { value: "s" } },
		{ pane_id: "w1:p2", agent: "cursor", agent_session: { value: "s" } },
		{ pane_id: "w1:p3", agent: "cursor", agent_session: { value: "other" } },
	];
	assert.equal(resolvePaneId(panes, "s", "w1:p9"), "w1:p2");
	assert.equal(resolvePaneId(panes, "missing", "w1:p9"), "w1:p9");
	assert.equal(resolvePaneId(panes, undefined, "w1:p9"), "w1:p9");
	assert.equal(resolvePaneId([], "s", undefined), undefined);
});

test("resolvePaneId refuses an inherited env pane owned by another session", () => {
	assert.equal(
		resolvePaneId(
			[{ pane_id: "w1:p9", agent: "cursor", agent_session: { value: "other" } }],
			"mine",
			"w1:p9",
		),
		undefined,
	);
});

test("runHook is a no-op outside Herdr, for subagents, and without a model", async () => {
	const calls = [];
	const requestFn = async (method, params) => {
		calls.push({ method, params });
	};
	await runHook({ model: "m" }, {}, requestFn);
	await runHook(
		{ model: "m", subagent_id: "x" },
		{ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/s" },
		requestFn,
	);
	await runHook(
		{},
		{ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/s", HERDR_PANE_ID: "w1:p1" },
		requestFn,
	);
	assert.equal(calls.length, 0);
});

test("runHook reports metadata for a matching cursor pane", async () => {
	const calls = [];
	const requestFn = async (method, params) => {
		calls.push({ method, params });
		if (method === "pane.list") {
			return {
				result: {
					panes: [
						{
							pane_id: "w1:p2",
							agent: "cursor",
							agent_session: { value: "conv-1" },
						},
					],
				},
			};
		}
		return {};
	};

	await runHook(
		{ model: "legacy", model_id: "composer-2.5", session_id: "conv-1" },
		{ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/s" },
		requestFn,
	);

	assert.equal(calls.length, 2);
	assert.equal(calls[0].method, "pane.list");
	assert.deepEqual(calls[1], {
		method: "pane.report_metadata",
		params: {
			pane_id: "w1:p2",
			source: "user:cursor-model",
			agent: "cursor",
			tokens: { model: "composer-2.5" },
		},
	});
});

test("runHook clears stale metadata on model-less sessionStart", async () => {
	const calls = [];
	await runHook(
		{ hook_event_name: "sessionStart", session_id: "conv-1" },
		{ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/s" },
		async (method, params) => {
			calls.push({ method, params });
			if (method === "pane.list") {
				return { result: { panes: [{ pane_id: "p", agent: "cursor", agent_session: { value: "conv-1" } }] } };
			}
			return {};
		},
	);

	assert.deepEqual(calls[1].params.tokens, { model: null });
});

test("runHook does not clear a known startup model", async () => {
	const calls = [];
	await runHook(
		{ hook_event_name: "sessionStart", model: "composer-2.5", session_id: "conv-1" },
		{ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/s" },
		async (method, params) => {
			calls.push({ method, params });
			if (method === "pane.list") {
				return { result: { panes: [{ pane_id: "p", agent: "cursor", agent_session: { value: "conv-1" } }] } };
			}
			return {};
		},
	);

	assert.equal(calls.length, 2);
	assert.deepEqual(calls[1].params.tokens, { model: "composer-2.5" });
});
