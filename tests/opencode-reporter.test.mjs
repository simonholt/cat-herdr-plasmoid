import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	findModel,
	normalizeMessages,
	reportTokens,
	cacheReportedMetadata,
	requestOnce,
	sessionIDFromRoute,
} from "../plugins/opencode/cat-herdr-tui-attached-metadata.js";

test("TUI plugin initializes safely on non-session and active-session routes", async () => {
	const originalEnv = {
		HERDR_ENV: process.env.HERDR_ENV,
		HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
		HERDR_PANE_ID: process.env.HERDR_PANE_ID,
	};
	const socketPath = path.join(
		await fs.mkdtemp(path.join(os.tmpdir(), "cat-herdr-opencode-plugin-")),
		"herdr.sock",
	);
	const server = net.createServer((socket) => {
		socket.on("data", () => socket.end('{"result":{"type":"ok"}}\n'));
	});
	await new Promise((resolve) => server.listen(socketPath, resolve));
	const handlers = new Map();
	const api = {
		route: { current: { name: "home", params: {} } },
		state: { session: { messages: async () => [] } },
		app: { version: "test" },
		event: {
			on(name, handler) {
				handlers.set(name, handler);
				return () => handlers.delete(name);
			},
		},
		lifecycle: { onDispose(handler) { this.dispose = handler; } },
	};
	process.env.HERDR_ENV = "1";
	process.env.HERDR_SOCKET_PATH = socketPath;
	process.env.HERDR_PANE_ID = "pane";
	try {
		await (await import("../plugins/opencode/cat-herdr-tui-attached-metadata.js")).default.tui(api);
		api.route.current = { name: "session", params: { sessionID: "ses_1" } };
		api.state.session.messages = async () => [
			{ info: { role: "assistant", model: { providerID: "p", modelID: "m" } } },
		];
		await handlers.get("message.updated")?.({});
		api.lifecycle.dispose?.();
		assert.equal(handlers.size, 0);
	} finally {
		if (originalEnv.HERDR_ENV === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = originalEnv.HERDR_ENV;
		if (originalEnv.HERDR_SOCKET_PATH === undefined) delete process.env.HERDR_SOCKET_PATH;
		else process.env.HERDR_SOCKET_PATH = originalEnv.HERDR_SOCKET_PATH;
		if (originalEnv.HERDR_PANE_ID === undefined) delete process.env.HERDR_PANE_ID;
		else process.env.HERDR_PANE_ID = originalEnv.HERDR_PANE_ID;
		await new Promise((resolve) => server.close(resolve));
		await fs.rm(socketPath, { force: true });
	}
});

test("a failed report remains eligible for a later successful report", async () => {
	const socketPath = path.join(
		await fs.mkdtemp(path.join(os.tmpdir(), "cat-herdr-opencode-")),
		"herdr.sock",
	);
	let connectionCount = 0;
	const server = net.createServer((socket) => {
		connectionCount += 1;
		socket.on("data", () => {
			socket.end(
				connectionCount === 1
					? '{"error":{"message":"temporary failure"}}\n'
					: '{"result":{"type":"ok"}}\n',
			);
		});
	});
	await new Promise((resolve) => server.listen(socketPath, resolve));
	try {
		const env = { HERDR_PANE_ID: "pane", HERDR_SOCKET_PATH: socketPath };
		const state = { model: undefined, version: undefined };
		const first = await requestOnce("pane.report_metadata", { tokens: { model: "old" } }, env);
		cacheReportedMetadata(state, first, "old", "1");
		assert.equal(first, false);
		assert.deepEqual(state, { model: undefined, version: undefined });

		const second = await requestOnce("pane.report_metadata", { tokens: { model: "new" } }, env);
		cacheReportedMetadata(state, second, "new", "2");
		assert.equal(second, true);
		assert.deepEqual(state, { model: "new", version: "2" });
	} finally {
		await new Promise((resolve) => server.close(resolve));
		await fs.rm(socketPath, { force: true });
	}
});

test("findModel reads direct and nested OpenCode assistant model identities", () => {
	assert.equal(
		findModel([{ role: "assistant", providerID: "anthropic", modelID: "claude-sonnet" }]),
		"anthropic/claude-sonnet",
	);
	assert.equal(
		findModel([
			{
				info: {
					role: "assistant",
					model: { providerID: "openai", modelID: "gpt-5" },
				},
			},
		]),
		"openai/gpt-5",
	);
});

test("findModel prefers the newest assistant and does not fabricate a version", () => {
	assert.equal(
		findModel([
			{ info: { role: "assistant", model: { providerID: "old", modelID: "one" } } },
			{ info: { role: "assistant", model: { providerID: "new", modelID: "two" } } },
		]),
		"new/two",
	);
	assert.equal(findModel([{ role: "assistant", model: { providerID: "only" } }]), undefined);
});

test("normalizeMessages accepts common OpenCode message collection envelopes", () => {
	const messages = [{ info: { role: "assistant", model: { providerID: "p", modelID: "m" } } }];
	for (const envelope of [
		messages,
		{ messages },
		{ data: { result: messages } },
		{ items: messages },
	]) {
		assert.deepEqual(normalizeMessages(envelope), messages);
		assert.equal(findModel(envelope), "p/m");
	}
});

test("sessionIDFromRoute only accepts the current session route", () => {
	assert.equal(sessionIDFromRoute({ name: "session", params: { sessionID: "ses_1" } }), "ses_1");
	assert.equal(sessionIDFromRoute({ name: "session", params: { sessionId: "ses_2" } }), "ses_2");
	assert.equal(sessionIDFromRoute({ name: "home", params: { sessionID: "ses_1" } }), undefined);
});

test("emitted metadata keeps canonical tokens.model and carries app version separately", () => {
	assert.deepEqual(reportTokens("anthropic/claude-sonnet", "1.2.3"), {
		model: "anthropic/claude-sonnet",
		opencode_version: "1.2.3",
	});
	assert.deepEqual(reportTokens("anthropic/claude-sonnet"), {
		model: "anthropic/claude-sonnet",
	});
});

test("reportTokens uses a null model patch to clear stale metadata", () => {
	assert.deepEqual(reportTokens(null, "1.2.3"), { model: null });
});
