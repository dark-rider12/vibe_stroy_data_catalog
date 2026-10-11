/*
MODULE: src/lineage/columnLineageFocus.js
ROLE: Управление фокусным режимом Column Lineage.

Фокусный режим (по умолчанию): в каждой карточке видны только колонки,
участвующие в lineage-цепочке выбранной колонки. Остальные скрыты.
Полный режим: все колонки видны (старое поведение).

НЕ ТРОГАЕТ математику маршрутизации линий — только управляет видимостью DOM-элементов.
*/

/**
 * Применяет фокусный режим к карточкам:
 * - скрывает колонки не из highlightedCols
 * - скрывает карточки целиком, если ни одна их колонка не участвует в lineage
 * Вызывается после рендера карточек и после смены выбранной колонки.
 *
 * @param {Element} pane - корневой элемент панели lineage
 * @param {Set<string>} highlightedCols - набор ключей "tableId.colName" участвующих колонок
 * @param {boolean} focusMode - true = фокусный режим, false = полный
 */
export function applyFocusMode(pane, highlightedCols, focusMode) {
  pane.querySelectorAll(".cll-column").forEach((el) => {
    const key = el.getAttribute("data-col-key");
    if (!focusMode) {
      el.style.display = "";
      el.classList.remove("cll-last-visible");
    } else {
      el.style.display = highlightedCols.has(key) ? "" : "none";
      el.classList.remove("cll-last-visible");
    }
  });

  // Обрабатываем карточки
  pane.querySelectorAll(".cll-card").forEach((card) => {
    if (!focusMode) {
      card.style.display = "";
      // В полном режиме добавляем класс к последней колонке
      const allCols = Array.from(card.querySelectorAll(".cll-column"));
      if (allCols.length > 0) {
        allCols[allCols.length - 1].classList.add("cll-last-visible");
      }
      return;
    }
    // В фокусном режиме добавляем класс к последней видимой колонке
    const visibleCols = Array.from(card.querySelectorAll(".cll-column"))
      .filter((el) => highlightedCols.has(el.getAttribute("data-col-key")));
    card.style.display = visibleCols.length > 0 ? "" : "none";
    if (visibleCols.length > 0) {
      const lastCol = visibleCols[visibleCols.length - 1];
      lastCol.classList.add("cll-last-visible");
    }
  });
}

/**
 * Пересчитывает margin-right у слоёв (.cll-layer) в зависимости от режима.
 *
 * В полном режиме — восстанавливает оригинальные значения (сохранённые при рендере).
 * В фокусном режиме — считает только рёбра между видимыми карточками и ставит
 * компактный gap: BASE_CHANNEL_WIDTH + visibleEdges * MIN_TRACK_GAP + 30.
 *
 * @param {Element} pane
 * @param {boolean} focusMode
 * @param {number} BASE_CHANNEL_WIDTH
 * @param {number} MIN_TRACK_GAP
 */
export function updateLayerGaps(pane, focusMode, edgeBendSource, MIN_TRACK_GAP, edgeBendTarget = edgeBendSource) {
  const layers = pane.querySelectorAll(".cll-layer");
  layers.forEach((layer) => {
    if (!focusMode) {
      // Восстанавливаем оригинальный gap, сохранённый при рендере
      const orig = layer.dataset.origMarginRight;
      if (orig !== undefined) {
        layer.style.marginRight = orig;
      }
      return;
    }

    // Считаем рёбра между видимыми карточками в этом слое и следующем
    // Ребро существует если: source-карточка в этом слое видима И target-карточка видима
    // Определяем видимые tableId в текущем слое
    const visibleTableIds = new Set();
    layer.querySelectorAll(".cll-card").forEach((card) => {
      if (card.style.display !== "none") {
        // Извлекаем tableId из id карточки: "cll-card-{uniqueId}-{tableId}"
        // tableId может содержать точки, uniqueId — дефисы формата db-schema-name
        const idAttr = card.id; // cll-card-{uniqueId}-{fullTableId}
        const colEl = card.querySelector(".cll-column[data-table-id]");
        if (colEl) {
          visibleTableIds.add(colEl.getAttribute("data-table-id"));
        }
      }
    });

    // Считаем видимые рёбра: колонки из видимых карточек этого слоя,
    // у которых есть линии к видимым карточкам следующего слоя.
    // Упрощённо: считаем видимые .cll-column в этом слое у которых есть хотя бы одно ребро.
    // Точный подсчёт — по количеству видимых колонок с data-col-key в highlightedCols
    // (каждая такая колонка = минимум одно ребро).
    let visibleEdgeCount = 0;
    layer.querySelectorAll(".cll-card").forEach((card) => {
      if (card.style.display === "none") return;
      card.querySelectorAll(".cll-column").forEach((col) => {
        if (col.style.display !== "none") {
          visibleEdgeCount++;
        }
      });
    });

    // Компактный gap для фокусного режима
    const focusGap = edgeBendSource + Math.max(0, visibleEdgeCount - 1) * MIN_TRACK_GAP + edgeBendTarget;
    layer.style.marginRight = focusGap + "px";
  });
}

/**
 * Сохраняет оригинальные margin-right слоёв сразу после рендера,
 * чтобы можно было восстановить их при выходе из фокусного режима.
 *
 * @param {Element} pane
 */
export function saveOriginalLayerGaps(pane) {
  pane.querySelectorAll(".cll-layer").forEach((layer) => {
    layer.dataset.origMarginRight = layer.style.marginRight || "";
  });
}

/**
 * Создаёт HTML кнопки переключения режима для тулбара.
 * Возвращает строку HTML.
 *
 * @param {boolean} focusMode - текущий режим
 * @returns {string}
 */
export function buildFocusToggleBtn(focusMode) {
  const title = focusMode ? "Показать все колонки" : "Фокус: только связанные колонки";
  const activeClass = focusMode ? " is-active" : "";
  // Иконка: воронка/фильтр для фокусного режима
  return `<button class="ln-tool-btn ln-focus-btn${activeClass}" data-tool="focus-toggle" title="${title}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
    </svg>
  </button>`;
}

/**
 * Обновляет внешний вид кнопки фокуса после переключения.
 *
 * @param {Element} pane
 * @param {boolean} focusMode
 */
export function updateFocusBtn(pane, focusMode) {
  const btn = pane.querySelector(".ln-focus-btn");
  if (!btn) return;
  if (focusMode) {
    btn.classList.add("is-active");
    btn.title = "Показать все колонки";
  } else {
    btn.classList.remove("is-active");
    btn.title = "Фокус: только связанные колонки";
  }
}
