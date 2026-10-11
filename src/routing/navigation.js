/* 
MODULE: src/routing/navigation.js
ROLE: Управление навигацией по хэшу в URL.
*/

import { initHomeSchemaAnimation } from "../ui/homeAnimation.js";
import { initTableColumnResize } from "../ui/layout.js";
import { initScriptLineNumbers, initScriptWordHighlight } from "../utils/helpers.js";
import { resetColumnFilters, refreshColumnFilterCounts } from "../ui/columnFilter.js";

const searchInput = document.getElementById("search-input");
const searchResultsView = document.getElementById("search-results");
const searchCount = document.getElementById("search-count");
const welcomeScreen = document.getElementById("welcome-screen");

/**
 * Разворачивает <template id="tpl-<id>"> в обычный div.table-view и вставляет в .main-body.
 * Вызывается при первой навигации к таблице.
 * @param {string} targetId - уникальный ID таблицы (db-schema-name)
 * @returns {HTMLElement|null} - вставленный элемент или null
 */
function expandTableTemplate(targetId) {
  const tpl = document.getElementById(`tpl-${targetId}`);
  if (!tpl) return null;

  const mainBody = document.querySelector(".main-body");
  if (!mainBody) return null;

  // Клонируем содержимое template в DocumentFragment и достаём первый элемент
  const fragment = tpl.content.cloneNode(true);
  // table.html рендерит один корневой div.table-view — он будет первым элементом
  const tableDiv = fragment.querySelector(".table-view") || fragment.firstElementChild;
  if (!tableDiv) return null;

  // Убеждаемся что id установлен корректно
  if (!tableDiv.id) tableDiv.id = targetId;

  mainBody.appendChild(tableDiv);

  // Удаляем template из DOM — он больше не нужен
  tpl.remove();

  // Инициализируем счётчик поиска по колонкам («Всего колонок: N»)
  refreshColumnFilterCounts();

  return tableDiv;
}

export function restoreCurrentView() {
  const mainBody = document.querySelector(".main-body");
  if (mainBody) mainBody.classList.remove("lineage-scroll-locked");

  document
    .querySelectorAll(".table-view")
    .forEach((el) => (el.style.display = "none"));
  if (welcomeScreen) welcomeScreen.style.display = "none";
  if (searchResultsView) searchResultsView.style.display = "none";
  if (searchCount) searchCount.style.display = "none";

  const hash = window.location.hash;
  if (!hash || hash === "#home") {
    if (welcomeScreen) {
      welcomeScreen.style.display = "block";
      initHomeSchemaAnimation();
    }
    return;
  }

  // Отрезаем символ '#' и разбираем id и опциональную вкладку (#targetId:lineage или #targetId/lineage)
  const rawHash = hash.substring(1).split("?")[0];
  const [targetId, tabName] = rawHash.includes(":")
    ? rawHash.split(":")
    : rawHash.includes("/")
      ? rawHash.split("/")
      : [rawHash, null];

  let targetDiv = document.getElementById(targetId);

  // Если div ещё не в DOM — разворачиваем template (lazy rendering)
  if (!targetDiv) {
    targetDiv = expandTableTemplate(targetId);
  }

  if (targetDiv) {
    targetDiv.style.display = "block";

    // Выбор вкладки: если в URL указана вкладка (например, :lineage), активируем её сразу
    let targetTabBtn = null;
    if (tabName) {
      targetTabBtn = targetDiv.querySelector(`.tab-btn[onclick*='pane-${tabName}']`);
    }
    if (!targetTabBtn) {
      targetTabBtn = targetDiv.querySelector(".tab-btn");
    }
    if (targetTabBtn) targetTabBtn.click();

    initScriptLineNumbers();
    initScriptWordHighlight();

    // setTimeout(0) гарантирует, что браузер применил CSS (display:block через .active)
    // до инициализации ресайзеров — иначе offsetWidth может быть 0
    setTimeout(() => initTableColumnResize(targetId), 0);
    return;
  }
  if (welcomeScreen) welcomeScreen.style.display = "block";
}

// Умный переход, который срабатывает даже если мы уже находимся на этой странице
export function navigateTo(hash) {
  if (window.location.hash === hash) {
    // Если хеш не изменился, браузер не вызовет hashchange.
    // Поэтому очищаем поиск и обновляем вид вручную.
    if (searchInput) searchInput.value = "";
    handleNavigation();
  } else {
    // Если хеш новый, просто меняем URL, дальше сработает событие hashchange
    window.location.hash = hash;
  }
}

export function handleNavigation() {
  if (searchInput) searchInput.value = "";
  resetColumnFilters();
  restoreCurrentView();
  const mainBody = document.querySelector(".main-body");
  if (mainBody) mainBody.scrollTop = 0;
}

export function initNavigation() {
  window.addEventListener("hashchange", handleNavigation);
  window.addEventListener("load", handleNavigation);

  document.querySelectorAll(".sidebar a").forEach((link) => {
    link.addEventListener("click", () => {
      if (searchInput) searchInput.value = "";
      setTimeout(handleNavigation, 10);
    });
  });
}
