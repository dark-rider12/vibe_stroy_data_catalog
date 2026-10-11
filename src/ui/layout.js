/* 
MODULE: src/ui/layout.js
ROLE: Управление базовым UI (ресайз панели, табы).
*/

export const sidebar = document.getElementById("sidebar");
export const resizer = document.getElementById("resizer");
let isResizing = false;
let isSidebarCollapsed = false;

export function initLayout() {
  if (resizer && sidebar) {
    resizer.addEventListener("mousedown", (e) => {
      isResizing = true;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      resizer.classList.add("is-resizing");
    });

    document.addEventListener("mousemove", (e) => {
      if (!isResizing) return;
      let newWidth = e.clientX;
      if (newWidth < 220) newWidth = 220;
      if (newWidth > window.innerWidth / 2) newWidth = window.innerWidth / 2;
      if (newWidth > 800) newWidth = 800;
      sidebar.style.width = newWidth + "px";
    });

    document.addEventListener("mouseup", () => {
      if (isResizing) {
        isResizing = false;
        document.body.style.cursor = "default";
        document.body.style.userSelect = "auto";
        resizer.classList.remove("is-resizing");
      }
    });
  }
}

export function toggleSidebar() {
  if (!sidebar) return;
  
  isSidebarCollapsed = !isSidebarCollapsed;
  
  if (isSidebarCollapsed) {
    sidebar.classList.add("collapsed");
    document.body.classList.add("sidebar-collapsed");
  } else {
    sidebar.classList.remove("collapsed");
    document.body.classList.remove("sidebar-collapsed");
  }

  // После завершения CSS-transition (300ms) пересчитываем позиции ресайзеров
  setTimeout(() => {
    window.dispatchEvent(new Event('resize'));
  }, 320);
}

/**
 * Инициализирует ресайз столбцов для таблицы по её ID.
 * Создаёт оверлей-ресайзеры поверх таблицы — на всю её высоту.
 * Вызывается при открытии страницы таблицы.
 */
export function initTableColumnResize(tableId) {
  const table = document.getElementById(`tbl-${tableId}`);
  if (!table) return;

  // Предотвращаем повторную инициализацию
  if (table._colResizeInited) return;
  table._colResizeInited = true;

  // Оборачиваем таблицу в позиционированный контейнер
  const wrapper = document.createElement('div');
  wrapper.className = 'table-resize-wrapper';
  table.parentNode.insertBefore(wrapper, table);
  wrapper.appendChild(table);

  // Колонки для ресайза (все кроме последней — кнопка lineage)
  const cols = table.querySelectorAll('col');
  // Ресайзеры ставим между колонками: после 0..N-2 (не после последней)
  const resizableCount = cols.length - 1;

  // Создаём ресайзеры
  const resizerEls = [];
  for (let i = 0; i < resizableCount; i++) {
    const rz = document.createElement('div');
    rz.className = 'col-resizer';
    rz.dataset.col = i;
    wrapper.appendChild(rz);
    resizerEls.push(rz);
  }

  // Функция пересчёта позиций ресайзеров
  function updateResizerPositions() {
    const ths = table.querySelectorAll('thead th');

    // Если таблица ещё не отрендерена (display:none или нулевая высота),
    // откладываем пересчёт — иначе ресайзеры получат height:0 и останутся невидимыми
    if (!table.offsetHeight) {
      requestAnimationFrame(updateResizerPositions);
      return;
    }

    let accumulatedLeft = 0;
    for (let i = 0; i < resizableCount; i++) {
      const th = ths[i];
      if (!th) continue;
      accumulatedLeft += th.offsetWidth;
      const rz = resizerEls[i];
      rz.style.left = accumulatedLeft + 'px';
      rz.style.height = table.offsetHeight + 'px';
    }
  }

  // Первичная расстановка после рендера.
  // Двойной rAF гарантирует, что браузер успел пересчитать layout
  // (особенно важно для dm-таблиц, где display:block применяется через CSS-класс).
  requestAnimationFrame(() => {
    requestAnimationFrame(updateResizerPositions);
  });

  // Навешиваем drag-логику на каждый ресайзер
  resizerEls.forEach((rz) => {
    const colIndex = parseInt(rz.dataset.col, 10);

    rz.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const col = cols[colIndex];
      if (!col) return;

      const startX = e.clientX;
      const startWidth = table.querySelectorAll('thead th')[colIndex].offsetWidth;

      rz.classList.add('is-resizing');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMouseMove = (moveEvent) => {
        const delta = moveEvent.clientX - startX;
        const newWidth = Math.max(40, startWidth + delta);
        col.style.width = newWidth + 'px';
        updateResizerPositions();
      };

      const onMouseUp = () => {
        rz.classList.remove('is-resizing');
        document.body.style.cursor = 'default';
        document.body.style.userSelect = 'auto';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        updateResizerPositions();
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  });

  // Обновляем позиции при ресайзе окна
  window.addEventListener('resize', updateResizerPositions);
}

export function switchTab(btn, paneClass, parentId) {
  const parent = document.getElementById(parentId);
  if (!parent) return;
  parent
    .querySelectorAll(".tab-btn")
    .forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  parent
    .querySelectorAll(".tab-pane")
    .forEach((p) => p.classList.remove("active"));
  parent.querySelector("." + paneClass).classList.add("active");

  // Синхронизируем хэш в строке браузера с выбранной вкладкой (:lineage, :script, :dq и т.д.)
  const tabSuffixMap = {
    "pane-lineage": ":lineage",
    "pane-col-lineage": ":col-lineage",
    "pane-script": ":script",
    "pane-dq": ":dq",
    "pane-cols": "",
  };
  const suffix = tabSuffixMap[paneClass] !== undefined ? tabSuffixMap[paneClass] : "";
  const newHash = `#${parentId}${suffix}`;
  if (window.location.hash !== newHash) {
    history.replaceState(null, "", newHash);
  }

  const mainBody = document.querySelector(".main-body");
  const searchHeader = document.querySelector(".search-header");
  if (mainBody) {
    mainBody.classList.toggle(
      "lineage-scroll-locked",
      paneClass === "pane-lineage" || paneClass === "pane-col-lineage",
    );
  }

  // Toggle compression for lineage views
  const isLineage = paneClass === "pane-col-lineage" || paneClass === "pane-lineage";
  if (mainBody) mainBody.classList.toggle("compressed", isLineage);
  if (searchHeader) searchHeader.classList.toggle("compressed", isLineage);
  parent.classList.toggle("compressed", isLineage);

  // Скрываем верхнюю часть (хлебные крошки, описание, источники) для экономии места
  const topElements = parent.querySelectorAll(
    ".breadcrumbs, .table-description, .table-sources",
  );
  if (isLineage || paneClass === "pane-script") {
    topElements.forEach((el) => (el.style.display = "none"));
  } else {
    topElements.forEach((el) => (el.style.display = ""));
  }

  // Показываем переключатель "Time Machine" и легенду только на вкладке Table Lineage
  const staleToggle = parent.querySelector(`#stale-toggle-${parentId}`);
  if (staleToggle) {
    staleToggle.style.display = paneClass === "pane-lineage" ? "inline-flex" : "none";
  }
  const staleLegend = parent.querySelector(`#stale-legend-${parentId}`) || parent.querySelector(".ln-stale-legend");
  if (staleLegend) {
    const isStaleActive = window.isStaleModeActive ? window.isStaleModeActive(parentId) : false;
    staleLegend.style.display = (paneClass === "pane-lineage" && isStaleActive) ? "inline-flex" : "none";
  }

  // При переключении на вкладку "Колонки" пересчитываем позиции ресайзеров —
  // они могли быть инициализированы когда таблица была скрыта (height: 0)
  if (paneClass === "pane-cols") {
    const tbl = parent.querySelector('table[id^="tbl-"]');
    if (tbl && tbl._colResizeInited) {
      requestAnimationFrame(() => {
        const ths = tbl.querySelectorAll('thead th');
        const wrapper = tbl.closest('.table-resize-wrapper');
        if (!wrapper) return;
        const resizerEls = wrapper.querySelectorAll('.col-resizer');
        let accumulatedLeft = 0;
        resizerEls.forEach((rz, i) => {
          const th = ths[i];
          if (!th) return;
          accumulatedLeft += th.offsetWidth;
          rz.style.left = accumulatedLeft + 'px';
          rz.style.height = tbl.offsetHeight + 'px';
        });
      });
    }
  }
}
