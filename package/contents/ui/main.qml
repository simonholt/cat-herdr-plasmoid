import QtQuick
import QtQuick.Layouts
import org.kde.plasma.plasmoid
import org.kde.plasma.core as PlasmaCore
import org.kde.kirigami as Kirigami

PlasmoidItem {
    id: root
    Plasmoid.icon: "catherder"
    Plasmoid.title: i18n("Cat Herdr")
    preferredRepresentation: Plasmoid.formFactor === PlasmaCore.Types.Planar ? fullRepresentation : compactRepresentation
    toolTipMainText: i18n("Cat Herdr")
    toolTipSubText: backend.phase === "live" ? backend.summary : backend.message

    Observer {
        id: backend
        command: Plasmoid.configuration.herdrCmd
        refreshMs: Plasmoid.configuration.refreshMs
        multiplexAware: Plasmoid.configuration.multiplexAware !== false
    }
    fullRepresentation: Board { observer: backend }
    compactRepresentation: Item {
        implicitWidth: chip.implicitWidth + Kirigami.Units.largeSpacing * 2
        implicitHeight: Kirigami.Units.iconSizes.smallMedium
        Layout.minimumWidth: implicitWidth
        Row {
            id: chip
            anchors.centerIn: parent
            spacing: Kirigami.Units.smallSpacing
            Rectangle {
                width: Kirigami.Units.smallSpacing * 2
                height: width
                radius: width / 2
                anchors.verticalCenter: parent.verticalCenter
                color: backend.phase === "error" || backend.blocked > 0 ? Kirigami.Theme.negativeTextColor
                    : backend.working > 0 ? Kirigami.Theme.highlightColor
                    : backend.count > 0 ? Kirigami.Theme.positiveTextColor : Kirigami.Theme.disabledTextColor
            }
            Text {
                text: backend.phase === "error" ? "!" : String(backend.count)
                color: Kirigami.Theme.textColor
                font: Kirigami.Theme.defaultFont
            }
        }
        MouseArea { anchors.fill: parent; acceptedButtons: Qt.LeftButton; onClicked: root.expanded = !root.expanded }
    }
}
