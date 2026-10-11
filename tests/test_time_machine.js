import "./setup.js";
import fs from "fs";
import path from "path";
import vm from "vm";
import {
  parseTableDate,
  formatCardDate,
  applyStaleAnalysis,
  toggleStaleMode,
  openStaleModal,
  closeStaleModal,
} from "../src/lineage/tableLineageStale.js";

// Load catalogData
const catalogPath = path.resolve("dist/static/catalog.js");
const catalogJs = fs.readFileSync(catalogPath, "utf8");
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(catalogJs, sandbox);
global.window = sandbox.window;
global.window.catalogData = sandbox.window.catalogData;

console.log("\n======================================================");
console.log("ТЕСТИРОВАНИЕ TIME MACHINE / STALE DETECTION");
console.log("======================================================");

// 1. Тест парсинга дат
const dt1 = parseTableDate("12.08.2026 00:05:26");
const dt2 = parseTableDate("09.06.2026 21:26:39");
if (!dt1 || !dt2) throw new Error("Ошибка парсинга дат");
if (dt1 <= dt2) throw new Error("12.08.2026 должно быть больше 09.06.2026");
console.log("✓ Тест парсинга дат пройден:", dt1 > dt2);

// 2. Тест форматирования дат
const fmt1 = formatCardDate("12.08.2026 00:05:26");
if (fmt1 !== "12.08.2026 00:05") throw new Error(`Неверный формат: ${fmt1}`);
console.log("✓ Тест форматирования дат пройден:", fmt1);

// 3. Тест выявления Stale на dds.core.account_detail
const unique_id = "dds-core-account_detail";
const mockChildren = [];
const mockCanvas = {
  id: `canvas-${unique_id}`,
  classList: {
    add: () => {},
    remove: () => {},
    contains: () => false,
  },
  closest: () => ({ classList: { contains: () => false } }),
  querySelectorAll: (selector) => {
    if (selector.includes(".ln-node:not(.ln-virtual)")) {
      // Имитируем узлы графа account_detail
      const nodeIds = [
        "ods.core.crm_client",
        "ods.core.abs_account",
        "ods.core.abs_contract",
        "dds.core.account_detail",
        "dm.core.account_balance_dynamics",
        "dds.sandbox_1.test1",
        "dm.core.account_activity",
        "dm.core.account_card_overview",
        "dm.core.unified_client_directory",
        "dm.core.client_revenue_potential",
      ];
      return nodeIds.map((id) => {
        const el = {
          dataset: { nodeId: id },
          classList: {
            add: (cls) => el.classes.add(cls),
            remove: (cls) => el.classes.delete(cls),
            contains: (cls) => el.classes.has(cls),
          },
          classes: new Set(),
          appendChild: (child) => el.children.push(child),
          querySelector: (sel) => el.children.find((c) => c.className === sel.replace(".", "")) || null,
          children: [],
        };
        return el;
      });
    }
    return [];
  },
  querySelector: (selector) => {
    if (selector === ".lineage-svg") {
      return {
        querySelectorAll: () => [],
      };
    }
    return null;
  },
  appendChild: (el) => mockChildren.push(el),
};

global.document = {
  getElementById: (id) => (id === `canvas-${unique_id}` ? mockCanvas : null),
  createElement: (tag) => {
    const el = {
      tagName: tag.toUpperCase(),
      className: "",
      innerHTML: "",
      dataset: {},
      classList: {
        add: (c) => el.classes.add(c),
        remove: (c) => el.classes.delete(c),
        contains: (c) => el.classes.has(c),
      },
      classes: new Set(),
      children: [],
      appendChild: (c) => el.children.push(c),
    };
    return el;
  },
  removeEventListener: () => {},
  addEventListener: () => {},
};

// Запуск toggleStaleMode
toggleStaleMode(unique_id, true);

// Проверяем, что счетчик смонтирован
const counterEl = mockChildren.find((el) => el.className === "ln-stale-counter");
const legendEl = mockChildren.find((el) => el.className === "ln-stale-legend");

if (!counterEl) throw new Error("Счетчик ln-stale-counter не создан!");
if (!legendEl) throw new Error("Легенда ln-stale-legend не создана!");

console.log("✓ Счетчик и легенда успешно смонтированы");

// Проверяем вызов попапа по ПКМ
openStaleModal({}, "dm.core.account_activity", unique_id);
const popupEl = mockChildren.find((el) => el.className === "ln-stale-popup");
if (!popupEl) throw new Error("Попап ln-stale-popup не создан!");

if (!popupEl.innerHTML.includes("Запустить пересчёт")) {
  throw new Error("В попапе нет кнопки 'Запустить пересчёт'!");
}
if (!popupEl.innerHTML.includes("account_detail")) {
  throw new Error("В попапе нет родительской таблицы account_detail!");
}

console.log("✓ Попап Stale успешно создан и содержит все необходимые блоки");
console.log("\n======================================================");
console.log("✓ ВСЕ ТЕСТЫ TIME MACHINE УСПЕШНО ПРОЙДЕНЫ!");
console.log("======================================================");
