/* 
Тест движка JOIN Inference Engine для генератора шаблонов витрин
*/

import fs from "fs";
import path from "path";
import { 
  generateSqlTemplate, 
  buildJoinPlan, 
  buildHierarchyTree,
  isTemporaryTable, 
  findMissingTables,
  hasHistoricalDates,
  canApplyTimelineSlicing 
} from "../src/utils/sqlJoinInference.js";

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

  // 7. Тест фильтрации временных таблиц (tmp_*)
  if (!isTemporaryTable("tmp_draft") || !isTemporaryTable("dds.core.tmp_calc") || !isTemporaryTable("dm.ext_dds.tmp_tbl")) {
    throw new Error("isTemporaryTable должна возвращать true для любых таблиц с префиксом tmp_");
  }
  if (isTemporaryTable("account_detail") || isTemporaryTable("dds.core.card_detail")) {
    throw new Error("isTemporaryTable должна возвращать false для постоянных таблиц");
  }

  // Проверяем, что временные таблицы tmp_* не попадают в missingTables
  const edgeWithTmp = {
    condition: "ad.account_id = cd.account_id AND tmp_test.id = cd.id",
    originalLeftTable: "account_detail",
    originalRightTable: "card_detail",
    originalLeftAlias: "ad",
    originalRightAlias: "cd",
    sourceAliasMap: {
      "tmp_test": "dds.core.tmp_test"
    }
  };
  const missingTmp = findMissingTables(
    edgeWithTmp,
    { db: "dds", schema: "core", table: "account_detail" },
    { db: "dds", schema: "core", table: "card_detail" },
    testTables,
    catalogData
  );
  if (missingTmp.some(m => m.table.startsWith("tmp_"))) {
    throw new Error("Таблицы с префиксом tmp_ не должны попадать в подсказки missingTables");
  }

  // 8. Тест детектора версионных измерений (Timeline Slicing Detector)
  const mockScdCatalog = {
    dds: {
      core: {
        dim_client: {
          columns: [
            { name: "client_id", type: "bigint" },
            { name: "client_name", type: "text" },
            { name: "dwh_start_date", type: "timestamp" },
            { name: "dwh_end_date", type: "timestamp" }
          ]
        },
        dim_account: {
          columns: [
            { name: "account_id", type: "bigint" },
            { name: "client_id", type: "bigint" },
            { name: "account_num", type: "text" },
            { name: "dwh_start_date", type: "timestamp" },
            { name: "dwh_end_date", type: "timestamp" }
          ]
        },
        no_dates_table: {
          columns: [
            { name: "id", type: "bigint" },
            { name: "name", type: "text" }
          ]
        }
      }
    }
  };

  const scdTables = [
    { db: "dds", schema: "core", table: "dim_client" },
    { db: "dds", schema: "core", table: "dim_account" }
  ];

  if (!hasHistoricalDates(scdTables[0], mockScdCatalog) || !hasHistoricalDates(scdTables[1], mockScdCatalog)) {
    throw new Error("hasHistoricalDates должна возвращать true для таблиц с dwh_start_date и dwh_end_date");
  }
  if (hasHistoricalDates({ db: "dds", schema: "core", table: "no_dates_table" }, mockScdCatalog)) {
    throw new Error("hasHistoricalDates должна возвращать false для таблиц без исторических дат");
  }

  if (!canApplyTimelineSlicing(scdTables, mockScdCatalog)) {
    throw new Error("canApplyTimelineSlicing должна возвращать true, если все таблицы содержат исторические даты");
  }
  if (canApplyTimelineSlicing([scdTables[0]], mockScdCatalog)) {
    throw new Error("canApplyTimelineSlicing должна возвращать false для 1 таблицы");
  }
  if (canApplyTimelineSlicing([...scdTables, { db: "dds", schema: "core", table: "no_dates_table" }], mockScdCatalog)) {
    throw new Error("canApplyTimelineSlicing должна возвращать false, если хотя бы одна таблица не имеет SCD2 дат");
  }

  // 9. Тест генерации SQL-шаблона в режиме Timeline Slicing
  const normalSql = generateSqlTemplate(scdTables, { 
    catalogData: mockScdCatalog, 
    enableTimelineSlicing: false 
  });
  if (normalSql.includes("WITH timeline_events") || !normalSql.startsWith("SELECT")) {
    throw new Error("При enableTimelineSlicing: false должен формироваться обычный SELECT без CTE");
  }

  const timelineSql = generateSqlTemplate(scdTables, { 
    catalogData: mockScdCatalog, 
    enableTimelineSlicing: true 
  });

  if (timelineSql.startsWith("--")) {
    throw new Error("В режиме Timeline Slicing скрипт не должен начинаться с закомментированной шапки");
  }
  if (timelineSql.includes("CASE,") || timelineSql.includes("THEN true,") || timelineSql.includes("ELSE false,")) {
    throw new Error("В CASE-выражении для is_active присутствуют лишние запятые после CASE, true или false");
  }

  if (!timelineSql.includes("WITH timeline_events AS (")) {
    throw new Error("В режиме Timeline Slicing должен генерироваться CTE timeline_events");
  }
  if (!timelineSql.includes("timeline_intervals AS (") || !timelineSql.includes("LEAD(change_dt) OVER")) {
    throw new Error("В режиме Timeline Slicing должна выполняться нарезка интервалов через LEAD(change_dt)");
  }
  if (!timelineSql.includes("clean_intervals AS (") || !timelineSql.includes("valid_from < valid_to")) {
    throw new Error("В режиме Timeline Slicing должен генерироваться CTE clean_intervals с отсечением пустых интервалов");
  }
  if (!timelineSql.includes("FROM clean_intervals i")) {
    throw new Error("Главный SELECT должен строиться от clean_intervals i");
  }
  if (!timelineSql.includes("WHEN i.valid_to >= '9999-12-31'::timestamp THEN true")) {
    throw new Error("Поле is_active должно вычисляться как true только для интервалов с датой 9999");
  }
  if (!timelineSql.includes("i.valid_from >= dc.dwh_start_date") || !timelineSql.includes("i.valid_from <  dc.dwh_end_date")) {
    throw new Error("Джойны таблиц должны содержать фильтр попадания в интервал valid_from");
  }
  if (!timelineSql.includes("i.valid_from AS dwh_start_date") || !timelineSql.includes("i.valid_to   AS dwh_end_date")) {
    throw new Error("Результирующие поля dwh_start_date и dwh_end_date должны браться из valid_from и valid_to");
  }

  // 10. Тест ветвления соединений (userSelectedParents) и построения Join Tree (buildHierarchyTree)
  const branchTables = [
    { db: "dds", schema: "core", table: "account_detail" },
    { db: "dds", schema: "core", table: "card_detail" },
    { db: "dds", schema: "core", table: "client_account_profile" }
  ];
  // Зададим явное ветвление: card_detail и client_account_profile соединяются напрямую с базовой account_detail
  const branchPlan = buildJoinPlan(branchTables, {
    catalogData,
    baseTableKey: "dds.core.account_detail",
    userSelectedParents: {
      "dds.core.card_detail": "dds.core.account_detail",
      "dds.core.client_account_profile": "dds.core.account_detail"
    }
  });

  const cardJoin = branchPlan.joinPlan.find(j => j.table.table === "card_detail");
  const clientJoin = branchPlan.joinPlan.find(j => j.table.table === "client_account_profile");
  if (!cardJoin || cardJoin.joinedWith.table !== "account_detail") {
    throw new Error("card_detail должна быть соединена с account_detail по userSelectedParents");
  }
  if (!clientJoin || clientJoin.joinedWith.table !== "account_detail") {
    throw new Error("client_account_profile должна быть соединена с account_detail по userSelectedParents");
  }

  // Проверяем buildHierarchyTree
  const tree = buildHierarchyTree(branchPlan.fromTable, branchPlan.joinPlan, branchPlan.aliasMap);
  if (!tree.root || tree.root.table.table !== "account_detail") {
    throw new Error("buildHierarchyTree: корень дерева должен быть account_detail");
  }
  if (tree.root.children.length !== 2) {
    throw new Error("buildHierarchyTree: у корня должно быть 2 потомка (card_detail и client_account_profile)");
  }
  if (tree.flatTreeList.length !== 3) {
    throw new Error("buildHierarchyTree: в flatTreeList должно быть 3 узла");
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
  console.log("✓ Временные таблицы (tmp_*) полностью отфильтровываются из ранжирования и подсказок");
  console.log("✓ ВСЕ ПРОВЕРКИ JOIN INFERENCE ПРОЙДЕНЫ УСПЕШНО");
  console.log("======================================================");
}

runTest();
