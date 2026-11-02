/* 
MODULE: src/ui/sidebarSearch.js
ROLE: Поиск и фильтрация объектов в боковой панели (в стиле DBeaver).
      - Фильтрует дерево #tree в реальном времени по имени таблиц/вью/схем/БД
      - Поддерживает названия в псевдоэлементах .tree-title[data-title] (изолированных от Ctrl+F)
      - Автоматически раскрывает родительские узлы (схемы, БД), содержащие совпадения
      - Скрывает несовпадающие ветки
      - Восстанавливает исходное состояние дерева при очистке
      - Поддерживает кнопку очистки [X] и клавишу Escape
*/

let originalDetailsState = new WeakMap();
let hasSavedState = false;

function getNodeText(el) {
  if (!el) return "";
  const titleSpan = el.querySelector(".tree-title");
  if (titleSpan && titleSpan.dataset.title) {
    return titleSpan.dataset.title;
  }
  if (el.dataset && (el.dataset.name || el.dataset.title)) {
    return el.dataset.name || el.dataset.title;
  }
  return el.textContent || "";
}

export function initSidebarSearch() {
  const tree = document.getElementById("tree");
  if (!tree) return;

  // Если разметка поиска еще не встроена в HTML, создаем ее динамически
  let container = document.querySelector(".sidebar-search-sticky");
  if (!container) {
    const homeBtn = document.querySelector(".home-btn");
    if (homeBtn && homeBtn.parentNode) {
      container = document.createElement("div");
      container.className = "sidebar-search-sticky";
      container.innerHTML = `
        <div class="sidebar-search-wrapper">
          <svg class="sidebar-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input type="text" id="sidebar-search-input" class="sidebar-search-box" placeholder="Поиск по объектам..." autocomplete="off" spellcheck="false">
          <button type="button" id="sidebar-search-clear" class="sidebar-search-clear" title="Очистить поиск" style="display: none;">✕</button>
        </div>
      `;
      homeBtn.parentNode.insertBefore(container, homeBtn.nextSibling);
    }
  }

  const input = document.getElementById("sidebar-search-input");
  const clear = document.getElementById("sidebar-search-clear");
  if (!input) return;

  function saveDefaultState() {
    if (hasSavedState) return;
    tree.querySelectorAll("details").forEach((d) => {
      originalDetailsState.set(d, d.open);
    });
    hasSavedState = true;
  }

  function restoreState() {
    tree.querySelectorAll("details").forEach((d) => {
      if (originalDetailsState.has(d)) {
        d.open = originalDetailsState.get(d);
      }
    });
    tree.querySelectorAll("li").forEach((li) => {
      li.style.display = "";
    });
    hasSavedState = false;
  }

  function filterTree(query) {
    const q = query.trim().toLowerCase();

    if (clear) {
      clear.style.display = q ? "flex" : "none";
    }

    if (!q) {
      restoreState();
      return;
    }

    saveDefaultState();

    // 1. Уровень баз данных: ul#tree > li
    const dbLis = tree.querySelectorAll(":scope > li");
    dbLis.forEach((dbLi) => {
      const dbDetails = dbLi.querySelector(":scope > details");
      if (!dbDetails) return;

      const dbSummary = dbDetails.querySelector(":scope > summary");
      const dbName = getNodeText(dbSummary).trim().toLowerCase();
      const dbMatches = dbName.includes(q);
      let dbHasVisibleChild = false;

      // 2. Уровень обычных схем (core, calc и др.): ul > li:not(.sidebar-systems-group)
      const schemaLis = dbDetails.querySelectorAll(":scope > ul > li:not(.sidebar-systems-group)");
      schemaLis.forEach((schemaLi) => {
        const schemaDetails = schemaLi.querySelector(":scope > details");
        if (!schemaDetails) return;

        const schemaSummary = schemaDetails.querySelector(":scope > summary");
        const schemaName = getNodeText(schemaSummary).trim().toLowerCase();
        const schemaMatches = schemaName.includes(q);
        let schemaHasVisibleChild = false;

        // 3. Уровень таблиц/представлений: ul > li
        const tableLis = schemaDetails.querySelectorAll(":scope > ul > li");
        tableLis.forEach((tableLi) => {
          const a = tableLi.querySelector("a");
          const tableName = getNodeText(a).trim().toLowerCase();
          const tableMatches = tableName.includes(q) || schemaMatches || dbMatches;

          if (tableMatches) {
            tableLi.style.display = "";
            schemaHasVisibleChild = true;
          } else {
            tableLi.style.display = "none";
          }
        });

        if (schemaHasVisibleChild || schemaMatches) {
          schemaLi.style.display = "";
          schemaDetails.open = true;
          dbHasVisibleChild = true;
        } else {
          schemaLi.style.display = "none";
        }
      });

      // 2б. Уровень группы системных схем (Systems)
      const sysGroupLi = dbDetails.querySelector(":scope > ul > li.sidebar-systems-group");
      if (sysGroupLi) {
        const sysGroupDetails = sysGroupLi.querySelector(":scope > details");
        let sysGroupHasVisibleChild = false;

        if (sysGroupDetails) {
          const sysSchemaLis = sysGroupDetails.querySelectorAll(":scope > ul > li");
          sysSchemaLis.forEach((schemaLi) => {
            const schemaDetails = schemaLi.querySelector(":scope > details");
            if (!schemaDetails) return;

            const schemaSummary = schemaDetails.querySelector(":scope > summary");
            const schemaName = getNodeText(schemaSummary).trim().toLowerCase();
            const schemaMatches = schemaName.includes(q);
            let schemaHasVisibleChild = false;

            const tableLis = schemaDetails.querySelectorAll(":scope > ul > li");
            tableLis.forEach((tableLi) => {
              const a = tableLi.querySelector("a");
              const tableName = getNodeText(a).trim().toLowerCase();
              const tableMatches = tableName.includes(q) || schemaMatches || dbMatches;

              if (tableMatches) {
                tableLi.style.display = "";
                schemaHasVisibleChild = true;
              } else {
                tableLi.style.display = "none";
              }
            });

            if (schemaHasVisibleChild || schemaMatches) {
              schemaLi.style.display = "";
              schemaDetails.open = true;
              sysGroupHasVisibleChild = true;
            } else {
              schemaLi.style.display = "none";
            }
          });

          if (sysGroupHasVisibleChild) {
            sysGroupLi.style.display = "";
            sysGroupDetails.open = true;
            dbHasVisibleChild = true;
          } else {
            sysGroupLi.style.display = "none";
          }
        }
      }

      if (dbHasVisibleChild || dbMatches) {
        dbLi.style.display = "";
        dbDetails.open = true;
      } else {
        dbLi.style.display = "none";
      }
    });
  }

  input.addEventListener("input", (e) => {
    filterTree(e.target.value);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      input.value = "";
      filterTree("");
      input.blur();
    }
  });

  if (clear) {
    clear.addEventListener("click", () => {
      input.value = "";
      filterTree("");
      input.focus();
    });
  }
}
