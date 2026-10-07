import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";
import { i18n } from "@/i18n/i18next";
import { settingsStyles } from "@/styles/settings";

// An installed PWA runs in a standalone window with no address bar or reload
// control, and it can stay resident long after a new web image is deployed.
// The web image serves HTML with `Cache-Control: no-store` and hashed assets
// (fork-features/web-image/generate-config.mjs), so a full page reload always
// picks up the current deployment. The About section renders DesktopAppUpdateRow
// instead in Electron; native has no page to reload.
const FORK_STRINGS = {
  en: {
    title: "Reload app",
    hint: "Load the version currently deployed on this server",
    action: "Reload",
  },
  "zh-CN": {
    title: "重新加载应用",
    hint: "加载服务器当前部署的版本",
    action: "重新加载",
  },
} as const;

for (const [language, strings] of Object.entries(FORK_STRINGS)) {
  i18n.addResourceBundle(language, "translation", { fork: { webReload: strings } }, true, false);
}

// Module-level so the Button prop keeps a stable identity across renders.
function reloadPage(): void {
  window.location.reload();
}

export function WebReloadRow() {
  const { t } = useTranslation();
  if (!isWeb) {
    return null;
  }
  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("fork.webReload.title")}</Text>
        <Text style={settingsStyles.rowHint}>{t("fork.webReload.hint")}</Text>
      </View>
      <Button variant="outline" size="sm" onPress={reloadPage} testID="fork-web-reload">
        {t("fork.webReload.action")}
      </Button>
    </View>
  );
}
