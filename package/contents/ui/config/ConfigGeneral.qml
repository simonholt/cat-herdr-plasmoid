import QtQuick
import QtQuick.Controls as Controls
import org.kde.kirigami as Kirigami
import org.kde.kcmutils as KCM

KCM.SimpleKCM {
    property string cfg_herdrCmd
    property int cfg_refreshMs
    property bool cfg_multiplexAware

    Kirigami.FormLayout {
        Controls.TextField {
            id: herdrField
            Kirigami.FormData.label: i18n("Herdr command:")
            text: cfg_herdrCmd
            onTextChanged: cfg_herdrCmd = text
        }

        Controls.SpinBox {
            id: refreshField
            Kirigami.FormData.label: i18n("Refresh interval (ms):")
            from: 500
            to: 3600000
            stepSize: 500
            value: cfg_refreshMs
            onValueModified: cfg_refreshMs = value
        }

        Controls.CheckBox {
            id: multiplexField
            Kirigami.FormData.label: i18n("Multiplexing awareness:")
            text: i18n("Show subagents nested under parents")
            checked: cfg_multiplexAware
            onToggled: cfg_multiplexAware = checked
        }
    }
}
