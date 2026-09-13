import QtQuick
import org.kde.plasma.plasma5support as Plasma5Support
import "Model.js" as Model

Item {
    id: observer
    property string command
    property int refreshMs: 3000
    property bool multiplexAware: true
    property string phase: "starting"
    property string message: i18n("Contacting herdr…")
    property int count: 0
    property int blocked: 0
    property int working: 0
    readonly property string summary: i18np("%1 agent running", "%1 agents running", count)
        + i18n(" · %1 working · %2 need you", working, blocked)
    property ListModel rows: ListModel {}
    property var snapshot: null
    property var metadata: []
    property var git: ({})
    property var errors: ({})
    property var pending: ({})
    property var gitPaths: ({})
    property var gitQueue: []
    property var gitBackoff: ({})
    property string active: ""
    property int generation: 0
    property int sequence: 0
    property bool ready: false
    readonly property string instance: String(Date.now()) + "-" + Math.random()

    Plasma5Support.DataSource {
        id: process
        engine: "executable"
        interval: 0
        onNewData: (source, data) => observer.finished(source, data)
    }
    Timer { id: fast; interval: Math.max(500, observer.refreshMs); repeat: true; onTriggered: observer.pollSnapshot() }
    Timer { id: slow; interval: 15000; repeat: true; onTriggered: observer.pollMetadata() }
    Timer { id: hourly; interval: 3600000; repeat: true; onTriggered: observer.scheduleGit(true) }
    onCommandChanged: if (ready) restart()
    onRefreshMsChanged: if (ready) restart()
    onMultiplexAwareChanged: if (ready) restart()
    Component.onCompleted: { ready = true; restart() }
    Component.onDestruction: {
        Object.keys(pending).forEach(function (source) { process.disconnectSource(source) })
    }

    function restart() {
        generation++
        Object.keys(pending).forEach(function (source) { process.disconnectSource(source) })
        pending = {}; errors = {}; snapshot = null; metadata = []; git = {}
        gitPaths = {}; gitQueue = []; gitBackoff = {}; active = ""
        Model.reconcile(rows, [])
        count = 0; blocked = 0; working = 0
        phase = "starting"; message = i18n("Contacting herdr…")
        fast.restart(); slow.restart(); hourly.restart()
        pollSnapshot(); pollMetadata()
    }
    function busy(key) {
        return Object.keys(pending).some(function (s) { return pending[s].key === key })
    }
    function launch(key, args, extra) {
        if (busy(key)) return
        // Every invocation gets a unique source, including across configuration epochs.
        // timeout bounds children too; quoting treats configured commands strictly as paths.
        var source = "LC_ALL=C GIT_OPTIONAL_LOCKS=0 /usr/bin/timeout -k 1s 8s " + args
            + " # catherder-" + instance + "-" + generation + "-" + (++sequence)
        pending[source] = { key: key, generation: generation, extra: extra }
        process.connectSource(source)
    }
    function pollSnapshot() { launch("snapshot", Model.quote(command) + " api snapshot", null) }
    function pollMetadata() {
        launch("workspaces", Model.quote(command) + " workspace list", null)
    }
    function scheduleGit(force) {
        if (!snapshot) return
        var paths = Model.paths(snapshot, metadata)
        var nextActive = Model.activeKey(snapshot)
        force = force || nextActive !== active
        active = nextActive
        Object.keys(git).forEach(function (id) {
            if (!paths[id]) { delete git[id]; delete errors["git:" + id] }
        })
        Object.keys(errors).forEach(function (key) {
            if (key.indexOf("git:") === 0 && !paths[key.slice(4)]) delete errors[key]
        })
        Object.keys(paths).forEach(function (id) {
            var backoff = gitBackoff[id] || 0
            if (backoff > 0) { gitBackoff[id] = backoff - 1; return }
            if (force || gitPaths[id] !== paths[id] || errors["git:" + id]) {
                gitQueue = gitQueue.filter(function (job) { return job.id !== id })
                gitQueue.push({ id: id, path: paths[id] })
                if (gitPaths[id] !== paths[id]) delete git[id]
            }
        })
        gitPaths = paths
        pumpGit()
    }
    function pumpGit() {
        var running = Object.keys(pending).filter(function (s) { return pending[s].key.indexOf("git:") === 0 }).length
        for (var i = 0; i < gitQueue.length && running < 4;) {
            var job = gitQueue[i]
            if (busy("git:" + job.id)) { i++; continue }
            gitQueue.splice(i, 1)
            if (gitPaths[job.id] !== job.path) continue
            launch("git:" + job.id, "/usr/bin/git -C " + Model.quote(job.path) + " status -sb", job)
            running++
        }
    }
    function finished(source, data) {
        var job = pending[source]
        if (!job) return
        delete pending[source]
        process.disconnectSource(source)
        if (job.generation !== generation) return
        if (job.key.indexOf("focus:") === 0) {
            if (Number(data["exit code"]) !== 0)
                console.warn("Cat Herdr focus failed:", String(data.stderr || data.stdout || "Command failed").trim().slice(0, 500), "exit code:", data["exit code"])
            else {
                try {
                    var agent = Model.body(String(data.stdout || "")).agent
                    // Herdr 0.9.0 agent focus omits attached-client navigation; tab focus propagates it.
                    if (agent && Model.text(agent.tab_id))
                        launch("focus:" + (++sequence), Model.quote(command) + " tab focus " + Model.quote(agent.tab_id), null)
                } catch (e) { console.warn("Cat Herdr focus response:", e.message) }
            }
            return
        }
        var isGit = job.key.indexOf("git:") === 0
        if (isGit && gitPaths[job.extra.id] !== job.extra.path) { pumpGit(); return }
        var output = String(data.stdout || ""), error = String(data.stderr || "").trim()
        var code = Number(data["exit code"])
        try {
            delete errors[job.key]
            if (isGit && code !== 0 && /not a git repository/.test(error)) {
                delete git[job.extra.id]
            } else {
                if (code !== 0) throw new Error(code === 124 || code === 137 ? "Command timed out" : error.split("\n")[0].slice(0, 180) || "Command failed (" + code + ")")
                if (job.key === "snapshot") snapshot = Model.snapshot(output)
                else if (job.key === "workspaces") metadata = Model.records(output, "workspaces")
                else if (isGit) {
                    git[job.extra.id] = Model.gitStatus(output)
                    delete gitBackoff[job.extra.id]
                }
            }
        } catch (e) {
            if (job.key === "workspaces") {
                // Workspace metadata is optional enrichment. Keep the last valid
                // value and the snapshot-driven board when this request fails.
                delete errors[job.key]
            } else {
                errors[job.key] = job.key + ": " + e.message
            }
            if (isGit) {
                delete git[job.extra.id]
                gitBackoff[job.extra.id] = 3  // skip next 3 snapshot cycles
            }
        }
        if (!isGit && snapshot) scheduleGit(false)
        pumpGit()
        publish()
    }
    function publish() {
        if (snapshot) {
            var result = Model.build(snapshot, metadata, git, observer.multiplexAware)
            Model.reconcile(rows, result.rows)
            count = result.count; blocked = result.blocked; working = result.working
        }
        var fatal = Object.keys(errors).filter(function (k) { return k.indexOf("git:") !== 0 })
        if (fatal.length) { phase = "error"; message = errors[fatal.sort()[0]] }
        else if (!snapshot) { phase = "starting"; message = i18n("Contacting herdr…") }
        else if (!count) { phase = "empty"; message = i18n("Herdr is up, but no agents are running.") }
        else { phase = "live"; message = "" }
    }
    function focusPane(pane) {
        if (phase !== "live" || !pane) return
        launch("focus:" + (++sequence), Model.quote(command) + " agent focus " + Model.quote(pane), null)
    }
}
