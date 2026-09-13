#!/usr/bin/env node
// Reports the active GitHub Copilot CLI model to Herdr.
// Copilot hook payloads do not contain the resolved model. The only
// authoritative value available here is the newest session.model_change event
// in the session event log. If it is absent, fail open rather than reporting a
// stale value while pretending to have identified a switch.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const AGENT = "copilot";
export const SOURCE = "user:copilot-model";
export const TAIL_BYTES = 256 * 1024;
export const SOCKET_TIMEOUT_MS = 2000;

export function inHerdr(env) {
	return env?.HERDR_ENV === "1" && Boolean(env?.HERDR_SOCKET_PATH);
}

function nonEmptyString(value) {
	return typeof value === "string" && value ? value : undefined;
}

export function pickSessionId(hook) {
	return nonEmptyString(hook?.sessionId) || nonEmptyString(hook?.session_id);
}

export function eventsPathForSession(sessionId, env = process.env) {
	const home = env.COPILOT_HOME || path.join(env.HOME ?? "", ".copilot");
	return path.join(home, "session-state", sessionId, "events.jsonl");
}

export function lastModelChange(eventsPath) {
	let handle;
	try {
		handle = fs.openSync(eventsPath, "r");
		const size = fs.fstatSync(handle).size;
		const length = Math.min(size, TAIL_BYTES);
		const buf = Buffer.alloc(length);
		fs.readSync(handle, buf, 0, length, size - length);
		for (const line of buf.toString("utf8").split("\n").reverse()) {
			if (!line.trim()) continue;
			let entry;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry?.type !== "session.model_change") continue;
			const model = nonEmptyString(entry.data?.newModel);
			if (model) return model;
		}
	} catch {
		return undefined;
	} finally {
		if (handle !== undefined) {
			try {
				fs.closeSync(handle);
			} catch {}
		}
	}
	return undefined;
}

// There is no event identifier or hook timestamp in Copilot's payload. A
// retry therefore cannot prove that a newly-read event belongs to this hook.
// Read once and report only an event-backed value; otherwise do nothing.
export function modelForSession(sessionId, env = process.env, readModel = lastModelChange) {
	return readModel(eventsPathForSession(sessionId, env));
}

export function resolvePaneId(panes, sessionId, envPaneId) {
	const list = Array.isArray(panes) ? panes : [];
	if (sessionId) {
		const match = list.find(
			(p) => p?.agent === AGENT && p?.agent_session?.value === sessionId && nonEmptyString(p?.pane_id),
		);
		if (match) return match.pane_id;
	}
	const fallback = nonEmptyString(envPaneId);
	if (!fallback) return undefined;
	const pane = list.find((p) => p?.pane_id === fallback);
	const owner = nonEmptyString(pane?.agent_session?.value);
	if (owner && sessionId && owner !== sessionId) return undefined;
	return fallback;
}

export async function runHook(hook, env, requestFn, deps = {}) {
	if (!inHerdr(env)) return;
	const sessionId = pickSessionId(hook);
	if (!sessionId) return;
	let model;
	try {
		model = modelForSession(sessionId, env, deps.readModel || lastModelChange);
	} catch {
		return;
	}
	if (!model) return;

	let panes;
	try {
		const response = await requestFn("pane.list", {});
		panes = response?.result?.panes;
	} catch {
		return;
	}
	const paneId = resolvePaneId(panes, sessionId, env.HERDR_PANE_ID);
	if (!paneId) return;
	try {
		await requestFn("pane.report_metadata", {
			pane_id: paneId,
			source: SOURCE,
			agent: AGENT,
			tokens: { model },
		});
	} catch {
		// Hooks are best effort and must never affect Copilot.
	}
}

function socketRequest(socketPath, method, params) {
	const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
	const payload = JSON.stringify({ id: `cat-herdr:${Date.now()}`, method, params });
	return new Promise((resolve, reject) => {
		let buffer = "";
		const client = net.createConnection(endpoint, () => client.write(`${payload}\n`));
		client.setTimeout(SOCKET_TIMEOUT_MS, () => {
			client.destroy();
			reject(new Error("timeout"));
		});
		client.on("data", (chunk) => (buffer += chunk.toString()));
		client.on("end", () => {
			try {
				resolve(JSON.parse(buffer));
			} catch {
				reject(new Error("bad json"));
			}
		});
		client.on("error", reject);
	});
}

export async function main(env = process.env, input = process.stdin) {
	if (!inHerdr(env)) return;
	let hook = {};
	try {
		const raw = await new Promise((resolve, reject) => {
			let data = "";
			input.setEncoding("utf8");
			input.on("data", (chunk) => (data += chunk));
			input.on("end", () => resolve(data));
			input.on("error", reject);
		});
		if (raw.trim()) hook = JSON.parse(raw);
	} catch {
		return;
	}
	await runHook(hook, env, (method, params) => socketRequest(env.HERDR_SOCKET_PATH, method, params));
}

if (
	process.argv[1] &&
	pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
	await main();
}
