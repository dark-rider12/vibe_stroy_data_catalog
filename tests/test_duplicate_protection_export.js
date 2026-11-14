import assert from 'assert';
import fs from 'fs';

// Load catalogData from dist/static/catalog.js
const catalogJs = fs.readFileSync('dist/static/catalog.js', 'utf8');
const firstLine = catalogJs.split('\n')[0].trim().replace(/;$/, '');
const prefix = 'window.catalogData = ';
const catalogData = JSON.parse(firstLine.slice(prefix.length));

function formatPrimaryKey(tableInfo, dbName, schemaName, tableName) {
  if (!tableInfo) return '-';
  const objectType = tableInfo.type;
  if (objectType === 'v' || objectType === 'm') return '-';

  const pkData = tableInfo.primary_key;
  const dqInfo = tableInfo.dq_info?.duplicate_protection;
  const uCons = tableInfo.unique_constraints;
  const hasPk = pkData && pkData.columns && pkData.columns.length > 0;
  const hasDqProtection = dqInfo && dqInfo.has_unique_index && dqInfo.has_unique_constraint;
  const hasUCons = uCons && uCons.length > 0;

  if (hasPk && hasDqProtection) {
    return 'Лишний primary_key - нужно исправить!!!';
  } else if (hasDqProtection) {
    const colsStr = dqInfo.cols_str || (dqInfo.key_columns && dqInfo.key_columns.join(', ')) || dqInfo.first_col_name || '';
    const idxName = dqInfo.index_name || `${tableName}_idx`;
    const conName = dqInfo.constraint_name || `${tableName}_unique_version`;
    return `CREATE UNIQUE INDEX ${idxName}
ON ${dbName}.${schemaName}.${tableName} (${colsStr})
WHERE is_active = true;

ALTER TABLE ${dbName}.${schemaName}.${tableName}
ADD CONSTRAINT ${conName}
UNIQUE (${colsStr}, dwh_start_date);`;
  } else if (dbName.toLowerCase() === 'dm' && hasUCons) {
    return uCons.map(u => {
      const cols = (u.columns || []).join(', ');
      return `ALTER TABLE ${dbName}.${schemaName}.${tableName}\n\tADD CONSTRAINT ${u.constraint_name} UNIQUE (${cols});`;
    }).join('\n\n');
  } else if (hasPk) {
    return pkData.columns.join(', ');
  } else {
    return 'нет primary key';
  }
}

function getPrimaryKeyForTable(dbName, schemaName, tableName) {
  return formatPrimaryKey(catalogData[dbName]?.[schemaName]?.[tableName], dbName, schemaName, tableName);
}

console.log('======================================================');
console.log('ТЕСТИРОВАНИЕ: Duplicate Protection & Export {primary_key}');
console.log('======================================================');

// 1. Check card_detail (2 columns protection: card_id, account_id)
const cdPk = getPrimaryKeyForTable('dds', 'core', 'card_detail');
console.log('card_detail {primary_key}:\n' + cdPk);
assert(cdPk.includes('CREATE UNIQUE INDEX card_detail_idx'), 'should include card_detail_idx');
assert(cdPk.includes('(card_id, account_id)'), 'card_detail index should contain (card_id, account_id)');
assert(cdPk.includes('ADD CONSTRAINT card_detail_unique_version'), 'should include card_detail_unique_version');
assert(cdPk.includes('UNIQUE (card_id, account_id, dwh_start_date);'), 'card_detail constraint should contain (card_id, account_id, dwh_start_date)');
console.log('✓ card_detail: 2-полевая защита от дублей корректно формирует DDL');

// 2. Check account_detail (1 column protection: account_id)
const adPk = getPrimaryKeyForTable('dds', 'core', 'account_detail');
console.log('\naccount_detail {primary_key}:\n' + adPk);
assert(cdPk !== adPk, 'account_detail and card_detail should differ');
assert(adPk.includes('(account_id)'), 'account_detail index should contain (account_id)');
assert(adPk.includes('UNIQUE (account_id, dwh_start_date);'), 'account_detail constraint should contain (account_id, dwh_start_date)');
console.log('✓ account_detail: 1-полевая защита от дублей сохранена');

// 3. Check custom-named index and constraint
const customMockTable = {
  type: 'r',
  columns: [{ name: 'custom_id' }],
  dq_info: {
    duplicate_protection: {
      has_unique_index: true,
      has_unique_constraint: true,
      first_col_name: 'custom_id',
      key_columns: ['custom_id', 'branch_id'],
      cols_str: 'custom_id, branch_id',
      index_name: 'idx_my_custom_active',
      constraint_name: 'uq_custom_version_history'
    }
  }
};
const customPk = formatPrimaryKey(customMockTable, 'dds', 'core', 'custom_table');
console.log('\ncustom_table {primary_key}:\n' + customPk);
assert(customPk.includes('CREATE UNIQUE INDEX idx_my_custom_active'), 'custom index name should be used');
assert(customPk.includes('ADD CONSTRAINT uq_custom_version_history'), 'custom constraint name should be used');
console.log('✓ custom_table: произвольные имена индекса и ограничения корректно подставляются');

// 4. Check regular PK table (client_account_profile)
const capPk = getPrimaryKeyForTable('dds', 'core', 'client_account_profile');
console.log('\nclient_account_profile {primary_key}:', capPk);
assert.strictEqual(capPk, 'client_id, account_id');
console.log('✓ client_account_profile: обычный PK не сломан');

// 5. Check dm table with unique constraint (account_activity)
const aaPk = getPrimaryKeyForTable('dm', 'core', 'account_activity');
console.log('\naccount_activity {primary_key}:\n' + aaPk);
assert(aaPk.includes('ALTER TABLE dm.core.account_activity'), 'account_activity should contain ALTER TABLE dm.core.account_activity');
assert(aaPk.includes('ADD CONSTRAINT three_cols_key UNIQUE (transaction_id, transaction_date, client_id);'), 'account_activity should contain three_cols_key');
console.log('✓ dm.core.account_activity: UNIQUE constraint заменяет {primary_key}');

// 6. Check dm table without unique constraint (account_card_overview)
const acoPk = getPrimaryKeyForTable('dm', 'core', 'account_card_overview');
console.log('\naccount_card_overview {primary_key}:', acoPk);
assert.strictEqual(acoPk, 'нет primary key');
console.log('✓ dm.core.account_card_overview: без PK и без UNIQUE выводит "нет primary key"');

console.log('\n======================================================');
console.log('✓ ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ УСПЕШНО');
console.log('======================================================');
