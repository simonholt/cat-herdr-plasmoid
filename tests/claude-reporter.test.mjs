import { test } from "node:test";
import assert from "node:assert/strict";
import {
	AGENT,
	SOURCE,
	PREFIX_MATCH_CHARS,
	FLUSH_WAIT_MS,
	inHerdr,
	isSubagent,
	pickModel,
	pickSessionId,
	normalize,
	extractText,
	parseAssistantEntries,
	isSameResponse,
	modelForThisTurn,
	resolvePaneId,
	runHook,
} from "../plugins/claude/cat-herdr-model-reporter.mjs";

const noSleep = async () => {};

function assistantLine({ model, text, sidechain = false }) {
	return JSON.stringify({
		isSidechain: sidechain,
		message: {
			role: "assistant",
			model,
			content: [{ type: "text", text }],
		},
	});
}

test("AGENT and SOURCE identify the Claude reporter", () => {
	assert.equal(AGENT, "claude");
	assert.equal(SOURCE, "user:claude-model");
});

test("inHerdr requires HERDR_ENV=1 and a socket path", () => {
	assert.equal(inHerdr({}), false);
	assert.equal(inHerdr({ HERDR_ENV: "1" }), false);
	assert.equal(inHerdr({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/s" }), true);
	assert.equal(inHerdr({ HERDR_ENV: "0", HERDR_SOCKET_PATH: "/tmp/s" }), false);
});

test("isSubagent detects a subagent's own hook invocation", () => {
	assert.equal(isSubagent({}), false);
	assert.equal(isSubagent(null), false);
	assert.equal(isSubagent({ agent_id: "sub-1" }), true);
});

test("pickModel reads the SessionStart payload model only", () => {
	assert.equal(pickModel({ model: "claude-opus-5" }), "claude-opus-5");
	assert.equal(pickModel({ model: "" }), undefined);
	// Stop carries no model, just the text of the response.
	assert.equal(pickModel({ last_assistant_message: "ok" }), undefined);
});

test("pickSessionId requires a non-empty string", () => {
	assert.equal(pickSessionId({ session_id: "s" }), "s");
	assert.equal(pickSessionId({ session_id: "" }), undefined);
	assert.equal(pickSessionId({}), undefined);
});

test("normalize trims and collapses whitespace", () => {
	assert.equal(normalize("  a   b \n c "), "a b c");
	assert.equal(normalize(undefined), "");
	assert.equal(normalize(42), "");
});

test("extractText concatenates text blocks and ignores thinking blocks", () => {
	assert.equal(
		extractText({
			content: [
				{ type: "thinking", thinking: "hidden" },
				{ type: "text", text: "vis" },
				{ type: "text", text: "ible" },
			],
		}),
		"visible",
	);
	assert.equal(extractText({ content: [] }), "");
	assert.equal(extractText({}), "");
});

test("parseAssistantEntries returns main-thread assistant entries newest first", () => {
	const entries = parseAssistantEntries([
		assistantLine({ model: "old", text: "one" }),
		assistantLine({ model: "new", text: "two" }),
	]);
	assert.deepEqual(entries, [
		{ model: "new", text: "two" },
		{ model: "old", text: "one" },
	]);
});

test("parseAssistantEntries skips sidechain, non-assistant, modelless and malformed lines", () => {
	const entries = parseAssistantEntries([
		"{ truncated mid-line",
		JSON.stringify({ message: { role: "user", content: [] } }),
		JSON.stringify({ message: { role: "assistant", content: [] } }),
		assistantLine({ model: "sub", text: "subagent", sidechain: true }),
		"",
		assistantLine({ model: "real", text: "kept" }),
	]);
	assert.deepEqual(entries, [{ model: "real", text: "kept" }]);
});

test("isSameResponse matches exactly, ignoring whitespace differences", () => {
	assert.equal(isSameResponse("ok", "ok"), true);
	assert.equal(isSameResponse(" ok\n", "ok"), true);
	assert.equal(isSameResponse("ok", "nope"), false);
	assert.equal(isSameResponse("", "ok"), false);
	assert.equal(isSameResponse("ok", ""), false);
});

test("isSameResponse falls back to a prefix compare for truncated messages", () => {
	const long = "x".repeat(PREFIX_MATCH_CHARS + 20);
	// Truncated tail still matches on the compared prefix.
	assert.equal(isSameResponse(long, long.slice(0, PREFIX_MATCH_CHARS)), true);
	// A short mismatch must not match on prefix.
	assert.equal(isSameResponse("abc", "abd"), false);
	// Differing within the compared prefix must not match.
	const other = "y".repeat(PREFIX_MATCH_CHARS + 20);
	assert.equal(isSameResponse(long, other), false);
});

test("modelForThisTurn returns the model of this turn's response", async () => {
	const readEntries = async () => [
		{ model: "claude-sonnet-5", text: "five" },
		{ model: "claude-haiku-4-5", text: "four" },
	];
	assert.equal(
		await modelForThisTurn(readEntries, "five", noSleep),
		"claude-sonnet-5",
	);
	// An older turn resolves to the model that actually served it.
	assert.equal(
		await modelForThisTurn(readEntries, "four", noSleep),
		"claude-haiku-4-5",
	);
});

test("modelForThisTurn waits out the transcript flush race", async () => {
	// First read sees only the previous turn: the new line is not flushed yet.
	const reads = [
		[{ model: "claude-haiku-4-5", text: "four" }],
		[{ model: "claude-haiku-4-5", text: "four" }],
		[
			{ model: "claude-sonnet-5", text: "five" },
			{ model: "claude-haiku-4-5", text: "four" },
		],
	];
	let call = 0;
	const readEntries = async () => reads[Math.min(call++, reads.length - 1)];

	const slept = [];
	const sleep = async (ms) => {
		slept.push(ms);
	};

	assert.equal(
		await modelForThisTurn(readEntries, "five", sleep),
		"claude-sonnet-5",
	);
	// It retried rather than reporting the stale model immediately.
	assert.equal(call, 3);
	assert.deepEqual(slept, [50, 100]);
});

test("modelForThisTurn falls back to the newest entry when the match never lands", async () => {
	let call = 0;
	const readEntries = async () => {
		call += 1;
		return [{ model: "claude-haiku-4-5", text: "four" }];
	};
	// One turn stale beats reporting nothing.
	assert.equal(
		await modelForThisTurn(readEntries, "never-appears", noSleep),
		"claude-haiku-4-5",
	);
	assert.equal(call, FLUSH_WAIT_MS.length);
});

test("modelForThisTurn takes the newest entry when there is no text to match", async () => {
	const readEntries = async () => [
		{ model: "claude-opus-5", text: "" },
		{ model: "claude-haiku-4-5", text: "older" },
	];
	// A turn that emitted only tool calls has no last_assistant_message.
	assert.equal(
		await modelForThisTurn(readEntries, undefined, noSleep),
		"claude-opus-5",
	);
});

test("modelForThisTurn tolerates an unreadable transcript", async () => {
	const readEntries = async () => {
		throw new Error("ENOENT");
	};
	assert.equal(await modelForThisTurn(readEntries, "x", noSleep), undefined);
	assert.equal(await modelForThisTurn(async () => [], "x", noSleep), undefined);
});

test("resolvePaneId matches the pane recording this session", () => {
	const panes = [
		{ pane_id: "w1:p1", agent: "claude", agent_session: { value: "other" } },
		{ pane_id: "w1:p2", agent: "claude", agent_session: { value: "mine" } },
	];
	assert.equal(resolvePaneId(panes, "mine", "w1:p1"), "w1:p2");
});

test("resolvePaneId ignores panes running a different agent", () => {
	const panes = [
		{ pane_id: "w1:p1", agent: "opencode", agent_session: { value: "mine" } },
	];
	assert.equal(resolvePaneId(panes, "mine", undefined), undefined);
});

test("resolvePaneId falls back to HERDR_PANE_ID when the pane is unclaimed", () => {
	assert.equal(resolvePaneId([], "mine", "w1:p9"), "w1:p9");
	assert.equal(
		resolvePaneId(
			[{ pane_id: "w1:p9", agent: "claude", agent_session: {} }],
			"mine",
			"w1:p9",
		),
		"w1:p9",
	);
	assert.equal(resolvePaneId([], "mine", undefined), undefined);
});

test("resolvePaneId refuses an inherited HERDR_PANE_ID owned by another session", () => {
	// The clobber case: a second instance inherited the first instance's env,
	// so reporting to that pane would overwrite the wrong agent's model.
	const panes = [
		{ pane_id: "w1:p1", agent: "claude", agent_session: { value: "theirs" } },
	];
	assert.equal(resolvePaneId(panes, "mine", "w1:p1"), undefined);
});

test("runHook is a no-op outside Herdr, for subagents, and without a session", async () => {
	const calls = [];
	const requestFn = async (method, params) => {
		calls.push({ method, params });
		return { result: { panes: [] } };
	};
	const env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/s" };

	await runHook({ session_id: "s", model: "m" }, {}, requestFn);
	await runHook({ session_id: "s", model: "m", agent_id: "sub" }, env, requestFn);
	await runHook({ model: "m" }, env, requestFn);
	// No model on the payload and no transcript to fall back to.
	await runHook({ session_id: "s" }, env, requestFn);

	assert.deepEqual(calls, []);
});

test("runHook reports the SessionStart payload model for the matching pane", async () => {
	const calls = [];
	const requestFn = async (method, params) => {
		calls.push({ method, params });
		if (method === "pane.list") {
			return {
				result: {
					panes: [
						{
							pane_id: "w1:p2",
							agent: "claude",
							agent_session: { value: "mine" },
						},
					],
				},
			};
		}
		return { result: { type: "ok" } };
	};

	await runHook(
		{ hook_event_name: "SessionStart", session_id: "mine", model: "claude-opus-5" },
		{ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/s" },
		requestFn,
	);

	assert.deepEqual(calls.map((c) => c.method), [
		"pane.list",
		"pane.report_metadata",
	]);
	assert.deepEqual(calls[1].params, {
		pane_id: "w1:p2",
		source: SOURCE,
		agent: AGENT,
		tokens: { model: "claude-opus-5" },
	});
});

test("runHook reads the transcript when the payload carries no model", async () => {
	const calls = [];
	const requestFn = async (method, params) => {
		calls.push({ method, params });
		if (method === "pane.list") {
			return {
				result: {
					panes: [
						{
							pane_id: "w1:p2",
							agent: "claude",
							agent_session: { value: "mine" },
						},
					],
				},
			};
		}
		return { result: { type: "ok" } };
	};

	await runHook(
		{
			hook_event_name: "Stop",
			session_id: "mine",
			last_assistant_message: "five",
		},
		{ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/s" },
		requestFn,
		{
			sleep: noSleep,
			readEntries: async () => [{ model: "claude-sonnet-5", text: "five" }],
		},
	);

	assert.equal(calls[1].params.tokens.model, "claude-sonnet-5");
});

test("runHook swallows a failing pane.list and still resolves via env", async () => {
	const calls = [];
	const requestFn = async (method, params) => {
		calls.push({ method, params });
		if (method === "pane.list") throw new Error("socket down");
		return { result: { type: "ok" } };
	};

	await runHook(
		{ session_id: "mine", model: "claude-opus-5" },
		{ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/s", HERDR_PANE_ID: "w1:p5" },
		requestFn,
	);

	assert.equal(calls[1].params.pane_id, "w1:p5");
});

test("runHook does not throw when the report itself fails", async () => {
	const requestFn = async (method) => {
		if (method === "pane.list") {
			return {
				result: {
					panes: [
						{
							pane_id: "w1:p2",
							agent: "claude",
							agent_session: { value: "mine" },
						},
					],
				},
			};
		}
		throw new Error("socket down");
	};

	await runHook(
		{ session_id: "mine", model: "claude-opus-5" },
		{ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/s" },
		requestFn,
	);
});
