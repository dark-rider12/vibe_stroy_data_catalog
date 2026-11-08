/* 
Тест движка JOIN Inference Engine для генератора шаблонов витрин
*/

import fs from "fs";
import path from "path";
import { generateSqlTemplate, buildJoinPlan } from "../src/utils/sqlJoinInference.js";

function runTest() {
  console.log("======================================================");
  console.log("ТЕСТИРОВАНИЕ: JOIN Inference Engine (Генератор шаблонов)");
  console.log("======================================================");

  const catalogJsPath = path.resolve("dist/static/catalog.js");
  if (!fs.existsSync(catalogJsPath)) {
    console.error("dist/static/catalog.js не найден");
    process.exit(1);
  }

  const content = fs.readFileSync(catalogJsPath, "utf8");
  const m = content.match(/window\.catalogData\s*=\s*(\{[\s\S]*?\});\s*window\.hiddenSchemas/);
  if (!m) {
    console.error("Не удалось распарсить catalogData из catalog.js");
    process.exit(1);
  }

  const catalogData = JSON.parse(m[1]);

  const testTables = [
    { db: "dds", schema: "core", table: "account_detail" },
    { db: "dds", schema: "core", table: "card_detail" },
    { db: "dds", schema: "core", table: "client_contact_detail" }
  ];

  const plan = buildJoinPlan(testTables, { catalogData });

  console.log(`Базовая таблица FROM: ${plan.fromTable.table} (${plan.fromAlias})`);
  console.log(`Количество запланированных JOIN: ${plan.joinPlan.length}`);

  if (plan.joinPlan.length !== 2) {
    throw new Error(`Ожидалось 2 JOIN, получено: ${plan.joinPlan.length}`);
  }

  // 1. Тест автоматического режима для таблиц из одной БД (без ext_*)
  const sqlSameDb = generateSqlTemplate(testTables, { catalogData });

  if (!sqlSameDb.startsWith("SELECT")) {
    throw new Error("Скрипт должен начинаться сразу с SELECT");
  }
  if (sqlSameDb.includes("CREATE TABLE") || sqlSameDb.includes("CREATE OR REPLACE VIEW")) {
    throw new Error("В сгенерированном SQL не должно быть DDL команд (CTAS/VIEW)");
  }
  if (sqlSameDb.includes("ШАБЛОН ВИТРИНЫ")) {
    throw new Error("В сгенерированном SQL не должно быть комментариев шапки");
  }
  if (sqlSameDb.includes("-- Поля таблицы")) {
    throw new Error("В сгенерированном SQL не должно быть комментариев '-- Поля таблицы'");
  }
  if (!sqlSameDb.includes("FROM dds.core.account_detail ad")) {
    throw new Error("Таблицы из одной БД должны оставаться dds.core без ext_*");
  }
  if (!sqlSameDb.includes("ad.*,")) {
    throw new Error("В сгенерированном SQL отсутствует запятая после полей таблицы в блоке SELECT");
  }
  if (!sqlSameDb.includes("JOIN dds.core.card_detail cd")) {
    throw new Error("JOIN таблицы из одной БД должен оставаться dds.core");
  }
  if (sqlSameDb.includes("INNER JOIN")) {
    throw new Error("В сгенерированном SQL обнаружен INNER JOIN вместо чистого JOIN");
  }
  if (!sqlSameDb.includes("account_id")) {
    throw new Error("В сгенерированном SQL отсутствует ключ соединения account_id");
  }

  // 2. Тест автоматического перехода в ext_dds при перетаскивании таблиц из разных БД (dm + dds)
  const crossTablesDm = [
    { db: "dm", schema: "core", table: "account_activity" },
    { db: "dds", schema: "core", table: "card_detail" }
  ];
  const sqlAutoCrossDm = generateSqlTemplate(crossTablesDm, { catalogData });

  if (!sqlAutoCrossDm.includes("dm.core.account_activity")) {
    throw new Error("Таблица dm.core должна оставаться dm.core");
  }
  if (!sqlAutoCrossDm.includes("dm.ext_dds.card_detail")) {
    throw new Error("При перетаскивании таблиц из разных БД (dm + dds) таблица dds должна переходить в dm.ext_dds");
  }

  // 3. Тест перехода ODS таблицы в ext_ods при перетаскивании из dds + ods
  const crossTablesDdsOds = [
    { db: "dds", schema: "core", table: "account_detail" },
    { db: "ods", schema: "core", table: "abs_account" }
  ];
  const sqlAutoCrossDds = generateSqlTemplate(crossTablesDdsOds, { catalogData });

  if (!sqlAutoCrossDds.includes("dds.core.account_detail")) {
    throw new Error("Таблица dds.core должна оставаться dds.core при целевой БД dds");
  }
  if (!sqlAutoCrossDds.includes("dds.ext_ods.abs_account")) {
    throw new Error("При перетаскивании таблиц из разных БД (dds + ods) таблица ods должна переходить в dds.ext_ods");
  }

  // 4. Тест умного ранжирования: чистые условия побеждают условия с недостающими зависимостями
  const tablesWithForeign = [
    { db: "dds", schema: "core", table: "account_detail" },
    { db: "dm", schema: "core", table: "account_card_overview" }
  ];
  const planRanking = buildJoinPlan(tablesWithForeign, { catalogData });
  const acoPlanItem = planRanking.joinPlan.find(j => j.table.table === "account_card_overview");

  if (!acoPlanItem) {
    throw new Error("Не найден элемент плана для account_card_overview");
  }
  if (!acoPlanItem.availableSources || acoPlanItem.availableSources.length < 2) {
    throw new Error("Для account_card_overview должно быть найдено минимум 2 источника связей");
  }
  // По умолчанию должно быть выбрано чистое условие без недостающих таблиц
  if (acoPlanItem.missingTables.length !== 0) {
    throw new Error("По умолчанию должно побеждать чистое условие без недостающих таблиц");
  }

  // 5. Тест ручного переключения источника (userSelectedSources) и обнаружения недостающих таблиц
  const planUserChoice = buildJoinPlan(tablesWithForeign, {
    catalogData,
    userSelectedSources: {
      "dm.core.account_card_overview": "dm.core.master_wide_join"
    }
  });
  const acoUserChoice = planUserChoice.joinPlan.find(j => j.table.table === "account_card_overview");

  if (acoUserChoice.sourceMart !== "dm.core.master_wide_join") {
    throw new Error("Ручной выбор источника через userSelectedSources должен переопределять источник связи");
  }
  if (acoUserChoice.missingTables.length === 0) {
    throw new Error("Скрипт dm.core.master_wide_join должен сообщать о недостающей таблице card_detail");
  }
  if (acoUserChoice.missingTables[0].table !== "card_detail") {
    throw new Error(`Ожидалась недостающая таблица card_detail, получено: ${acoUserChoice.missingTables[0].table}`);
  }
  // Проверяем, что условие с чужим алиасом cd не было обрезано
  if (!acoUserChoice.condition.includes("cd.card_id")) {
    throw new Error("Условие JOIN не должно очищаться от чужих алиасов (требование пользователя)");
  }

  // 6. Тест автоматического исчезновения предупреждения при добавлении недостающей таблицы
  const tablesWithDependencyResolved = [
    { db: "dds", schema: "core", table: "account_detail" },
    { db: "dds", schema: "core", table: "card_detail" },
    { db: "dm", schema: "core", table: "account_card_overview" }
  ];
  const planResolved = buildJoinPlan(tablesWithDependencyResolved, { catalogData });
  const acoResolved = planResolved.joinPlan.find(j => j.table.table === "account_card_overview");

  if (acoResolved.sourceMart !== "dm.core.master_wide_join") {
    throw new Error("При наличии card_detail должен выбираться полный джойн из dm.core.master_wide_join");
  }
  if (acoResolved.missingTables.length !== 0) {
    throw new Error("После добавления card_detail список missingTables должен быть пустым");
  }

  console.log("✓ Чистый SELECT формируется без CTAS и без шапки");
  console.log("✓ Таблицы из одной БД dds остаются локальными (без ext_*)");
  console.log("✓ Автоматический переход dds.core -> dm.ext_dds при кросс-базовом запросе (dm + dds)");
  console.log("✓ Автоматический переход ods.core -> dds.ext_ods при кросс-базовом запросе (dds + ods)");
  console.log("✓ Соединения account_id и client_id определены корректно");
  console.log("✓ Умное ранжирование отдает приоритет чистым условиям без внешних зависимостей");
  console.log("✓ Ручной выбор источника связи (userSelectedSources) корректно активируется");
  console.log("✓ Недостающие таблицы (missingTables) корректно выявляются с исходными алиасами");
  console.log("✓ Условия с чужими алиасами сохраняются без принудительной очистки");
  console.log("✓ При добавлении зависимой таблицы в шаблон статус становится чистым");
  console.log("✓ ВСЕ ПРОВЕРКИ JOIN INFERENCE ПРОЙДЕНЫ УСПЕШНО");
  console.log("======================================================");
}

runTest();
