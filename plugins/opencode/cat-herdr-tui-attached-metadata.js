// Reports the current model name to Herdr so the plasmoid can display it.
// Subagent detection and session tracking are handled natively by Herdr's
// own integration (herdr-agent-state.js).

import net from "node:net";

const MODEL_SOURCE = "user:opencode-model";
const AGENT = "opencode";
// Model changes are event-driven.  This only exists to notice navigation to a
// different session when the TUI does not expose a route event.
const ROUTE_POLL_INTERVAL_MS = 2_000;
const MODEL_RETRY_DELAYS_MS = [100, 400, 1_000, 2_000];
const VERSION_TOKEN = "opencode_version";

let requestSequence = Date.now() * 1_000;
let requestChain = Promise.resolve();

function nextRequestID() {
  requestSequence += 1;
  return `${MODEL_SOURCE}:tui:${requestSequence}`;
}

function request(method, params) {
  const pending = requestChain.then(() => requestOnce(method, params));
  requestChain = pending.catch(() => {});
  return pending.catch(() => false);
}

export function requestOnce(method, params, env = process.env) {
  const paneId = env.HERDR_PANE_ID;
  const socketPath = env.HERDR_SOCKET_PATH;
  if (!paneId || !socketPath) {
    return Promise.resolve();
  }

  const socketEndpoint =
    process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
  const payload = {
    id: nextRequestID(),
    method,
    params: {
      pane_id: paneId,
      source: MODEL_SOURCE,
      agent: AGENT,
      ...params,
    },
  };

  return new Promise((resolve) => {
    let client;
    let finished = false;
    let buffer = "";
    const finish = (accepted) => {
      if (finished) {
        return;
      }
      finished = true;
      client?.destroy();
      resolve(accepted);
    };

    const acceptResponse = (raw) => {
      try {
        const response = JSON.parse(raw);
        const accepted =
          response &&
          typeof response === "object" &&
          !Array.isArray(response) &&
          Object.prototype.hasOwnProperty.call(response, "result") &&
          !response.error;
        finish(accepted);
      } catch {
        // The response may be split across multiple data events.  A malformed
        // complete response is rejected when the connection closes.
      }
    };

    try {
      client = net.createConnection(socketEndpoint, () => {
        client.write(`${JSON.stringify(payload)}\n`);
      });
      client.setTimeout(500, () => finish(false));
      client.on("data", (chunk) => {
        buffer += chunk.toString();
        const newline = buffer.indexOf("\n");
        if (newline >= 0) {
          const response = buffer.slice(0, newline).trim();
          if (response) acceptResponse(response);
        }
      });
      client.on("error", () => finish(false));
      client.on("end", () => {
        if (buffer.trim()) acceptResponse(buffer.trim());
        else finish(false);
      });
      client.on("close", () => finish(false));
    } catch {
      finish(false);
    }
  });
}

function nonEmptyString(value) {
  return typeof value === "string" && value ? value : undefined;
}

// The SDK has returned both a bare array and response-shaped collections over
// its lifetime.  Keep this normalization at the integration boundary so model
// extraction does not depend on one particular SDK envelope.
export function normalizeMessages(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (!value || typeof value !== "object") {
    return [];
  }

  for (const key of ["messages", "data", "result", "items", "value"]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const messages = normalizeMessages(value[key]);
      if (messages.length || Array.isArray(value[key])) {
        return messages;
      }
    }
  }
  return [];
}

function nestedObjects(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return [];
  }
  seen.add(value);
  const result = [value];
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      result.push(...nestedObjects(child, seen));
    }
  }
  return result;
}

function modelIdentity(value) {
  if (!value || typeof value !== "object") return undefined;
  const providerID = nonEmptyString(value.providerID);
  const modelID = nonEmptyString(value.modelID);
  return providerID && modelID ? `${providerID}/${modelID}` : undefined;
}

function modelForRole(message, role) {
  for (const candidate of nestedObjects(message)) {
    if (candidate.role !== role) continue;
    const direct = modelIdentity(candidate);
    if (direct) return direct;
    const nested = modelIdentity(candidate.model);
    if (nested) return nested;
  }
  return undefined;
}

export function findModel(messages) {
  const collection = normalizeMessages(messages);

  // Prefer the assistant that actually produced the latest response.  In the
  // current API its identity is commonly at message.info.model, not on the
  // outer message object.
  for (let index = collection.length - 1; index >= 0; index -= 1) {
    const model = modelForRole(collection[index], "assistant");
    if (model) return model;
  }

  // User messages can carry the selected model before the first assistant
  // response, so retain that useful fallback.
  for (let index = collection.length - 1; index >= 0; index -= 1) {
    const model = modelForRole(collection[index], "user");
    if (model) return model;
  }

  return undefined;
}

export function sessionIDFromRoute(route) {
  if (route?.name !== "session") return undefined;
  return nonEmptyString(route.params?.sessionID) || nonEmptyString(route.params?.sessionId);
}

export function reportTokens(model, appVersion) {
  const tokens = { model };
  if (nonEmptyString(appVersion)) tokens[VERSION_TOKEN] = appVersion;
  return tokens;
}

export function cacheReportedMetadata(state, accepted, model, appVersion) {
  if (accepted) {
    state.model = model;
    state.version = appVersion;
  }
  return state;
}

function eventSessionID(event) {
  return (
    nonEmptyString(event?.sessionID) ||
    nonEmptyString(event?.sessionId) ||
    nonEmptyString(event?.properties?.sessionID) ||
    nonEmptyString(event?.properties?.sessionId) ||
    nonEmptyString(event?.properties?.info?.sessionID)
  );
}

export default {
  id: "herdr.opencode.model-reporter",
  tui: async (api) => {
    if (
      process.env.HERDR_ENV !== "1" ||
      !process.env.HERDR_SOCKET_PATH ||
      !process.env.HERDR_PANE_ID
    ) {
      return;
    }

    let selectedSessionID;
    const reported = { model: undefined, version: undefined };
    let modelRetryIndex = 0;
    let nextModelAttemptAt = 0;
    let syncPending = false;
    let disposed = false;
    let scheduledSync;

    const syncModel = async () => {
      if (disposed || syncPending) {
        return;
      }
      syncPending = true;

      try {
        const route = api.route.current;
        const sessionID = sessionIDFromRoute(route);

        if (!sessionID) {
          selectedSessionID = undefined;
          reported.model = undefined;
          reported.version = undefined;
          modelRetryIndex = 0;
          nextModelAttemptAt = 0;
          return;
        }

        if (sessionID !== selectedSessionID) {
          selectedSessionID = sessionID;
          reported.model = undefined;
          reported.version = undefined;
          modelRetryIndex = 0;
          nextModelAttemptAt = 0;
        }

        if (Date.now() < nextModelAttemptAt) {
          return;
        }

        let model;
        try {
          model = findModel(await api.state.session.messages(sessionID));
        } catch {
          model = undefined;
        }

        if (!model) {
          const retryDelay =
            MODEL_RETRY_DELAYS_MS[
              Math.min(modelRetryIndex, MODEL_RETRY_DELAYS_MS.length - 1)
            ];
          modelRetryIndex += 1;
          nextModelAttemptAt = Date.now() + retryDelay;
          return;
        }

        modelRetryIndex = 0;
        nextModelAttemptAt = 0;
        const appVersion = nonEmptyString(api.app?.version);
        if (model === reported.model && appVersion === reported.version) {
          return;
        }

        const accepted = await request("pane.report_metadata", {
          tokens: reportTokens(model, appVersion),
        });
        // A timeout, socket error, closed connection, malformed response, or
        // JSON-RPC error must leave this eligible for a future retry.
        cacheReportedMetadata(reported, accepted, model, appVersion);
      } finally {
        syncPending = false;
      }
    };

    const scheduleSync = () => {
      if (disposed || scheduledSync !== undefined) return;
      scheduledSync = setTimeout(() => {
        scheduledSync = undefined;
        void syncModel();
      }, 0);
    };

    // These are the server events emitted when a session/message changes in
    // the current OpenCode API.  A bad/older runtime simply falls back to the
    // conservative route poll below.
    const unsubscribers = [];
    const eventAPI = api.event;
    if (eventAPI && typeof eventAPI.on === "function") {
      for (const eventName of [
        "message.updated",
        "message.part.updated",
        "session.updated",
        "session.status",
        "session.idle",
      ]) {
        try {
          const unsubscribe = eventAPI.on(eventName, (event) => {
            const current = sessionIDFromRoute(api.route.current);
            const changed = eventSessionID(event);
            if (!changed || changed === current) scheduleSync();
          });
          if (typeof unsubscribe === "function") unsubscribers.push(unsubscribe);
        } catch {
          // Unsupported event names are expected on older OpenCode releases.
        }
      }
    }

    await syncModel();
    // Route changes are not consistently exposed as an event by the TUI, so
    // keep this as a low-frequency fallback rather than polling messages.
    const routePoll = setInterval(() => void syncModel(), ROUTE_POLL_INTERVAL_MS);
    api.lifecycle.onDispose(() => {
      disposed = true;
      clearInterval(routePoll);
      if (scheduledSync !== undefined) clearTimeout(scheduledSync);
      for (const unsubscribe of unsubscribers) {
        try {
          unsubscribe();
        } catch {
          // Disposal must not turn a socket/TUI shutdown into an unhandled error.
        }
      }
    });
  },
};
