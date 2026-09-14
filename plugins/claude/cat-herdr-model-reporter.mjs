#!/usr/bin/env node
// Reports the active Claude model to Herdr so the plasmoid can display it.
//
// One-shot Claude Code hook: SessionStart, Stop.
//
// SessionStart carries the resolved model on the hook payload and is the only
// event that does. Stop does not, so the model is read from the session
// transcript — see modelForThisTurn for the flush race that complicates it.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const AGENT = "claude";
export const SOURCE = "user:claude-model";

const SOCKET_TIMEOUT_MS = 2000;
const TAIL_BYTES = 256 * 1024;
// Backoff while waiting for this turn's transcript entry to be flushed.
export const FLUSH_WAIT_MS = [0, 50, 100, 200, 300, 500, 800];
// Compared prefix length when last_assistant_message may be truncated.
export const PREFIX_MATCH_CHARS = 40;

export function inHerdr(env) {
	return env.HERDR_ENV === "1" && Boolean(env.HERDR_SOCKET_PATH);
}

// Claude Code sets agent_id on a subagent's own hook invocation. Subagents may
// run a different model and must not clobber the pane.
export function isSubagent(hook) {
	if (!hook || typeof hook !== "object") return false;
	return Boolean(hook.agent_id);
}

function nonEmptyString(value) {
	return typeof value === "string" && value ? value : undefined;
}

// Only SessionStart carries the model; UserPromptSubmit and PreToolUse do not.
export function pickModel(hook) {
	return nonEmptyString(hook?.model);
}

export function pickSessionId(hook) {
	return nonEmptyString(hook?.session_id);
}

export function isStartupHook(hook) {
	return typeof hook?.hook_event_name === "string" && hook.hook_event_name.toLowerCase() === "sessionstart";
}

export function normalize(value) {
	return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

// Concatenates an assistant message's text blocks, ignoring thinking blocks.
export function extractText(message) {
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.filter((b) => b?.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("");
}

// Parses raw JSONL lines into main-thread assistant entries, newest first.
// Malformed lines are skipped: the tail window can start mid-line, and the
// final line can be a partial write.
export function parseAssistantEntries(lines) {
	const entries = [];
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const line = typeof lines[i] === "string" ? lines[i].trim() : "";
		if (!line) continue;

		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		if (entry?.isSidechain === true) continue;
		const message = entry?.message;
		if (message?.role !== "assistant") continue;
		const model = nonEmptyString(message.model);
		if (!model) continue;

		entries.push({ model, text: extractText(message) });
	}
	return entries;
}

// True when a transcript entry is the response described by
// last_assistant_message. Falls back to a prefix compare because
// last_assistant_message may be truncated for long responses.
export function isSameResponse(entryText, lastMessage) {
	const a = normalize(entryText);
	const b = normalize(lastMessage);
	if (!a || !b) return false;
	if (a === b) return true;
	if (b.length >= PREFIX_MATCH_CHARS) {
		return a.slice(0, PREFIX_MATCH_CHARS) === b.slice(0, PREFIX_MATCH_CHARS);
	}
	return false;
}

// Transcript entries carry a timestamp set when the message is created, but
// the JSONL line is flushed asynchronously. At Stop this turn's entry is
// usually not readable yet, so taking the newest entry returns the PREVIOUS
// turn's model and the display lags a turn after a /model switch.
//
// last_assistant_message identifies this turn's response, so wait on a short
// backoff for that entry to land. Falling back to the newest entry keeps the
// display one turn stale rather than empty.
export async function modelForThisTurn(readEntries, lastMessage, sleep) {
	const wanted = normalize(lastMessage);
	let newest;

	for (const delay of FLUSH_WAIT_MS) {
		if (delay) await sleep(delay);

		let entries;
		try {
			entries = await readEntries();
		} catch {
			entries = undefined;
		}
		if (!Array.isArray(entries) || !entries.length) continue;

		newest = entries[0].model;
		// Nothing to match against, e.g. a turn that emitted no text.
		if (!wanted) return newest;

		const match = entries.find((e) => isSameResponse(e.text, lastMessage));
		if (match) return match.model;
	}

	return newest;
}

// Prefers the pane whose recorded session matches this hook's session, because
// HERDR_PANE_ID can be wrong when an instance inherits the parent shell's
// environment. The env var is only trusted when that pane is not already
// claimed by a different Claude session, which is the clobber case.
export function resolvePaneId(panes, sessionId, envPaneId) {
	const list = Array.isArray(panes) ? panes : [];

	if (sessionId) {
		const match = list.find(
			(p) =>
				p?.agent === AGENT &&
				p?.agent_session?.value === sessionId &&
				nonEmptyString(p?.pane_id),
		);
		if (match) return match.pane_id;
	}

	const fallback = nonEmptyString(envPaneId);
	if (!fallback) return undefined;

	const envPane = list.find((p) => p?.pane_id === fallback);
	const owner = nonEmptyString(envPane?.agent_session?.value);
	if (owner && sessionId && owner !== sessionId) return undefined;

	return fallback;
}

export async function runHook(hook, env, requestFn, deps = {}) {
	if (!inHerdr(env)) return;
	if (isSubagent(hook)) return;

	const sessionId = pickSessionId(hook);
	if (!sessionId) return;
	const startup = isStartupHook(hook);

	const sleep =
		deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

	let model = pickModel(hook);
	let paneId;
	if (startup && !model) {
		let panes;
		try {
			const response = await requestFn("pane.list", {});
			panes = response?.result?.panes;
		} catch {
			panes = undefined;
		}
		paneId = resolvePaneId(panes, sessionId, env.HERDR_PANE_ID);
		if (paneId) {
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
		}
	}
	if (!model) {
		const readEntries =
			deps.readEntries ||
			(nonEmptyString(hook?.transcript_path)
				? () => readTranscriptEntries(hook.transcript_path)
				: undefined);
		if (readEntries) {
			model = await modelForThisTurn(
				readEntries,
				hook?.last_assistant_message,
				sleep,
			);
		}
	}
	if (!model) return;

	if (!paneId) {
		let panes;
		try {
			const response = await requestFn("pane.list", {});
			panes = response?.result?.panes;
		} catch {
			panes = undefined;
		}
		paneId = resolvePaneId(panes, sessionId, env.HERDR_PANE_ID);
	}
	if (!paneId) return;

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

// Reads the tail of the transcript rather than the whole file, which grows
// without bound over a long session.
function readTranscriptEntries(transcriptPath) {
	let handle;
	try {
		handle = fs.openSync(transcriptPath, "r");
		const size = fs.fstatSync(handle).size;
		const length = Math.min(size, TAIL_BYTES);
		const buffer = Buffer.alloc(length);
		fs.readSync(handle, buffer, 0, length, size - length);
		return parseAssistantEntries(buffer.toString("utf8").split("\n"));
	} catch {
		return [];
	} finally {
		if (handle !== undefined) {
			try {
				fs.closeSync(handle);
			} catch {}
		}
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
