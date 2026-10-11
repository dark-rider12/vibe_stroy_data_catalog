/* 
MODULE: src/index.js
ROLE: Главный входной файл (Entry Point). Инициализирует приложение и прокидывает нужные функции в глобальную область видимости (window).
*/

import { initLayout, switchTab, toggleSidebar, initTableColumnResize } from "./ui/layout.js";
import { initSearch } from "./ui/search.js";
import { initColumnFilter } from "./ui/columnFilter.js";
import { initNavigation, navigateTo, handleNavigation } from "./routing/navigation.js";
import { copyText, copySearchResult, copyTableData, exportTableToHTML, copyScriptContent, copyDqScript, generateDqScript, generateFillDqScript, fillDmComments, initScriptLineNumbers, initScriptWordHighlight, initDqScripts } from "./utils/helpers.js";
import { handleLineageClick, handleLineageContextMenu, renderLineage } from "./lineage/tableLineage.js";
import { openColumnLineage } from "./lineage/columnLineage.js";
import { initHomeSchemaAnimation } from "./ui/homeAnimation.js";
import {
  toggleNewDataSource,
  toggleCheckDescendant,
  selectAllEligibleDescendants,
  resetRebuildFlow,
  openRebuildSqlModal,
} from "./lineage/tableLineageRebuild.js";
import {
  toggleStaleMode,
  openStaleModal,
  closeStaleModal,
} from "./lineage/tableLineageStale.js";

// Экспортируем данные и функции в глобальную область видимости,
// так как они вызываются из inline-обработчиков в HTML (onclick, ondblclick и т.д.)
// window.catalogData is already set by the Python backend in index.html template
window.switchTab = switchTab;
window.toggleSidebar = toggleSidebar;
window.initTableColumnResize = initTableColumnResize;
window.navigateTo = navigateTo;
window.copyText = copyText;
window.copySearchResult = copySearchResult;
window.copyTableData = copyTableData;
window.exportTableToHTML = exportTableToHTML;
window.copyScriptContent = copyScriptContent;
window.copyDqScript = copyDqScript;
window.generateDqScript = generateDqScript;
window.generateFillDqScript = generateFillDqScript;
window.fillDmComments = fillDmComments;
window.handleLineageClick = handleLineageClick;
window.handleLineageContextMenu = handleLineageContextMenu;
window.renderLineage = renderLineage;
window.openColumnLineage = openColumnLineage;
window.toggleNewDataSource = toggleNewDataSource;
window.toggleCheckDescendant = toggleCheckDescendant;
window.selectAllEligibleDescendants = selectAllEligibleDescendants;
window.resetRebuildFlow = resetRebuildFlow;
window.openRebuildSqlModal = openRebuildSqlModal;
window.toggleStaleMode = toggleStaleMode;
window.openStaleModal = openStaleModal;
window.closeStaleModal = closeStaleModal;

// Инициализация приложения при загрузке DOM
document.addEventListener("DOMContentLoaded", () => {
  // Инициализируем UI компоненты
  initLayout();
  initSearch();
  initColumnFilter();
  
  // Инициализируем роутинг
  initNavigation();
  
  // Запускаем анимацию на главном экране
  initHomeSchemaAnimation();
  
  // Нумерация строк в блоках скрипта (стиль DBeaver)
  initScriptLineNumbers();

  // Подсветка совпадений при выделении слова (стиль DBeaver)
  initScriptWordHighlight();

  // Инициализация скриптов Data Quality
  initDqScripts();

  // Вызываем обработчик навигации для текущего URL
  handleNavigation();

  // Скрываем спиннер загрузки — приложение готово
  const overlay = document.getElementById("app-loading-overlay");
  if (overlay) {
    overlay.classList.add("hidden");
    // Удаляем из DOM после завершения transition (0.25s)
    overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
  }
});
