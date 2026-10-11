/* 
MODULE: src/ui/columnFilter.js
ROLE: Поиск по названию колонки таблицы (стиль DBeaver).
      Панель поиска всегда видима на странице таблицы; Ctrl+F — быстрый фокус.
      Скрывает tr.col-row, у которых имя колонки не содержит запрос.
*/

// Возвращает видимую страницу таблицы (если она сейчас открыта)
function getVisibleTableView() {
  const views = document.querySelectorAll(".table-view");
  for (const v of views) {
    if (v.style.display !== "none") return v;
  }
  return null;
}

// Активна ли вкладка «Колонки» (pane-cols) у указанной страницы таблицы
function isColumnsPaneActive(tableView) {
  const pane = tableView.querySelector(".tab-pane.pane-cols");
  return pane ? pane.classList.contains("active") : false;
}

// Обновляет позиции ресайзеров колонок — высота таблицы меняется после фильтрации
function refreshResizers() {
  window.dispatchEvent(new Event("resize"));
}

// Фильтрует строки таблицы колонок по имени колонки (td.col-name) и описанию (td.col-desc / Бизнес описание)
function applyFilter(tableView, query) {
  const rows = tableView.querySelectorAll(".col-row");
  const q = query.trim().toLowerCase();
  let visible = 0;

  rows.forEach((row) => {
    const nameEl = row.querySelector(".col-name") || (row.cells ? row.cells[1] : null);
    const descEl = row.querySelector(".col-desc") || (row.cells ? row.cells[3] : null);
    const name = nameEl ? nameEl.textContent.trim().toLowerCase() : "";
    const desc = descEl ? descEl.textContent.trim().toLowerCase() : "";
    const match = !q || name.includes(q) || desc.includes(q);

    row.classList.toggle("col-row--hidden", !match);
    if (match) visible++;
  });

  const countEl = tableView.querySelector(".col-filter-count");
  if (countEl) {
    countEl.textContent = q
      ? `Найдено: ${visible} из ${rows.length}`
      : `Всего колонок: ${rows.length}`;
  }

  refreshResizers();
}

// Фокус в поле поиска страницы таблицы (Ctrl+F или клик по панели)
function focusColumnFilter(tableView) {
  const input = tableView.querySelector(".col-filter-input");
  if (!input) return;
  input.focus();
  input.select();
}

function resetColumnFilter(tableView) {
  const input = tableView.querySelector(".col-filter-input");
  if (input) input.value = "";
  applyFilter(tableView, "");
}

// Сброс фильтров (вызывается при навигации к другой таблице/главной)
export function resetColumnFilters() {
  document.querySelectorAll(".col-filter").forEach((bar) => {
    const tableView = bar.closest(".table-view");
    if (tableView) resetColumnFilter(tableView);
  });
}

// Обновляет счётчики для всех уже развёрнутых таблиц (инициализация «Всего колонок: N»)
export function refreshColumnFilterCounts() {
  document.querySelectorAll(".col-filter").forEach((bar) => {
    const tableView = bar.closest(".table-view");
    if (!tableView) return;
    const input = bar.querySelector(".col-filter-input");
    applyFilter(tableView, input ? input.value : "");
  });
}

export function initColumnFilter() {
  // Перехват Ctrl+F только на активной вкладке «Колонки» (e.code не зависит от раскладки клавиатуры).
  // На остальных вкладках/страницах Ctrl+F оставляем браузеру (штатная поисковая строка)
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.code !== "KeyF") return;

    const tableView = getVisibleTableView();
    if (!tableView || !isColumnsPaneActive(tableView)) return;

    e.preventDefault();
    focusColumnFilter(tableView);
  });

  // Фильтрация по мере ввода (делегирование — таблицы клонируются из template)
  document.addEventListener("input", (e) => {
    if (!e.target.classList.contains("col-filter-input")) return;
    const bar = e.target.closest(".col-filter");
    const tableView = bar ? bar.closest(".table-view") : null;
    if (!tableView) return;
    applyFilter(tableView, e.target.value);
  });

  // Клик по полю — фокус + выделение текста
  document.addEventListener("click", (e) => {
    if (!e.target.classList.contains("col-filter-input")) return;
    const bar = e.target.closest(".col-filter");
    const tableView = bar ? bar.closest(".table-view") : null;
    if (tableView) e.target.select();
  });

  // Сброс фильтра по кнопке ✕
  document.addEventListener("click", (e) => {
    const closeBtn = e.target.closest(".col-filter-close");
    if (!closeBtn) return;
    const bar = closeBtn.closest(".col-filter");
    const tableView = bar ? bar.closest(".table-view") : null;
    if (tableView) resetColumnFilter(tableView);
  });

  // Сброс фильтра по Esc
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const bar = document.querySelector(".col-filter");
    if (!bar) return;
    const tableView = bar.closest(".table-view");
    if (!tableView) return;
    const input = bar.querySelector(".col-filter-input");
    if (document.activeElement === input || bar.contains(document.activeElement)) {
      resetColumnFilter(tableView);
      e.preventDefault();
    }
  });
}