// Pure data transformations. All identities are Herdr IDs, never display labels.
function text(value) {
    return typeof value === "string" ? value : "";
}

function body(output) {
    var parsed = JSON.parse(output);
    if (!parsed || typeof parsed !== "object" || parsed.error)
        throw new Error("Herdr returned an API error");
    return parsed.result || parsed;
}

function records(output, field) {
    var value = body(output)[field];
    if (!Array.isArray(value) || value.some(function (v) { return !v || typeof v !== "object"; }))
        throw new Error("Unexpected Herdr " + field + " response");
    if (field === "workspaces" && value.some(function (v) { return !text(v.workspace_id); }))
        throw new Error("Invalid workspace identity");
    return value;
}

function snapshot(output) {
    var value = body(output);
    value = value.snapshot || value;
    if (!Array.isArray(value.panes) || (value.workspaces !== undefined && !Array.isArray(value.workspaces)))
        throw new Error("Unexpected Herdr snapshot response");
    var seen = Object.create(null);
    value.panes.forEach(function (pane) {
        if (!pane || typeof pane !== "object")
            throw new Error("Invalid pane record");
        if (!pane.agent) return;
        if (!text(pane.pane_id) || !text(pane.workspace_id) || !text(pane.agent) || seen[pane.pane_id])
            throw new Error("Invalid or duplicate agent identity");
        seen[pane.pane_id] = true;
    });
    (value.workspaces || []).forEach(function (w) {
        if (!w || !text(w.workspace_id)) throw new Error("Invalid workspace record");
    });
    return value;
}

function status(value) {
    return ["working", "blocked", "idle", "done"].indexOf(value) >= 0 ? value : "unknown";
}

// Model information is optional snapshot data. Herdr reports it under tokens;
// top-level fields are compatibility fallbacks only. A title, agent name, or
// session identifier is not a model declaration.
function paneModel(pane) {
    var tokens = pane && pane.tokens;
    return text(tokens && typeof tokens === "object" ? tokens.model : "") ||
        text(pane.model) || text(pane.model_name);
}

function paneSubagent(pane) {
    var tokens = pane && pane.tokens;
    var tokenVal = tokens && typeof tokens === "object" ? tokens.subagent : undefined;
    if (tokenVal === "true" || tokenVal === true || tokenVal === "1") return true;
    if (tokenVal === "false" || tokenVal === false || tokenVal === "0") return false;
    if (pane && (pane.subagent === true || pane.is_subagent === true || pane.role === "subagent")) return true;
    if (pane && (text(pane.parent_pane_id) || text(pane.parent_session_id))) return true;
    var session = pane && pane.agent_session;
    if (session && typeof session === "object") {
        if (session.subagent === true || session.is_subagent === true) return true;
        if (text(session.parent_id) || text(session.parent_session_id) || text(session.parent_value)) return true;
    }
    var title = text(pane && (pane.terminal_title_stripped || pane.terminal_title || pane.title || pane.label));
    if (/\(@[a-zA-Z0-9_-]+(?:\s+subagent|\b|\))/i.test(title)) return true;
    return false;
}

function paneParentRef(pane) {
    if (!pane || typeof pane !== "object") return "";
    var tokens = pane.tokens;
    if (tokens && typeof tokens === "object" && text(tokens.parent_id)) return text(tokens.parent_id);
    if (text(pane.parent_pane_id)) return text(pane.parent_pane_id);
    if (text(pane.parent_session_id)) return text(pane.parent_session_id);
    var session = pane.agent_session;
    if (session && typeof session === "object") {
        return text(session.parent_id) || text(session.parent_session_id) || text(session.parent_value);
    }
    return "";
}

function workspaces(snap, metadata) {
    var result = Object.create(null);
    metadata.forEach(function (w) { result[w.workspace_id] = w; });
    // Snapshot metadata is freshest, when provided. Older Herdr versions omit it.
    (snap.workspaces || []).forEach(function (w) {
        result[w.workspace_id] = Object.assign({}, result[w.workspace_id] || {}, w);
    });
    return result;
}

function paths(snap, metadata) {
    var result = Object.create(null);
    var ws = workspaces(snap, metadata);
    Object.keys(ws).forEach(function (id) {
        var w = ws[id];
        var cwd = text((w.worktree || {}).checkout_path) || text(w.cwd);
        if (cwd) result[id] = cwd;
    });
    snap.panes.forEach(function (p) {
        if (!result[p.workspace_id] && text(p.cwd)) result[p.workspace_id] = p.cwd;
    });
    return result;
}

function activeKey(snap) {
    var active = Object.create(null);
    snap.panes.forEach(function (p) {
        var s = status(p.agent_status); if (p.agent && s !== "idle" && s !== "done") active[p.workspace_id] = true;
    });
    return JSON.stringify(Object.keys(active).sort());
}

function gitStatus(output) {
    var line = output.split(/\r?\n/)[0];
    if (line.indexOf("## ") !== 0) throw new Error("Unexpected git status response");
    var summary = line.slice(3);
    var branch = summary.split("...")[0].replace(/ \[.*$/, "");
    branch = branch.replace(/^(No commits yet on |Initial commit on )/, "");
    if (/^HEAD(?: |$)/.test(branch)) branch = "";
    var ahead = summary.match(/\bahead (\d+)/);
    var behind = summary.match(/\bbehind (\d+)/);
    return { branch: branch, ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0 };
}

function build(snap, metadata, git, multiplexAware) {
    var ws = workspaces(snap, metadata);
    var groups = Object.create(null), order = [];
    var count = 0, blocked = 0, working = 0;
    snap.panes.forEach(function (p) {
        if (!p.agent) return;
        var id = p.workspace_id;
        if (!groups[id]) { groups[id] = []; order.push(id); }
        groups[id].push(p);
        count++;
        if (status(p.agent_status) === "blocked") blocked++;
        if (status(p.agent_status) === "working") working++;
    });
    function repo(id) {
        var t = (ws[id] || {}).worktree || {};
        return text(t.repo_key) || text(t.repo_root) || text(t.repo_name);
    }
    function linked(id) { return !!(((ws[id] || {}).worktree || {}).is_linked_worktree); }
    var parents = Object.create(null);
    order.forEach(function (id) {
        if (!linked(id) || !repo(id)) return;
        var parent = order.filter(function (other) { return !linked(other) && repo(other) === repo(id); })[0];
        if (parent) parents[id] = parent;
    });
    var sorted = [];
    order.forEach(function (id) {
        if (parents[id]) return;
        sorted.push(id);
        order.forEach(function (child) { if (parents[child] === id) sorted.push(child); });
    });
    var rows = [];
    sorted.forEach(function (id) {
        var w = ws[id] || {}, g = git[id] || {};
        var common = {
            workspace: text(w.label) || (w.number ? String(w.number) : id),
            nested: !!parents[id], linked: linked(id),
            repo: text((w.worktree || {}).repo_name),
            count: groups[id].length, ahead: g.ahead || 0, behind: g.behind || 0,
            agent: "", agentStatus: "unknown", modelName: "", title: "", project: "", branch: "", paneId: "",
            isSubagent: false, isLastSubagent: false
        };
        rows.push(Object.assign({}, common, { uid: "H:" + id, kind: "header" }));

        var panesInGroup = groups[id];
        var orderedPanes;

        if (multiplexAware !== false) {
            // Full multiplexing-aware mode: detect subagents, nest under parents
            var primaries = [], subagentsByParent = Object.create(null), unattached = [];
            panesInGroup.forEach(function (p) {
                if (paneSubagent(p)) {
                    var parent = null;
                    var ref = paneParentRef(p);
                    if (ref) {
                        parent = panesInGroup.filter(function (other) {
                            return !paneSubagent(other) && (other.pane_id === ref || (other.agent_session && other.agent_session.value === ref));
                        })[0];
                    }
                    if (!parent && p.tab_id) {
                        parent = panesInGroup.filter(function (other) {
                            return !paneSubagent(other) && other.tab_id === p.tab_id;
                        })[0];
                    }
                    if (!parent) {
                        parent = panesInGroup.filter(function (other) {
                            return !paneSubagent(other);
                        })[0];
                    }
                    if (parent) {
                        if (!subagentsByParent[parent.pane_id]) subagentsByParent[parent.pane_id] = [];
                        subagentsByParent[parent.pane_id].push(p);
                    } else {
                        unattached.push(p);
                    }
                } else {
                    primaries.push(p);
                }
            });

            orderedPanes = [];
            primaries.forEach(function (parent) {
                orderedPanes.push(Object.assign({}, parent, { _isSubagent: false, _isLastSubagent: false, _parentPaneId: "" }));
                var subs = subagentsByParent[parent.pane_id] || [];
                subs.forEach(function (sub, idx) {
                    orderedPanes.push(Object.assign({}, sub, {
                        _isSubagent: true,
                        _isLastSubagent: (idx === subs.length - 1),
                        _parentPaneId: parent.pane_id
                    }));
                });
            });
            unattached.forEach(function (sub, idx) {
                orderedPanes.push(Object.assign({}, sub, {
                    _isSubagent: true,
                    _isLastSubagent: (idx === unattached.length - 1),
                    _parentPaneId: ""
                }));
            });
        } else {
            // Flat mode: no subagent detection, all panes are independent
            orderedPanes = panesInGroup.map(function (p) {
                return Object.assign({}, p, { _isSubagent: false, _isLastSubagent: false, _parentPaneId: "" });
            });
        }

        orderedPanes.forEach(function (p) {
            rows.push(Object.assign({}, common, {
                uid: "A:" + p.pane_id, kind: "agent", paneId: p.pane_id,
                agent: text(p.agent_name) || p.agent, agentStatus: status(p.agent_status), modelName: paneModel(p),
                title: text(p.terminal_title_stripped) || text(p.terminal_title),
                project: text(p.cwd).replace(/\/+$/, "").split("/").pop() || "",
                branch: text(g.branch),
                isSubagent: Boolean(p._isSubagent),
                isLastSubagent: Boolean(p._isLastSubagent)
            }));
        });
    });
    return { rows: rows, count: count, blocked: blocked, working: working };
}

// Never reset the model: preserve delegates, click feedback, and scroll position.
function reconcile(model, rows) {
    for (var i = 0; i < rows.length; ++i) {
        var row = rows[i], found = -1;
        for (var j = i; j < model.count; ++j) {
            if (model.get(j).uid === row.uid) { found = j; break; }
        }
        if (found < 0) model.insert(i, row);
        else {
            if (found !== i) model.move(found, i, 1);
            Object.keys(row).forEach(function (key) {
                if (model.get(i)[key] !== row[key]) model.setProperty(i, key, row[key]);
            });
        }
    }
    if (model.count > rows.length) model.remove(rows.length, model.count - rows.length);
}

function quote(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'"; }
