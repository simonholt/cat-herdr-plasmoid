import QtQuick
import QtQuick.Layouts
import org.kde.kirigami as Kirigami

Item {
    id: root

    Layout.minimumWidth: Kirigami.Units.gridUnit * 20
    Layout.minimumHeight: Kirigami.Units.gridUnit * 15

    Kirigami.Heading {
        anchors.centerIn: parent
        text: "Cat Herdr"
        level: 2
    }
}
