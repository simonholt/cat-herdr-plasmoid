import QtQuick
import QtQuick.Controls as Controls
import QtQuick.Layouts
import org.kde.kirigami as Kirigami

Item {
    id: wrapper
    required property var row
    required property int index
    readonly property var rowData: (row && typeof row === "object" && row.uid !== undefined)
        ? row
        : (ListView.view && ListView.view.model && index >= 0)
            ? ListView.view.model.get(index)
            : ({})
    objectName: (wrapper.rowData && wrapper.rowData.uid) ? wrapper.rowData.uid : ""
    signal focusRequested(string pane)
    readonly property bool isSubagent: Boolean(wrapper.rowData && wrapper.rowData.isSubagent)
    readonly property bool isLastSubagent: Boolean(wrapper.rowData && wrapper.rowData.isLastSubagent)
    readonly property real inset: (wrapper.rowData && wrapper.rowData.nested) ? Kirigami.Units.largeSpacing * 2 : 0
    // One shared coordinate for both kinds of row; no independent margin arithmetic.
    readonly property real lineX: inset + Kirigami.Units.smallSpacing
    readonly property real subagentIndent: wrapper.isSubagent ? (Kirigami.Units.largeSpacing * 1.5) : 0
    readonly property real baseContentX: lineX + Kirigami.Units.largeSpacing
    readonly property real contentX: baseContentX + subagentIndent
    readonly property real branchX: baseContentX + Kirigami.Units.smallSpacing
    readonly property color statusColor: (wrapper.rowData && wrapper.rowData.agentStatus === "working") ? Kirigami.Theme.highlightColor
        : (wrapper.rowData && wrapper.rowData.agentStatus === "blocked") ? Kirigami.Theme.negativeTextColor
        : (wrapper.rowData && wrapper.rowData.agentStatus === "idle") ? Kirigami.Theme.positiveTextColor
        : (wrapper.rowData && wrapper.rowData.agentStatus === "done") ? Kirigami.Theme.neutralTextColor : Kirigami.Theme.textColor
    readonly property string statusLabel: (wrapper.rowData && wrapper.rowData.agentStatus === "blocked") ? i18n("needs you")
        : (wrapper.rowData && wrapper.rowData.agentStatus === "working") ? i18n("working")
        : (wrapper.rowData && wrapper.rowData.agentStatus === "idle") ? i18n("idle")
        : (wrapper.rowData && wrapper.rowData.agentStatus === "done") ? i18n("done") : i18n("unknown")
    implicitHeight: content.item ? content.item.implicitHeight : 0
    Rectangle {
        visible: Boolean(wrapper.rowData && wrapper.rowData.kind === "header")
        x: wrapper.contentX - Kirigami.Units.smallSpacing
        y: 1
        width: Math.max(0, parent.width - x)
        height: Math.max(0, parent.height - 2)
        radius: Kirigami.Units.smallSpacing
        color: Kirigami.Theme.textColor
        opacity: 0.08
    }
    Rectangle {
        objectName: "accent"
        visible: Boolean(wrapper.rowData && wrapper.rowData.nested)
        x: wrapper.lineX
        y: 0
        width: 2
        height: parent.height
        color: Kirigami.Theme.highlightColor
    }
    Item {
        id: connector
        objectName: "connector"
        visible: wrapper.isSubagent
        x: wrapper.branchX
        y: 0
        width: Math.max(0, wrapper.contentX - wrapper.branchX)
        height: parent.height

        Rectangle {
            objectName: "connectorStem"
            x: 0
            y: 0
            width: 1
            height: wrapper.isLastSubagent ? Math.round(branchArm.y + 1) : parent.height
            color: Kirigami.Theme.disabledTextColor
            opacity: 0.45
        }

        Rectangle {
            id: branchArm
            objectName: "connectorArm"
            x: 0
            y: (content.item && content.item.dotCenterY !== undefined)
                ? Math.round(content.item.dotCenterY)
                : Math.round(Kirigami.Units.smallSpacing + (Kirigami.Theme.smallFont.pointSize > 0 ? Kirigami.Theme.smallFont.pointSize : 10) * 0.7)
            width: Math.max(0, connector.width - 2)
            height: 1
            color: Kirigami.Theme.disabledTextColor
            opacity: 0.45
        }
    }
    Loader {
        id: content
        x: wrapper.contentX
        width: Math.max(0, parent.width - x - Kirigami.Units.smallSpacing)
        sourceComponent: (wrapper.rowData && wrapper.rowData.kind === "header") ? header
            : (wrapper.rowData && wrapper.rowData.kind === "agent") ? agent : null
    }
    Component {
        id: header
        ColumnLayout {
            spacing: 0
            RowLayout {
                Layout.fillWidth: true
                Layout.topMargin: Kirigami.Units.smallSpacing + 2
                Layout.bottomMargin: Kirigami.Units.smallSpacing + 2
                spacing: Kirigami.Units.smallSpacing
                Controls.Label {
                    Layout.fillWidth: true
                    text: (wrapper.rowData && wrapper.rowData.linked ? "⤷ " : "") + ((wrapper.rowData && wrapper.rowData.workspace) || "")
                    textFormat: Text.PlainText
                    elide: Text.ElideRight
                    font.bold: true
                }
                Controls.Label { text: (wrapper.rowData && wrapper.rowData.count !== undefined) ? wrapper.rowData.count : ""; color: Kirigami.Theme.disabledTextColor }
                Controls.Label {
                    visible: Boolean(wrapper.rowData && wrapper.rowData.behind > 0)
                    text: "↓" + (wrapper.rowData ? wrapper.rowData.behind : 0)
                    color: Kirigami.Theme.negativeTextColor
                }
                Controls.Label {
                    visible: Boolean(wrapper.rowData && wrapper.rowData.ahead > 0)
                    text: "↑" + (wrapper.rowData ? wrapper.rowData.ahead : 0)
                    color: Kirigami.Theme.positiveTextColor
                }
            }
            Controls.Label {
                Layout.fillWidth: true
                Layout.bottomMargin: visible ? Kirigami.Units.smallSpacing : 0
                visible: Boolean(wrapper.rowData && wrapper.rowData.linked && wrapper.rowData.repo !== "")
                text: (wrapper.rowData && wrapper.rowData.repo) || ""
                textFormat: Text.PlainText
                font: Kirigami.Theme.smallFont
                color: Kirigami.Theme.disabledTextColor
                elide: Text.ElideRight
            }
        }
    }
    Component {
        id: agent
        Item {
            id: agentRoot
            readonly property real dotCenterY: statusDot.y + statusDot.height / 2
            implicitHeight: details.implicitHeight + Kirigami.Units.smallSpacing * 2
            Rectangle {
                anchors.fill: parent
                radius: Kirigami.Units.smallSpacing
                color: Kirigami.Theme.highlightColor
                opacity: flash.running ? 0.25 : mouse.containsMouse ? 0.08 : 0
            }
            Rectangle {
                id: statusDot
                x: 0
                y: Kirigami.Units.smallSpacing + (name.implicitHeight - height) / 2
                width: wrapper.isSubagent ? Math.round(Kirigami.Units.smallSpacing * 1.5) : (Kirigami.Units.smallSpacing * 2)
                height: width
                radius: width / 2
                color: wrapper.statusColor
            }
            ColumnLayout {
                id: details
                x: statusDot.width + Kirigami.Units.largeSpacing
                y: Kirigami.Units.smallSpacing
                width: Math.max(0, parent.width - x)
                spacing: 0
                RowLayout {
                    Layout.fillWidth: true
                    Controls.Label {
                        id: name
                        Layout.fillWidth: !modelLabel.visible
                        Layout.maximumWidth: modelLabel.visible ? Math.max(50, details.width * 0.45) : -1
                        text: (wrapper.rowData && wrapper.rowData.agent) || ""
                        textFormat: Text.PlainText
                        elide: Text.ElideRight
                        font: wrapper.isSubagent ? Kirigami.Theme.smallFont : Kirigami.Theme.defaultFont
                        opacity: wrapper.isSubagent ? 0.88 : 1.0
                    }
                    Controls.Label {
                        id: sep
                        text: "·"
                        textFormat: Text.PlainText
                        color: Kirigami.Theme.disabledTextColor
                        visible: modelLabel.visible
                        font: wrapper.isSubagent ? Kirigami.Theme.smallFont : Kirigami.Theme.defaultFont
                    }
                    Controls.Label {
                        id: modelLabel
                        Layout.fillWidth: true
                        text: (wrapper.rowData && wrapper.rowData.modelName) || ""
                        textFormat: Text.PlainText
                        elide: Text.ElideRight
                        color: Kirigami.Theme.disabledTextColor
                        visible: text !== ""
                        font: Kirigami.Theme.smallFont
                    }
                    Controls.Label {
                        text: wrapper.statusLabel
                        color: wrapper.statusColor
                        font: wrapper.isSubagent ? Kirigami.Theme.smallFont : Kirigami.Theme.defaultFont
                    }
                }
                Controls.Label {
                    Layout.fillWidth: true
                    text: (wrapper.rowData && wrapper.rowData.title) || ""
                    textFormat: Text.PlainText
                    elide: Text.ElideRight
                    visible: text !== ""
                    font: wrapper.isSubagent ? Kirigami.Theme.smallFont : Kirigami.Theme.defaultFont
                    opacity: wrapper.isSubagent ? 0.85 : 1.0
                }
                Controls.Label {
                    Layout.fillWidth: true
                    text: ((wrapper.rowData && wrapper.rowData.project) || "") + (wrapper.rowData && wrapper.rowData.branch ? " · " + wrapper.rowData.branch : "")
                    textFormat: Text.PlainText
                    elide: Text.ElideRight
                    font: Kirigami.Theme.smallFont
                    color: Kirigami.Theme.disabledTextColor
                    visible: text !== ""
                    opacity: wrapper.isSubagent ? 0.75 : 1.0
                }
            }
            Timer { id: flash; interval: 180 }
            MouseArea {
                id: mouse
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                acceptedButtons: Qt.LeftButton
                onClicked: { flash.restart(); wrapper.focusRequested((wrapper.rowData && wrapper.rowData.paneId) || "") }
            }
        }
    }
}
