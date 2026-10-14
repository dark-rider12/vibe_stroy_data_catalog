/* 
Тест логики обфускации и деобфускации для PostgreSQL и MS SQL.
Запуск: node tests/test_sql_obfuscator.js
*/

import assert from 'node:assert';
import {
  obfuscatePromptAndSql,
  deobfuscateText,
  extractDwhTerms,
  extractSqlTerms
} from '../src/utils/sqlObfuscator.js';

console.log('--- Тест 1: Пример пользователя (PostgreSQL + банковские сущности) ---');
{
  const mockCatalog = {
    dwh: {
      dds: {
        fct_credit_deals: {
          columns: [{ name: 'deal_rk' }, { name: 'client_id' }, { name: 'branch_rk' }, { name: 'deal_status' }]
        }
      },
      core: {
        dict_branch: {
          columns: [{ name: 'branch_rk' }, { name: 'branch_name' }]
        }
      }
    }
  };

  const prompt = 'В таблице dds.fct_credit_deals задваиваются записи по полю deal_rk при джойне с dict_branch. Перепиши через оконную функцию';
  const sql = `
    SELECT d.deal_rk, d.client_id, b.branch_name,
           row_number() OVER (PARTITION BY d.deal_rk ORDER BY d.client_id) as rn
    FROM dds.fct_credit_deals d
    JOIN core.dict_branch b ON d.branch_rk = b.branch_rk
    WHERE d.deal_status = 'ACTIVE' AND d.deal_status ILIKE 'ACT%'
  `;

  const result = obfuscatePromptAndSql({
    prompt,
    sql,
    dialect: 'postgres',
    catalogData: mockCatalog,
    maskStrings: true
  });

  console.log('Обезличенный промпт:');
  console.log(result.obfuscatedPrompt);
  console.log('Обезличенный SQL:');
  console.log(result.obfuscatedSql);

  // Проверяем, что реальных названий нет в обезличенном результате
  assert(!result.obfuscatedPrompt.includes('fct_credit_deals'), 'fct_credit_deals должно быть скрыто');
  assert(!result.obfuscatedPrompt.includes('deal_rk'), 'deal_rk должно быть скрыто');
  assert(!result.obfuscatedPrompt.includes('dict_branch'), 'dict_branch должно быть скрыто');
  assert(!result.obfuscatedSql.includes('fct_credit_deals'), 'fct_credit_deals в SQL должно быть скрыто');
  assert(!result.obfuscatedSql.includes('ACTIVE'), 'ACTIVE должно быть заменено на токен STR_');

  // Ключевые слова PostgreSQL не должны пострадать
  assert(result.obfuscatedSql.includes('SELECT'), 'SELECT должно сохраниться');
  assert(result.obfuscatedSql.includes('OVER'), 'OVER должно сохраниться');
  assert(result.obfuscatedSql.includes('PARTITION BY'), 'PARTITION BY должно сохраниться');
  assert(result.obfuscatedSql.includes('ILIKE'), 'ILIKE должно сохраниться');

  // Тестируем деобфускацию
  const restoredPrompt = deobfuscateText(result.obfuscatedPrompt, result.mapping);
  const restoredSql = deobfuscateText(result.obfuscatedSql, result.mapping);

  console.log('Восстановленный промпт:');
  console.log(restoredPrompt);

  assert(restoredPrompt.toLowerCase().includes('fct_credit_deals'), 'Восстановлен fct_credit_deals');
  assert(restoredPrompt.toLowerCase().includes('deal_rk'), 'Восстановлен deal_rk');
  assert(restoredPrompt.toLowerCase().includes('dict_branch'), 'Восстановлен dict_branch');
  assert(restoredSql.includes("'ACTIVE'"), "Строка 'ACTIVE' должна восстановиться");
  console.log('✓ Тест 1 пройден успешно!');
}

console.log('\n--- Тест 2: Диалект MS SQL (скобки, переменные @, временные таблицы #, хинты) ---');
{
  const prompt = 'Оптимизируй запрос к [dds].[fct_credit_deals] с фильтром по @client_id и временной таблицей #temp_deals';
  const sql = `
    SELECT TOP 100 d.[deal_rk], d.[loan_amount], ISNULL(d.[is_active], 0) AS [status_flag]
    INTO #temp_deals
    FROM [dds].[fct_credit_deals] d WITH (NOLOCK)
    CROSS APPLY (SELECT GETDATE() AS curr_dt) ca
    WHERE d.[client_id] = @client_id AND d.[loan_amount] > 1000 AND d.[branch_name] = N'Центральный'
  `;

  const result = obfuscatePromptAndSql({
    prompt,
    sql,
    dialect: 'mssql',
    maskStrings: true
  });

  console.log('MS SQL Обезличенный промпт:');
  console.log(result.obfuscatedPrompt);
  console.log('MS SQL Обезличенный SQL:');
  console.log(result.obfuscatedSql);

  // Ключевые слова MS SQL должны сохраниться
  assert(result.obfuscatedSql.includes('TOP 100'), 'TOP 100 сохранено');
  assert(result.obfuscatedSql.includes('WITH (NOLOCK)'), 'WITH (NOLOCK) сохранено');
  assert(result.obfuscatedSql.includes('CROSS APPLY'), 'CROSS APPLY сохранено');
  assert(result.obfuscatedSql.includes('ISNULL'), 'ISNULL сохранено');
  assert(result.obfuscatedSql.includes('GETDATE()'), 'GETDATE() сохранено');

  // Переменные и таблицы заменены
  assert(!result.obfuscatedSql.includes('fct_credit_deals'), 'Таблица заменена');
  assert(!result.obfuscatedSql.includes('loan_amount'), 'Колонка заменена');
  assert(!result.obfuscatedSql.includes('Центральный'), 'Юникод-строка N заменена');

  // Деобфускация
  const restoredSql = deobfuscateText(result.obfuscatedSql, result.mapping);
  assert(restoredSql.includes('fct_credit_deals'), 'Восстановлен fct_credit_deals');
  assert(restoredSql.includes('loan_amount'), 'Восстановлен loan_amount');
  assert(restoredSql.includes('client_id'), 'Восстановлен client_id');
  console.log('✓ Тест 2 пройден успешно!');
}

console.log('\n--- Тест 3: Сохранение дат, времени и ключевого слова current_date ---');
{
  const prompt = 'Выбери сделки по таблице dds.fct_deals за 2024-01-01, где deal_date = current_date';
  const sql = `
    SELECT d.deal_rk, d.deal_date, d.created_at
    FROM dds.fct_deals d
    WHERE d.deal_date >= '2024-01-01'
      AND d.deal_date <= '31.12.2024'
      AND d.created_at = '2024-06-15 14:30:00'
      AND d.deal_date = current_date
      AND d.deal_date >= current_date - INTERVAL '7 days'
      AND d.branch_code = 'BRANCH_MOSCOW'
  `;

  const result = obfuscatePromptAndSql({
    prompt,
    sql,
    dialect: 'postgres',
    maskStrings: true
  });

  console.log('Обезличенный промпт:');
  console.log(result.obfuscatedPrompt);
  console.log('Обезличенный SQL:');
  console.log(result.obfuscatedSql);

  // 1. current_date НЕ должно быть заменено
  assert(result.obfuscatedSql.includes('current_date'), 'current_date должно остаться неизменным в SQL');
  assert(result.obfuscatedPrompt.includes('current_date'), 'current_date должно остаться неизменным в промпте');
  assert(!result.obfuscatedSql.includes('OBJ_') || result.obfuscatedSql.includes('current_date'), 'current_date не является OBJ_');

  // 2. Даты и дату/время НЕ искажать
  assert(result.obfuscatedSql.includes("'2024-01-01'"), "'2024-01-01' должна остаться неизменной");
  assert(result.obfuscatedSql.includes("'31.12.2024'"), "'31.12.2024' должна остаться неизменной");
  assert(result.obfuscatedSql.includes("'2024-06-15 14:30:00'"), "'2024-06-15 14:30:00' должна остаться неизменной");
  assert(result.obfuscatedSql.includes("'7 days'"), "'7 days' интервал должен остаться неизменным");

  // 3. Банковские названия и текстовые константы (не даты) должны быть обезличены
  assert(!result.obfuscatedSql.includes('fct_deals'), 'fct_deals должно быть скрыто');
  assert(!result.obfuscatedSql.includes('BRANCH_MOSCOW'), 'BRANCH_MOSCOW должно быть скрыто токеном STR_');

  // 4. Деобфускация
  const restoredSql = deobfuscateText(result.obfuscatedSql, result.mapping);
  assert(restoredSql.includes('fct_deals'), 'Восстановлен fct_deals');
  assert(restoredSql.includes("'BRANCH_MOSCOW'"), "Восстановлена строка 'BRANCH_MOSCOW'");
  assert(restoredSql.includes('current_date'), 'current_date сохранен');
  console.log('✓ Тест 3 пройден успешно!');
}

console.log('\n--- Все тесты обфускатора успешно пройдены! ---');

