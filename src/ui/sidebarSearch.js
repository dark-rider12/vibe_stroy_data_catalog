/* 
MODULE: src/ui/sidebarSearch.js
ROLE: Поиск и фильтрация объектов в боковой панели (в стиле DBeaver).
      - Фильтрует дерево #tree в реальном времени по имени таблиц/вью/схем/БД
      - Выпадающий список подходящих вариантов (Autocomplete Dropdown) при наборе текста
      - Поддерживает названия в псевдоэлементах .tree-title[data-title] (изолированных от Ctrl+F)
      - Навигация стрелками клавиатуры (ArrowUp, ArrowDown, Enter)
      - Поддержка Drag & Drop вариантов напрямую в Конструктор витрин
      - Автоматически раскрывает родительские узлы (схемы, БД), содержащие совпадения
      - Скрывает несовпадающие ветки
      - Восстанавливает исходное состояние дерева при очистке
      - Поддерживает кнопку очистки [X] и клавишу Escape
*/

let originalDetailsState = new WeakMap();
let hasSavedState = false;
let cachedTreeObjects = null;

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

/**
 * Извлекает все объекты (таблицы, вью) из дерева для быстрого поиска вариантов.
 */
function getTreeObjects(tree) {
  if (cachedTreeObjects) return cachedTreeObjects;
  const links = tree.querySelectorAll("a[href^='#']");
  const objects = [];

  links.forEach((a) => {
    const href = a.getAttribute("href") || "";
    if (href === "#home") return;

    const hash = href.startsWith("#") ? href.substring(1) : href;
    const parts = hash.split("-");
    if (parts.length >= 3) {
      const db = parts[0];
      const schema = parts[1];
      const table = parts.slice(2).join("-");
      const name = getNodeText(a).trim() || table;
      const isView = !!a.querySelector(".ic-view");

      objects.push({
        db,
        schema,
        table,
        name,
        href,
        isView,
        element: a
      });
    }
  });

  cachedTreeObjects = objects;
  return objects;
}

export function initSidebarSearch() {
  const tree = document.getElementById("tree");
  if (!tree) return;

  const input = document.getElementById("sidebar-search-input");
  const clear = document.getElementById("sidebar-search-clear");
  let dropdown = document.getElementById("sidebar-search-dropdown");

  if (!input) return;

  // Если контейнер дропдауна не был в HTML, создаем его динамически
  if (!dropdown) {
    const wrapper = input.closest(".sidebar-search-wrapper");
    if (wrapper) {
      dropdown = document.createElement("div");
      dropdown.id = "sidebar-search-dropdown";
      dropdown.className = "sidebar-search-dropdown";
      dropdown.style.display = "none";
      wrapper.appendChild(dropdown);
    }
  }

  let activeIndex = -1;
  let currentMatches = [];

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

  function closeDropdown() {
    if (dropdown) {
      dropdown.style.display = "none";
      dropdown.innerHTML = "";
    }
    activeIndex = -1;
    currentMatches = [];
  }

  function renderDropdown(query) {
    if (!dropdown) return;
    const q = query.trim().toLowerCase();
    if (!q) {
      closeDropdown();
      return;
    }

    const objects = getTreeObjects(tree);
    const matches = [];

    // Ранжирование: сначала начинающиеся с запроса, затем содержащие в имени, затем по схеме
    objects.forEach((obj) => {
      const nameLower = obj.name.toLowerCase();
      const schemaLower = obj.schema.toLowerCase();
      const dbLower = obj.db.toLowerCase();

      let rank = -1;
      if (nameLower === q) {
        rank = 0;
      } else if (nameLower.startsWith(q)) {
        rank = 1;
      } else if (nameLower.includes(q)) {
        rank = 2;
      } else if (schemaLower.includes(q) || dbLower.includes(q)) {
        rank = 3;
      }

      if (rank !== -1) {
        matches.push({ ...obj, rank });
      }
    });

    matches.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.name.localeCompare(b.name);
    });

    currentMatches = matches.slice(0, 10);
    activeIndex = -1;

    if (currentMatches.length === 0) {
      dropdown.innerHTML = `
        <div class="sidebar-dropdown-empty">
          <span>Подходящих вариантов не найдено</span>
        </div>
      `;
      dropdown.style.display = "block";
      return;
    }

    let html = "";
    currentMatches.forEach((item, idx) => {
      const iconClass = item.isView ? "ic-view" : "ic-tbl";
      html += `
        <div class="sidebar-dropdown-item" 
             data-index="${idx}" 
             data-href="${item.href}" 
             data-db="${item.db}" 
             data-schema="${item.schema}" 
             data-table="${item.table}" 
             draggable="true" 
             title="Перейти к ${item.name} (или перетащите в Генератор шаблонов)">
          <i class="icon ${iconClass}"></i>
          <span class="tree-title" data-title="${escapeHtml(item.name)}"></span>
          <span class="sidebar-dropdown-meta">${item.db}.${item.schema}</span>
        </div>
      `;
    });

    dropdown.innerHTML = html;
    dropdown.style.display = "block";

    // Навешиваем клик и dragstart на элементы
    const itemEls = dropdown.querySelectorAll(".sidebar-dropdown-item");
    itemEls.forEach((el) => {
      el.addEventListener("click", () => {
        const href = el.dataset.href;
        selectAndNavigate(href);
      });

      // Поддержка Drag & Drop из выпадающего списка в Конструктор витрин
      el.addEventListener("dragstart", (e) => {
        const payload = JSON.stringify({
          db: el.dataset.db,
          schema: el.dataset.schema,
          table: el.dataset.table
        });
        e.dataTransfer.setData("application/json", payload);
        e.dataTransfer.setData("text/plain", `${el.dataset.db}.${el.dataset.schema}.${el.dataset.table}`);
        e.dataTransfer.effectAllowed = "copy";
        el.classList.add("tb-is-dragging");
        document.body.classList.add("tb-dragging-active");

        const edgeDropzone = document.getElementById("tb-edge-dropzone");
        const sidebarEl = document.getElementById("sidebar");
        if (edgeDropzone) {
          if (sidebarEl) {
            const rect = sidebarEl.getBoundingClientRect();
            edgeDropzone.style.left = `${Math.max(0, rect.right)}px`;
          }
          edgeDropzone.classList.add("tb-edge-active");
        }
      });

      el.addEventListener("dragend", () => {
        el.classList.remove("tb-is-dragging");
        document.body.classList.remove("tb-dragging-active");
        const edgeDropzone = document.getElementById("tb-edge-dropzone");
        if (edgeDropzone) {
          edgeDropzone.classList.remove("tb-edge-active", "tb-drag-hover");
          edgeDropzone.style.left = "";
        }
      });
    });
  }

  function selectAndNavigate(href) {
    if (!href) return;
    window.location.hash = href;
    closeDropdown();

    // Находим ссылку в дереве и скроллим к ней
    const targetLink = tree.querySelector(`a[href="${href}"]`);
    if (targetLink) {
      // Раскрываем всех предков
      let parent = targetLink.parentElement;
      while (parent && parent !== tree) {
        if (parent.tagName === "DETAILS") {
          parent.open = true;
        }
        parent = parent.parentElement;
      }
      targetLink.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function updateActiveItem() {
    if (!dropdown) return;
    const items = dropdown.querySelectorAll(".sidebar-dropdown-item");
    items.forEach((el, idx) => {
      if (idx === activeIndex) {
        el.classList.add("active");
        el.scrollIntoView({ block: "nearest" });
      } else {
        el.classList.remove("active");
      }
    });
  }

  function filterTree(query) {
    const q = query.trim().toLowerCase();

    if (clear) {
      clear.style.display = q ? "flex" : "none";
    }

    if (!q) {
      restoreState();
      closeDropdown();
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

    // Отрисовываем выпадающий список подсказок
    renderDropdown(query);
  }

  // Обработчик ввода текста
  input.addEventListener("input", (e) => {
    filterTree(e.target.value);
  });

  // Открытие при фокусе, если уже есть текст
  input.addEventListener("focus", () => {
    if (input.value.trim().length > 0) {
      renderDropdown(input.value);
    }
  });

  // Клавиатурная навигация
  input.addEventListener("keydown", (e) => {
    if (dropdown && dropdown.style.display !== "none" && currentMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        activeIndex = (activeIndex + 1) % currentMatches.length;
        updateActiveItem();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        activeIndex = (activeIndex - 1 + currentMatches.length) % currentMatches.length;
        updateActiveItem();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (activeIndex >= 0 && activeIndex < currentMatches.length) {
          selectAndNavigate(currentMatches[activeIndex].href);
        } else if (currentMatches.length > 0) {
          selectAndNavigate(currentMatches[0].href);
        }
        return;
      }
    }

    if (e.key === "Escape") {
      closeDropdown();
      input.value = "";
      filterTree("");
      input.blur();
    }
  });

  // Закрытие при клике вне области поиска
  document.addEventListener("click", (e) => {
    const stickyBox = input.closest(".sidebar-search-sticky");
    if (stickyBox && !stickyBox.contains(e.target)) {
      closeDropdown();
    }
  });

  if (clear) {
    clear.addEventListener("click", () => {
      input.value = "";
      filterTree("");
      closeDropdown();
      input.focus();
    });
  }
}

function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
