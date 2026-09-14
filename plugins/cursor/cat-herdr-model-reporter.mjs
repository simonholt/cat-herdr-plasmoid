#!/usr/bin/env node
// Reports the active Cursor Agent model to Herdr so the plasmoid can display it.
//
// One-shot hook: sessionStart, beforeSubmitPrompt, stop.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const AGENT = "cursor";
export const SOURCE = "user:cursor-model";
const SOCKET_TIMEOUT_MS = 2000;

export function inHerdr(env) {
	return env.HERDR_ENV === "1" && Boolean(env.HERDR_SOCKET_PATH);
}

export function isSubagent(hook) {
	if (!hook || typeof hook !== "object") return false;
	if (hook.subagent_id) return true;
	if (hook.parent_conversation_id) return true;
	return false;
}

function nonEmptyString(value) {
	return typeof value === "string" && value ? value : undefined;
}

export function isReportableModel(model) {
	if (!nonEmptyString(model)) return false;
	const lower = model.toLowerCase();
	if (lower.includes("nemotron")) return false;
	if (lower.endsWith("-free") || lower.includes(":free")) return false;
	return true;
}

export function pickModel(hook) {
	const preferred = nonEmptyString(hook?.model_id) || nonEmptyString(hook?.model);
	if (isReportableModel(preferred)) return preferred;
	const fallback = nonEmptyString(hook?.model);
	if (fallback !== preferred && isReportableModel(fallback)) return fallback;
	return undefined;
}

export function pickSessionId(hook) {
	return nonEmptyString(hook?.session_id) || nonEmptyString(hook?.conversation_id);
}

export function isStartupHook(hook) {
	const name = hook?.hook_event_name || hook?.event_name;
	return typeof name === "string" && name.toLowerCase() === "sessionstart";
}

export function resolvePaneId(panes, sessionId, envPaneId) {
	if (Array.isArray(panes) && sessionId) {
		const match = panes.find(
			(p) =>
				p?.agent === AGENT &&
				p?.agent_session?.value === sessionId &&
				nonEmptyString(p?.pane_id),
		);
		if (match) return match.pane_id;
	}

	const fallback = nonEmptyString(envPaneId);
	if (!fallback) return undefined;
	const envPane = Array.isArray(panes)
		? panes.find((p) => p?.pane_id === fallback)
		: undefined;
	const owner = nonEmptyString(envPane?.agent_session?.value);
	if (owner && sessionId && owner !== sessionId) return undefined;
	return fallback;
}

export async function runHook(hook, env, requestFn) {
	if (!inHerdr(env)) return;
	if (isSubagent(hook)) return;
	const model = pickModel(hook);
	const startup = isStartupHook(hook);
	if (!model && !startup) return;

	let panes;
	try {
		const response = await requestFn("pane.list", {});
		panes = response?.result?.panes;
	} catch {
		panes = undefined;
	}

	const paneId = resolvePaneId(
		panes,
		pickSessionId(hook),
		env.HERDR_PANE_ID,
	);
	if (!paneId) return;
	if (startup && !model) {
		try {
			await requestFn("pane.report_metadata", {
				pane_id: paneId,
				source: SOURCE,
				agent: AGENT,
				tokens: { model: null },
			});
		} catch {
			// Socket unreachable — nothing to do.
		}
		return;
	}

	try {
		await requestFn("pane.report_metadata", {
			pane_id: paneId,
			source: SOURCE,
			agent: AGENT,
			tokens: { model },
		});
	} catch {
		// Socket unreachable — nothing to do.
	}
}

function socketRequest(socketPath, method, params) {
	const endpoint =
		process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
	const payload = JSON.stringify({
		id: `cat-herdr:${Date.now()}`,
		method,
		params,
	});

	return new Promise((resolve, reject) => {
		let buffer = "";
		const client = net.createConnection(endpoint, () => {
			client.write(payload + "\n");
		});
		client.setTimeout(SOCKET_TIMEOUT_MS, () => {
			client.destroy();
			reject(new Error("timeout"));
		});
		client.on("data", (chunk) => {
			buffer += chunk.toString();
		});
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

async function main() {
	const env = process.env;
	if (!inHerdr(env)) process.exit(0);

	let hookInput = {};
	try {
		const raw = fs.readFileSync(0, "utf8");
		if (raw.trim()) hookInput = JSON.parse(raw);
	} catch {
		process.exit(0);
	}

	await runHook(hookInput, env, (method, params) =>
		socketRequest(env.HERDR_SOCKET_PATH, method, params),
	);
	process.exit(0);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
	void main();
}
