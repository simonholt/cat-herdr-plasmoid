import QtQuick
import QtQuick.Controls as Controls
import QtQuick.Layouts
import org.kde.kirigami as Kirigami

Item {
    id: board
    required property var observer
    implicitWidth: 460
    implicitHeight: 600
    Layout.minimumWidth: 280
    Layout.minimumHeight: 200
    ColumnLayout {
        anchors.fill: parent
        anchors.margins: Kirigami.Units.largeSpacing
        spacing: Kirigami.Units.smallSpacing
        RowLayout {
            Layout.fillWidth: true
            Controls.Label {
                text: i18n("AI Agents")
                font.bold: true
                font.pointSize: Kirigami.Theme.defaultFont.pointSize * 1.25
                Layout.fillWidth: true
                elide: Text.ElideRight
            }
            Controls.Label { text: board.observer.count; color: Kirigami.Theme.disabledTextColor }
        }
        Item {
            Layout.fillWidth: true
            Layout.fillHeight: true
            ListView {
                id: list
                objectName: "agentList"
                anchors.fill: parent
                anchors.rightMargin: Kirigami.Units.largeSpacing + Kirigami.Units.gridUnit
                visible: board.observer.phase === "live"
                clip: true
                model: board.observer.rows
                boundsBehavior: Flickable.StopAtBounds
                reuseItems: false
                spacing: 0
                delegate: BoardRow {
                    width: list.width
                    row: list.model && index >= 0 ? list.model.get(index) : ({})
                    onFocusRequested: pane => board.observer.focusPane(pane)
                }
            }
            Controls.Label {
                anchors.centerIn: parent
                width: parent.width
                visible: board.observer.phase !== "live"
                text: board.observer.message
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                horizontalAlignment: Text.AlignHCenter
                color: board.observer.phase === "error" ? Kirigami.Theme.negativeTextColor : Kirigami.Theme.textColor
            }
        }
        Controls.Label {
            Layout.fillWidth: true
            text: board.observer.phase === "live" ? board.observer.summary : board.observer.phase === "error" ? i18n("Retrying automatically…") : ""
            elide: Text.ElideRight
            color: Kirigami.Theme.disabledTextColor
            font.pointSize: Kirigami.Theme.smallFont.pointSize
        }
    }
}
