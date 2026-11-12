import { setupContactAlignment } from './animation/contact-wire.js';
import { initTrolleyScene } from './animation/trolley.js';
import { bindStaticEvents } from './core/events.js';
import { configureRefresh } from './core/refresh.js';
import { activateTab, applyPermissions, fillSelects, openModule, renderCurrentView } from './core/shell.js';
import { currentModule } from './core/state.js';
import { checkAuthentication, showAuth, syncAccessScopeWithUser } from './features/auth.js';
import { bsoLoaded, refreshBsoState, syncBsoWithFleet } from './features/equipment.js';
import { initJournal, renderActive } from './features/journal.js';
import { migrateLocalNavigationRecords, syncNavigationRecordsFromState } from './features/navigation.js';
import { bindNotificationEvents, syncRequestNotifications } from './features/notifications.js';
import { exportCurrentModuleExcel } from './features/reports.js';
import { initRequestFlow } from './features/request-flow.js';
import { initWarehouse } from './features/warehouse.js';
import * as NavControl from './features/nav-control.js';

async function startApplication() {
  bindRefreshView();
  initTrolleyScene();
  initJournal(activateTab);
  initRequestFlow(renderActive);
  initWarehouse({openModule, exportCurrentModuleExcel});
  bindStaticEvents();
  NavControl.init();
  bindNotificationEvents();
  setupContactAlignment();
  await checkAuthentication();
}

startApplication();
function bindRefreshView() {
  configureRefresh({
    syncFeatures(includeNavigation) {
      if (includeNavigation) syncNavigationRecordsFromState();
      if (bsoLoaded) syncBsoWithFleet();
      syncAccessScopeWithUser();
    },
    updateControls() {
      applyPermissions();
      fillSelects();
    },
    render: renderCurrentView,
    afterRender({announce, includeNavigation}) {
      syncRequestNotifications({announce});
      if (includeNavigation) migrateLocalNavigationRecords();
    },
    onSessionExpired() {
      showAuth('login', 'Сеанс завершён. Войдите снова.');
    },
    async pollFeatures() {
      if (currentModule === 'bso') {
        await refreshBsoState({force: true}).catch(error => console.warn('Не удалось обновить учёт БСО.', error));
      }
      if (currentModule === 'navcontrol') {
        await NavControl.refresh().catch(error => console.warn('Не удалось обновить контроль навигации.', error));
      }
    }
  });
}
