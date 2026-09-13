import QtQuick
import QtQuick.Controls as Controls
import org.kde.kirigami as Kirigami
import org.kde.kcmutils as KCM

KCM.SimpleKCM {
    property alias cfg_placeholder: placeholderField.text

    Kirigami.FormLayout {
        Controls.TextField {
            id: placeholderField
            Kirigami.FormData.label: i18n("Placeholder:")
        }
    }
}
