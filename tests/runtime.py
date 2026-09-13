"""Offscreen QML integration test with actual subprocesses and a private fake Herdr.

Run with /usr/bin/python3 tests/runtime.py (requires PySide6 and Plasma QML).
No live agent is focused or stopped by this test.
"""

import json
import os
import pathlib
import tempfile

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import (
    QObject,
    QPoint,
    QPointF,
    Qt,
    QUrl,
    QMetaObject,
    Slot,
    qInstallMessageHandler,
)
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlComponent, QQmlEngine
from PySide6.QtQuick import QQuickWindow
from PySide6.QtTest import QTest


class Translations(QObject):
    @Slot(str, result=str)
    @Slot(str, int, int, result=str)
    def i18n(self, message, *args):
        for i, arg in enumerate(args, 1):
            message = message.replace(f"%{i}", str(arg))
        return message

    @Slot(str, str, int, result=str)
    def i18np(self, singular, plural, count):
        return (singular if count == 1 else plural).replace("%1", str(count))


app = QGuiApplication([])
engine = QQmlEngine()
translations = Translations()
engine.rootContext().setContextObject(translations)
warnings = []
messages = []
qInstallMessageHandler(lambda kind, context, message: messages.append(message))
engine.warnings.connect(lambda values: warnings.extend(v.toString() for v in values))
root = pathlib.Path(__file__).resolve().parents[1]


def wait_for(predicate, label, timeout=12000):
    for _ in range(timeout // 25):
        if predicate():
            return
        QTest.qWait(25)
    raise AssertionError(label + ": " + str(observer.property("message")))


with tempfile.TemporaryDirectory(prefix="catherder-test-") as directory:
    directory = pathlib.Path(directory)
    state = directory / "state.json"
    calls = directory / "calls"
    fake = directory / "herdr with ' quote"
    fake.write_text(
        "#!/usr/bin/python3\n"
        + f"""
import json, pathlib, sys, time
d = pathlib.Path({str(directory)!r})
s = json.loads((d / 'state.json').read_text())
with (d / 'calls').open('a') as f: f.write(' '.join(sys.argv[1:]) + '\\n')
if sys.argv[1:3] == ['agent','focus']:
    if s.get('focus_ok'):
        print(json.dumps({{'result': {{'agent': {{'tab_id': "w:t'1"}}}}}}))
        sys.exit(0)
    print('test focus failure', file=sys.stderr)
    sys.exit(1)
if sys.argv[1:3] == ['tab','focus']:
    assert sys.argv[3:] == ["w:t'1"]
    print('{{"result":{{"tab":{{}}}}}}')
    sys.exit(0)
if sys.argv[1:3] == ['api','snapshot']:
    if s.get('delay'): time.sleep(s['delay'])
    if s.get('bad'): print('bad json'); sys.exit(0)
    print(json.dumps({{'panes': s['panes'], 'workspaces': s.get('workspaces',[])}}))
elif sys.argv[1:3] == ['workspace','list']:
    if s.get('workspace_bad'):
        print('workspace metadata unavailable', file=sys.stderr)
        sys.exit(1)
    print(json.dumps({{"workspaces": s.get('workspaces', [])}}))
elif sys.argv[1:3] == ['worktree','list']:
    print('{{"error":{{"code":"not_git_worktree","message":"Herdr worktree actions require a workspace inside a Git work tree"}}}}', file=sys.stderr)
    sys.exit(1)
else: sys.exit(1)
"""
    )
    fake.chmod(0o700)
    panes = [
        {
            "pane_id": "w:p1",
            "workspace_id": "w",
            "agent": "opencode",
            "agent_status": "blocked",
            "cwd": str(directory),
            "terminal_title": "A <plain> title",
        }
    ]
    state.write_text(
        json.dumps(
            {
                "panes": panes,
                "workspaces": [{"workspace_id": "w", "label": "Initial workspace"}],
            }
        )
    )
    component = QQmlComponent(
        engine, QUrl.fromLocalFile(str(root / "package/contents/ui/Observer.qml"))
    )
    observer = component.createWithInitialProperties(
        {"command": str(fake), "refreshMs": 500}
    )
    assert observer, "\n".join(e.toString() for e in component.errors())
    wait_for(lambda: observer.property("phase") == "live", "first live snapshot")
    assert observer.property("count") == 1 and observer.property("blocked") == 1
    wait_for(
        lambda: len(observer.property("metadata").toVariant()) == 1,
        "workspace metadata",
    )
    board_component = QQmlComponent(
        engine, QUrl.fromLocalFile(str(root / "package/contents/ui/Board.qml"))
    )
    board = board_component.createWithInitialProperties(
        {"observer": observer, "width": 460, "height": 600}
    )
    assert board, "\n".join(e.toString() for e in board_component.errors())
    window = QQuickWindow()
    window.resize(460, 600)
    board.setParentItem(window.contentItem())
    window.show()
    QTest.qWait(200)
    assert observer.property("phase") == "live", (
        "non-Git active workspace hid the board: " + observer.property("message")
    )
    assert "worktree list" not in calls.read_text()

    state.write_text(json.dumps({"panes": panes, "workspace_bad": True}))
    assert QMetaObject.invokeMethod(observer, "pollMetadata")
    QTest.qWait(250)
    assert observer.property("phase") == "live" and observer.property("count") == 1
    assert len(observer.property("metadata").toVariant()) == 1

    def items(item):
        yield item
        for child in item.childItems():
            yield from items(child)

    def named(name):
        return next((item for item in items(board) if item.objectName() == name), None)

    agent = named("A:w:p1")
    assert agent and agent.height() > 0, "agent delegate was not rendered"
    point = agent.mapToScene(QPointF(agent.width() / 2, agent.height() / 2))
    QTest.mouseClick(
        window, Qt.LeftButton, Qt.NoModifier, QPoint(int(point.x()), int(point.y()))
    )
    QTest.qWait(1100)
    assert calls.read_text().count("agent focus w:p1") == 1
    assert observer.property("phase") == "live", "focus failure disturbed the display"
    focus_warnings = [m for m in messages if "Cat Herdr focus failed:" in m]
    assert len(focus_warnings) == 1 and "test focus failure" in focus_warnings[0]
    assert "tab focus" not in calls.read_text(), (
        "failed agent focus navigated the client"
    )
    state.write_text(json.dumps({"panes": panes, "focus_ok": True}))
    QTest.mouseClick(
        window, Qt.LeftButton, Qt.NoModifier, QPoint(int(point.x()), int(point.y()))
    )
    wait_for(
        lambda: "tab focus w:t'1" in calls.read_text(), "attached-client navigation"
    )
    QTest.qWait(1100)
    assert calls.read_text().count("agent focus w:p1") == 2
    assert calls.read_text().count("tab focus w:t'1") == 1
    assert len([m for m in messages if "Cat Herdr focus" in m]) == 1
    assert observer.property("phase") == "live"
    state.write_text(json.dumps({"panes": [], "bad": True}))
    wait_for(lambda: observer.property("phase") == "error", "malformed output error")
    state.write_text(json.dumps({"panes": []}))
    wait_for(lambda: observer.property("phase") == "empty", "automatic recovery")
    observer.setProperty("command", "/no/such/herdr")
    wait_for(lambda: observer.property("phase") == "error", "bad executable error")
    state.write_text(json.dumps({"panes": panes, "delay": 2}))
    observer.setProperty("command", str(fake))
    QTest.qWait(150)
    observer.setProperty("command", "/no/such/herdr")
    QTest.qWait(2500)
    assert observer.property("phase") == "error" and observer.property("count") == 0, (
        "stale epoch leaked"
    )
    state.write_text(json.dumps({"panes": panes, "delay": 20}))
    observer.setProperty("command", str(fake))
    wait_for(lambda: observer.property("phase") == "error", "timeout error")
    assert "timed out" in observer.property("message")
    state.write_text(json.dumps({"panes": panes}))
    observer.setProperty("refreshMs", 600)
    wait_for(lambda: observer.property("phase") == "live", "interval change recovery")
    linked = {
        "workspace_id": "child",
        "label": "Linked",
        "worktree": {
            "is_linked_worktree": True,
            "repo_key": "/repo",
            "repo_name": "Repository",
        },
    }
    parent = {
        "workspace_id": "w",
        "label": "Parent",
        "worktree": {"is_linked_worktree": False, "repo_key": "/repo"},
    }
    child = dict(panes[0], pane_id="child:p1", workspace_id="child")
    state.write_text(
        json.dumps({"panes": [child] + panes, "workspaces": [linked, parent]})
    )
    wait_for(
        lambda: observer.property("count") == 2 and named("A:child:p1") is not None,
        "linked rows rendered",
    )
    QTest.qWait(100)
    header, agent = named("H:child"), named("A:child:p1")
    header_accent = next(i for i in header.childItems() if i.objectName() == "accent")
    agent_accent = next(i for i in agent.childItems() if i.objectName() == "accent")
    hpos, apos = (
        header_accent.mapToScene(QPointF(0, 0)),
        agent_accent.mapToScene(QPointF(0, 0)),
    )
    assert hpos.x() == apos.x(), "header and agent accent x coordinates differ"
    assert abs(hpos.y() + header_accent.height() - apos.y()) < 0.01, (
        "accent is not continuous"
    )
    subagent_pane = dict(
        panes[0],
        pane_id="w:p_sub",
        workspace_id="w",
        tokens={"subagent": "true", "model": "gemini-3.8-flash"},
        terminal_title="OC | Hold designer (@designer subagent)",
    )
    state.write_text(json.dumps({"panes": [panes[0], subagent_pane], "focus_ok": True}))
    wait_for(
        lambda: observer.property("count") == 2 and named("A:w:p_sub") is not None,
        "subagent row rendered",
    )
    QTest.qWait(100)
    p_primary = named("A:w:p1")
    p_sub = named("A:w:p_sub")
    assert p_primary and p_sub, "panes not found"
    sub_connector = next(
        (i for i in p_sub.childItems() if i.objectName() == "connector"), None
    )
    assert sub_connector and sub_connector.isVisible(), (
        "subagent connector was not rendered or visible"
    )
    assert p_sub.property("contentX") > p_primary.property("contentX"), (
        "subagent was not indented"
    )
    list_view = named("agentList")
    assert list_view.property("count") == 3, (
        "two agents must render as one header plus two agents"
    )
    point_sub = p_sub.mapToScene(QPointF(p_sub.width() / 2, p_sub.height() / 2))
    QTest.mouseClick(
        window,
        Qt.LeftButton,
        Qt.NoModifier,
        QPoint(int(point_sub.x()), int(point_sub.y())),
    )
    QTest.qWait(1100)
    assert "agent focus w:p_sub" in calls.read_text(), (
        "subagent click failed to request focus"
    )
    state.write_text(json.dumps({"panes": [panes[0]], "focus_ok": True}))
    wait_for(
        lambda: observer.property("count") == 1 and named("A:w:p_sub") is None,
        "return to one agent",
    )
    assert list_view.property("count") == 2, (
        "one agent must render as one header plus one agent"
    )
    assert named("H:w") and named("A:w:p1"), (
        "one-agent header and delegate cardinality is wrong"
    )
    many = [dict(panes[0], pane_id=f"w:p{i}") for i in range(40)]
    state.write_text(json.dumps({"panes": many}))
    wait_for(lambda: observer.property("count") == 40, "large model")
    QTest.qWait(100)
    view = named("agentList")
    view.setProperty("contentY", 300.0)
    QTest.qWait(100)
    old_y = view.property("contentY")
    many[0]["terminal_title"] = "Updated title"
    many.pop()
    state.write_text(json.dumps({"panes": many}))
    wait_for(lambda: observer.property("count") == 39, "row removal")
    QTest.qWait(100)
    assert view.property("contentY") == old_y, "refresh changed scroll position"
    assert not warnings, "\n".join(warnings)
    window.close()
    board.deleteLater()
    observer.deleteLater()
    QTest.qWait(100)
print(
    "PASS: QML rendering, accent alignment, scroll stability, click once, errors, recovery, timeout, and stale epochs"
)
