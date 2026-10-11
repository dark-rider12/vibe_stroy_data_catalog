-- ============================================================================
-- 03_init_dm.sql
-- Слой: DM (Data Marts)
-- База данных: dm
-- Схемы: core, ext_dds, ext_calc, sandbox_3
-- Описание:
--   1. Настройка postgres_fdw (сервер dds_server -> БД dds).
--   2. Импорт внешних таблиц из dds.core (в ext_dds) и dds.calc (в ext_calc).
--   3. Создание витрин данных DM (с выборкой из ext_dds и ext_calc).
--   4. Добавление комментариев к таблицам и колонкам витрин.
--   5. Регистрация SQL-трансформаций в public.sql_inventory (для Data Catalog).
-- ============================================================================

-- Подключение к БД dm (раскомментируйте при выполнении через psql):
-- \c dm

CREATE EXTENSION IF NOT EXISTS postgres_fdw;

-- ----------------------------------------------------------------------------
-- Настройка FDW-соединения с БД dds
-- ВНИМАНИЕ: укажите реальные параметры подключения к вашей БД dds:
-- ----------------------------------------------------------------------------
DROP SERVER IF EXISTS dds_server CASCADE;
CREATE SERVER dds_server
    FOREIGN DATA WRAPPER postgres_fdw
    OPTIONS (host 'localhost', dbname 'dds', port '5432');

-- Маппинг пользователя (замените postgres и YOUR_PASSWORD на ваши реквизиты)
CREATE USER MAPPING IF NOT EXISTS FOR CURRENT_USER
    SERVER dds_server
    OPTIONS (user 'postgres', password 'YOUR_PASSWORD');

-- Создание целевых схем
CREATE SCHEMA IF NOT EXISTS ext_dds;
CREATE SCHEMA IF NOT EXISTS ext_calc;
CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS sandbox_3;

-- Импорт внешних таблиц из DDS
IMPORT FOREIGN SCHEMA core FROM SERVER dds_server INTO ext_dds;
IMPORT FOREIGN SCHEMA calc FROM SERVER dds_server INTO ext_calc;

-- ----------------------------------------------------------------------------
-- Создание витрин данных слоя DM
-- ----------------------------------------------------------------------------
create table core.account_activity as
select
    t.transaction_id, --ID Транзакции /*Дата Транзакции*/
    t.transaction_date, /*Дата Транзакции*/
    t.transaction_ts,
    null as null_test_column,
    a.client_id --ID Транзакции /*Дата Транзакции*/
    ,a.client_full_name,
    a.contract_id,
    a.contract_number, 
    a.contract_type,
    a.account_id,
    a.account_number,
    a.account_type,
    a.currency_cd,
    t.transaction_type,
    t.amount_amt,
    t.signed_amount_amt,
    t.operation_category,
    t.channel_cd,
    t.transaction_status,
    coalesce(
        t.merchant_name,
        a.client_full_name || ' / ' || a.contract_number
    ) as operation_context,
    coalesce(
        t.description_txt,
        t.operation_category || ' for ' || a.account_type
    ) as operation_details,
    a.balance_amt as current_balance_amt,
    a.interest_rate
from ext_dds.transaction_detail t
join ext_dds.account_detail a
    on a.account_id = t.account_id;

-- Витрина: агрегация транзакций по расширенному профилю клиента
create table core.client_behavior_summary as
select
    cap.client_id,
    cap.client_full_name,
    cap.client_city,
    cap.active_passport,
    count(td.transaction_id) as total_trx_count,
    sum(case when td.transaction_type = 'credit' then td.amount_amt else 0 end) as total_credit_amt,
    sum(case when td.transaction_type = 'debit' then td.amount_amt else 0 end) as total_debit_amt,
    max(td.transaction_date) as last_transaction_date,
    string_agg(distinct td.channel_cd, ', ') as used_channels
from ext_dds.client_account_profile cap
left join ext_dds.transaction_detail td
    on cap.account_id = td.account_id
group by
    cap.client_id,
    cap.client_full_name,
    cap.client_city,
    cap.active_passport;


-- ==================== Создание витрины core.card_risk_analysis ====================
--Витрина с подзапросами в коде!!!

create table core.card_risk_analysis as
select
    cd.card_id,
    cd.masked_card_number,
    cd.card_system,
    cd.issue_date,
    cd.expiry_date,
    cd.validity_status,
    aap.account_id,
    aap.account_number,
    aap.account_type,
    aap.currency_cd,
    aap.client_id,
    aap.client_full_name,
    cbs.client_city,
    cbs.active_passport,
    aap.contract_id,
    aap.contract_number,
    aap.contract_type,
    aap.interest_rate,
    -- Подзапрос: количество транзакций по счёту за последние 30 дней
    (
        select count(*)
        from ext_dds.transaction_detail td
        where td.account_id = cd.account_id
          and td.transaction_date >= current_date - interval '30 days'
    ) as trx_count_30d,
    -- Подзапрос: сумма списаний за последние 30 дней
    (
        select coalesce(sum(td.amount_amt), 0)
        from ext_dds.transaction_detail td
        where td.account_id = cd.account_id
          and td.transaction_type = 'debit'
          and td.transaction_date >= current_date - interval '30 days'
    ) as debit_sum_30d,
    -- Подзапрос: сумма зачислений за последние 30 дней
    (
        select coalesce(sum(td.amount_amt), 0)
        from ext_dds.transaction_detail td
        where td.account_id = cd.account_id
          and td.transaction_type = 'credit'
          and td.transaction_date >= current_date - interval '30 days'
    ) as credit_sum_30d,
    -- Подзапрос: количество уникальных мерчантов за последние 30 дней
    (
        select count(distinct td.merchant_name)
        from ext_dds.transaction_detail td
        where td.account_id = cd.account_id
          and td.transaction_date >= current_date - interval '30 days'
          and td.merchant_name is not null
    ) as unique_merchants_30d,
    -- Подзапрос: дата последней транзакции по счёту
    (
        select max(td.transaction_date)
        from ext_dds.transaction_detail td
        where td.account_id = cd.account_id
    ) as last_trx_date,
    -- Подзапрос: наиболее частый канал операций
    (
        select td.channel_cd
        from ext_dds.transaction_detail td
        where td.account_id = cd.account_id
        group by td.channel_cd
        order by count(*) desc
        limit 1
    ) as top_channel,
    -- Данные из витрины core.client_behavior_summary
    cbs.total_trx_count,
    cbs.total_credit_amt,
    cbs.total_debit_amt,
    cbs.last_transaction_date as client_last_trx_date,
    cbs.used_channels,
    -- Расчётные риск-метрики
    case
        when cd.validity_status = 'expired' then 'high'
        when cd.validity_status = 'invalid' then 'high'
        when (
            select count(*)
            from ext_dds.transaction_detail td
            where td.account_id = cd.account_id
              and td.transaction_date >= current_date - interval '30 days'
        ) > 100 then 'medium'
        when (
            select coalesce(sum(td.amount_amt), 0)
            from ext_dds.transaction_detail td
            where td.account_id = cd.account_id
              and td.transaction_type = 'debit'
              and td.transaction_date >= current_date - interval '30 days'
        ) > aap.balance_amt * 0.5 then 'medium'
        else 'low'
    end as risk_level,
    current_date as report_date
from ext_dds.card_detail cd
join ext_dds.account_detail aap
    on aap.account_id = cd.account_id
left join core.client_behavior_summary cbs
    on cbs.client_id = aap.client_id;


-- ==================== Создание витрины core.client_revenue_potential ====================
--Таблица с CTE With
create table core.client_revenue_potential as
with monthly_turnover as (
    -- Помесячная агрегация транзакций по каждому счёту
    select 
        account_id,
        date_trunc('month', transaction_date) as trx_month,
        sum(case when transaction_type = 'credit' then amount_amt else 0 end) as monthly_inflow,
        sum(case when transaction_type = 'debit' then amount_amt else 0 end) as monthly_outflow,
        count(*) as monthly_trx_count,
        count(distinct channel_cd) as monthly_channels
    from ext_dds.transaction_detail
    group by account_id, date_trunc('month', transaction_date)
),
account_stats as (
    -- Сводная статистика по счёту на основе помесячных оборотов
    select 
        account_id,
        avg(monthly_inflow) as avg_monthly_inflow,
        avg(monthly_outflow) as avg_monthly_outflow,
        max(monthly_trx_count) as peak_monthly_trx,
        sum(monthly_inflow) as total_inflow,
        sum(monthly_outflow) as total_outflow,
        count(distinct trx_month) as active_months,
        max(trx_month) as last_active_month,
        '2' as constant_column
    from monthly_turnover
    group by account_id
)
select
    cap.client_id,
    ast.constant_column,
    cap.client_full_name,
    cap.client_city,
    cap.active_passport,
    cap.address_type,
    ad.account_id,
    ad.account_number,
    ad.account_type,
    ad.currency_cd,
    ad.open_date,
    ad.balance_amt,
    ad.interest_rate,
    ad.account_status,
    coalesce(ast.avg_monthly_inflow, 0) as avg_monthly_inflow,
    coalesce(ast.avg_monthly_outflow, 0) as avg_monthly_outflow,
    ast.peak_monthly_trx,
    coalesce(ast.total_inflow, 0) as total_inflow,
    coalesce(ast.total_outflow, 0) as total_outflow,
    coalesce(ast.active_months, 0) as active_months,
    ast.last_active_month,
    case 
        when coalesce(ast.avg_monthly_inflow, 0) > 1000000 then 'premium'
        when coalesce(ast.avg_monthly_inflow, 0) > 100000 then 'gold'
        else 'standard'
    end as client_segment,
    case
        when ad.balance_amt > 0 and coalesce(ast.avg_monthly_outflow, 0) > ad.balance_amt * 2 then 'over spender'
        when coalesce(ast.avg_monthly_inflow, 0) > coalesce(ast.avg_monthly_outflow, 0) then 'saver'
        else 'neutral'
    end as financial_behavior,
    current_date as report_date
from ext_dds.client_account_profile cap
join ext_dds.account_detail ad 
    on ad.account_id = cap.account_id
left join account_stats ast 
    on ast.account_id = ad.account_id;



-- ==================== Создание витрины core.client_scoring_model ====================
--Витрина и с CTE With и с подзапросами
create table core.client_scoring_model as
with revenue_metrics as (
    -- CTE: агрегация выручечных метрик по клиенту из витрины core.client_revenue_potential
    select 
        client_id,
        sum(total_inflow) as lifetime_inflow,
        sum(total_outflow) as lifetime_outflow,
        max(client_segment) as best_segment,
        count(*) as accounts_count,
        sum(balance_amt) as total_balance,
        max(last_active_month) as last_revenue_month
    from core.client_revenue_potential
    group by client_id
)
select
    cap.client_id,
    cap.client_full_name,
    cap.client_city,
    cap.active_passport,
    cap.address_type,
    
    -- Данные из core.client_behavior_summary
    cbs.total_trx_count,
    cbs.total_credit_amt,
    cbs.total_debit_amt,
    cbs.last_transaction_date,
    cbs.used_channels,
    
    -- Данные из CTE revenue_metrics
    rm.lifetime_inflow,
    rm.lifetime_outflow,
    rm.best_segment,
    rm.accounts_count,
    rm.total_balance,
    rm.last_revenue_month,
    
    -- Подзапрос 1: количество премиальных счетов клиента
    (
        select count(*)
        from core.client_revenue_potential crp2
        where crp2.client_id = cap.client_id
          and crp2.client_segment = 'premium'
    ) as premium_accounts_count,
    
    -- Подзапрос 2: максимальный пик транзакций в месяц по всем счетам клиента
    (
        select max(peak_monthly_trx)
        from core.client_revenue_potential crp3
        where crp3.client_id = cap.client_id
    ) as max_peak_monthly_trx,
    
    -- Расчётное поле: дней с последней транзакции
    current_date - cbs.last_transaction_date as days_since_last_trx,
    
    -- Скоринговая оценка поведения (0–100)
    case
        when rm.best_segment = 'premium' and cbs.total_trx_count > 500 then 100
        when rm.best_segment = 'gold' and cbs.total_trx_count > 100 then 80
        when rm.best_segment = 'standard' and cbs.total_trx_count > 50 then 60
        else 30
    end as behavior_score,
    
    -- Класс благосостояния
    case
        when rm.total_balance > 1000000 then 'A'
        when rm.total_balance > 100000 then 'B'
        when rm.total_balance > 10000 then 'C'
        else 'D'
    end as wealth_grade,
    
    current_date as report_date
from ext_dds.client_account_profile cap
left join core.client_behavior_summary cbs 
    on cbs.client_id = cap.client_id
left join revenue_metrics rm 
    on rm.client_id = cap.client_id;


--витрина без комментариев
create table core.account_card_overview as (
select
    ad.account_id,
    ad.account_number,
    ad.account_type,
    ad.currency_cd,
    cd.card_id,
    cd.card_system,
    cap.address_type,
    
    ad.client_full_name as client_name,
    cap.client_city as city_name,
    cap.active_passport as passport,
    ad.contract_number as agreement_num,
    ad.contract_type as agreement_type,
    ad.balance_amt as current_balance,
    ad.interest_rate as annual_rate_pct,
    
    current_date - ad.open_date as account_age_days,
    cd.expiry_date - current_date as days_to_expiry,
    round(ad.balance_amt * ad.interest_rate / 100 / 12, 2) as monthly_interest_amt,
    case 
        when ad.balance_amt >= 100000 then 'VIP' 
        when ad.balance_amt >= 10000 then 'Gold' 
        else 'Standard' 
    end as account_tier,
    concat_ws(' | ', ad.account_type, ad.currency_cd, cd.card_system) as product_bundle,
    case when cd.validity_status = 'valid' then 1 else 0 end as is_card_valid_flag
from ext_dds.account_detail ad
join ext_dds.card_detail cd 
    on cd.account_id = ad.account_id
left join ext_dds.client_account_profile cap 
    on cap.account_id = ad.account_id);


--Ограничения NOT NULL

-- core.account_activity
alter table core.account_activity 
    alter column transaction_id set not null,
    alter column transaction_date set not null,
    alter column account_id set not null,
    alter column client_id set not null,
    alter column amount_amt set not null;

-- core.client_behavior_summary
alter table core.client_behavior_summary 
    alter column client_id set not null,
    alter column client_full_name set not null,
    alter column total_trx_count set not null,
    alter column total_credit_amt set not null,
    alter column total_debit_amt set not null;

-- core.card_risk_analysis
alter table core.card_risk_analysis 
    alter column card_id set not null,
    alter column account_id set not null,
    alter column client_id set not null,
    alter column risk_level set not null,
    alter column report_date set not null;

-- core.client_revenue_potential
alter table core.client_revenue_potential 
    alter column client_id set not null,
    alter column account_id set not null,
    alter column account_number set not null,
    alter column account_status set not null,
    alter column report_date set not null;

-- core.client_scoring_model
alter table core.client_scoring_model 
    alter column client_id set not null,
    alter column client_full_name set not null,
    alter column best_segment set not null,
    alter column behavior_score set not null,
    alter column wealth_grade set not null;

-- core.account_card_overview
alter table core.account_card_overview 
    alter column account_id set not null,
    alter column account_number set not null,
    alter column card_id set not null,
    alter column account_type set not null,
    alter column is_card_valid_flag set not null;



-- ==================== Создание представления core.v_client_daily_activity ====================

create or replace view core.v_client_daily_activity as 
select
    t.transaction_date,
    a.client_id,
    a.client_full_name,
    a.account_id,
    a.account_number,
    a.account_type,
    a.currency_cd,
    /* тестовый двустрочный
    комментарий*/
    count(t.transaction_id) as daily_trx_count,
    sum(t.signed_amount_amt) as daily_net_amount,
    sum(case when t.transaction_type = 'credit' then t.amount_amt else 0 end) as daily_credit_amt,
    sum(case when t.transaction_type = 'debit' then t.amount_amt else 0 end) as daily_debit_amt,
    count(distinct t.channel_cd) as daily_channels_used,
    max(t.transaction_ts) as last_trx_ts,
    string_agg(distinct t.operation_category, ', ' order by t.operation_category) as daily_categories
from ext_dds.transaction_detail t
join ext_dds.account_detail a 
    on a.account_id = t.account_id
group by 
    t.transaction_date,
    a.client_id,
    a.client_full_name,
    a.account_id,
    a.account_number,
    a.account_type,
    a.currency_cd;



-- ==================== 4. Создание витрины DM (с WITH + UNION) ====================

create table core.unified_client_directory as
with corporate_enriched as (
    select
        'CORPORATE' as client_type,
        client_id,
        inn,
        null::varchar as snils,
        display_name as client_name,
        null::date as birth_date,
        company_age_days as age_days,
        null::varchar as passport_full,
        effective_address,
        phone,
        email,
        industry_cd as segment_cd,
        company_size_cd as sub_segment_cd,
        status_cd,
        0::decimal(18,2) as monthly_income_amt,
        null::varchar as income_level_cd,
        created_ts
    from ext_dds.corporate_client_detail
),
individual_enriched as (
    select
        'INDIVIDUAL' as client_type,
        client_id,
        inn,
        snils,
        full_name as client_name,
        birth_date,
        age_days,
        passport_full,
        effective_address,
        phone,
        email,
        marital_status_cd as segment_cd,
        employment_type_cd as sub_segment_cd,
        status_cd,
        monthly_income_amt,
        income_level_cd,
        created_ts
    from ext_dds.individual_client_detail
),
unified_base as (
    select * from corporate_enriched
    union all
    select * from individual_enriched
)
select
    ub.*,
    -- Подзапрос: количество счетов клиента
    (
        select count(*)
        from ext_dds.account_detail ad
        where ad.client_id = ub.client_id
    ) as accounts_count,
    -- Подзапрос: суммарный баланс по всем счетам
    (
        select coalesce(sum(balance_amt), 0)
        from ext_dds.account_detail ad
        where ad.client_id = ub.client_id
    ) as total_balance_amt,
    -- Подзапрос: дата последней транзакции
    (
        select max(transaction_date)
        from ext_dds.transaction_detail td
        join ext_dds.account_detail ad on ad.account_id = td.account_id
        where ad.client_id = ub.client_id
    ) as last_transaction_date,
    current_date as report_date
from unified_base ub;


-- ==================== 5. Комментарии к витрине ====================

comment on table core.unified_client_directory is '(с WITH + UNION) Единый справочник клиентов: объединение юридических и физических лиц из DDS через CTE с UNION ALL. Содержит подзапросы для расчёта счетов, балансов и активности. Слой DataMart.';

comment on column core.unified_client_directory.client_type is 'Тип клиента: CORPORATE (юридическое лицо) или INDIVIDUAL (физическое лицо)';
comment on column core.unified_client_directory.client_id is 'Уникальный идентификатор клиента (из соответствующей DDS-таблицы)';
comment on column core.unified_client_directory.inn is 'ИНН клиента';
comment on column core.unified_client_directory.snils is 'СНИЛС (только для физических лиц)';
comment on column core.unified_client_directory.client_name is 'Наименование клиента: название компании или ФИО';
comment on column core.unified_client_directory.birth_date is 'Дата рождения (только для физических лиц)';
comment on column core.unified_client_directory.age_days is 'Возраст в днях: компании (с даты регистрации) или человека (с даты рождения)';
comment on column core.unified_client_directory.passport_full is 'Паспортные данные (только для физических лиц)';
comment on column core.unified_client_directory.effective_address is 'Актуальный адрес: фактический (если есть) или юридический/регистрации';
comment on column core.unified_client_directory.phone is 'Контактный телефон';
comment on column core.unified_client_directory.email is 'Адрес электронной почты';
comment on column core.unified_client_directory.segment_cd is 'Сегмент: отрасль (для юрлиц) или семейное положение (для физлиц)';
comment on column core.unified_client_directory.sub_segment_cd is 'Подсегмент: размер компании (для юрлиц) или тип занятости (для физлиц)';
comment on column core.unified_client_directory.status_cd is 'Статус клиента в CRM';
comment on column core.unified_client_directory.monthly_income_amt is 'Ежемесячный доход (только для физических лиц, 0 для юрлиц)';
comment on column core.unified_client_directory.income_level_cd is 'Уровень дохода: high/medium/low (только для физических лиц)';
comment on column core.unified_client_directory.created_ts is 'Дата создания записи в ODS';
comment on column core.unified_client_directory.accounts_count is 'Количество открытых счетов клиента (подзапрос)';
comment on column core.unified_client_directory.total_balance_amt is 'Суммарный остаток средств на всех счетах клиента (подзапрос)';
comment on column core.unified_client_directory.last_transaction_date is 'Дата последней транзакции по любому счёту клиента (подзапрос)';
comment on column core.unified_client_directory.report_date is 'Дата формирования витрины';







--Витрина Георгия с подзапросом с алиасом и union внутри него
create or replace view  core.v_client_unified_registry_2 as
select distinct
    client_type as  client_t,
    client_id as cli_id,
    client_name as  client_n,
    inn as cl_inn,
    snils as cl_snils,
    effective_address,
    phone --тест /* тест */
    ,email,
    segment_cd, --тест /* тест */
    status_cd,
    monthly_income_amt,
    (
        select count(*)
        from ext_dds.account_detail ad
        where ad.client_id = u.client_id
    ) as accounts_count,
    (
        select coalesce(sum(balance_amt), 0)
        from ext_dds.account_detail ad
        where ad.client_id = u.client_id
    ) as total_balance_amt,
    (
        select max(td.transaction_date)
        from ext_dds.transaction_detail td
        join ext_dds.account_detail ad on ad.account_id = td.account_id
        where ad.client_id = u.client_id
    ) as last_transaction_date,
    current_date as report_date
from (
    select
        'CORPORATE' as client_type,
        cc.client_id,
        cc.display_name as client_name,
        cc.inn,
        null::varchar as snils,
        cc.effective_address,
        cc.phone,
        cc.email,
        cc.industry_cd as segment_cd,
        cc.status_cd,
        0::decimal(18,2) as monthly_income_amt
    from ext_dds.corporate_client_detail cc
    union
    select
        'INDIVIDUAL' as client_type,
        cc.client_id,
        cc.full_name as client_name,
        cc.inn,
        cc.snils,
        cc.effective_address,
        cc.phone,
        cc.email,
        cc.marital_status_cd as segment_cd,
        cc.status_cd,
        cc.monthly_income_amt
    from ext_dds.individual_client_detail cc
) u;

comment on view core.v_client_unified_registry_2 is 'Витрина (второй вариант без алиасов) Георгия с подзапросом с алиасом и union внутри него. Единый реестр клиентов: юридические и физические лица через inline-view с UNION ALL. Слой DataMart.';




----
-- ==================== Создание ежедневных срезов core.daily_account_snapshot ====================

create table core.daily_account_snapshot as
select
    a.account_id,
    a.account_number,
    a.client_id,
    a.client_full_name,
    a.account_type,
    a.currency_cd,
    a.balance_amt,
    a.interest_rate,
    a.account_status,
    report_date,
    a.open_date,
    a.close_date,
    current_date - a.open_date as account_age_days,
    case 
        when report_date between a.open_date and coalesce(a.close_date, current_date) 
        then true 
        else false 
    end as is_active_on_date,
    case 
        when report_date = a.open_date then 'open_day'
        when report_date = a.close_date then 'close_day'
        else 'regular'
    end as date_type,
    extract(year from report_date) as report_year,
    extract(month from report_date) as report_month,
    extract(quarter from report_date) as report_quarter
from ext_dds.account_detail a
cross join lateral generate_series(
    a.open_date,
    coalesce(a.close_date, current_date),
    interval '1 day'
) as report_date;


-- ==================== Комментарии к таблице ====================

comment on table core.daily_account_snapshot is 'Ежедневные срезы по банковским счетам: календарная шкала от open_date до close_date/current_date через cross join lateral generate_series. Слой DataMart для анализа динамики, построения time-series и отчётности по дням.';

comment on column core.daily_account_snapshot.account_id is 'Идентификатор счёта';
comment on column core.daily_account_snapshot.account_number is 'Номер банковского счёта';
comment on column core.daily_account_snapshot.client_id is 'Идентификатор клиента-владельца';
comment on column core.daily_account_snapshot.client_full_name is 'Полное ФИО клиента';
comment on column core.daily_account_snapshot.account_type is 'Тип счёта';
comment on column core.daily_account_snapshot.currency_cd is 'Код валюты счёта';
comment on column core.daily_account_snapshot.balance_amt is 'Текущий остаток на счёте (актуальный на момент загрузки)';
comment on column core.daily_account_snapshot.interest_rate is 'Процентная ставка по договору (годовых)';
comment on column core.daily_account_snapshot.account_status is 'Статус счёта';
comment on column core.daily_account_snapshot.report_date is 'Дата среза (каждый день из generate_series)';
comment on column core.daily_account_snapshot.open_date is 'Дата открытия счёта';
comment on column core.daily_account_snapshot.close_date is 'Дата закрытия счёта (NULL, если активен)';
comment on column core.daily_account_snapshot.account_age_days is 'Возраст счёта в днях на момент формирования витрины';
comment on column core.daily_account_snapshot.is_active_on_date is 'Признак активности счёта на report_date (TRUE, если дата в диапазоне open_date..close_date)';
comment on column core.daily_account_snapshot.date_type is 'Тип даты: open_day (день открытия), close_day (день закрытия), regular (обычный день)';
comment on column core.daily_account_snapshot.report_year is 'Год среза';
comment on column core.daily_account_snapshot.report_month is 'Месяц среза';
comment on column core.daily_account_snapshot.report_quarter is 'Квартал среза';



--сложная витрина
create table core.daily_account_risk_monitor as
with account_calendar as (
    -- CTE 1: дневные срезы через generate_series для каждого счёта
    select
        a.account_id,
        a.account_number,
        a.client_id,
        a.account_type,
        a.currency_cd,
        a.balance_amt as current_balance,
        a.open_date,
        a.close_date,
        report_date
    from ext_dds.account_detail a
    cross join lateral generate_series(
        a.open_date,
        coalesce(a.close_date, current_date),
        interval '1 day'
    ) as report_date
),
daily_flows as (
    -- CTE 2: ежедневные обороты по счёту (алиас "a" совпадает с CTE1)
    select
        a.account_id,
        a.report_date,
        a.account_number,
        a.client_id,
        a.account_type,
        a.currency_cd,
        a.current_balance,
        a.open_date,
        a.close_date,
        coalesce(sum(t.amount_amt) filter (where t.transaction_type = 'debit'), 0) as daily_debit,
        coalesce(sum(t.amount_amt) filter (where t.transaction_type = 'credit'), 0) as daily_credit,
        count(t.transaction_id) as daily_trx_count
    from account_calendar a
    left join ext_dds.transaction_detail t
        on t.account_id = a.account_id
        and t.transaction_date = a.report_date
    group by
        a.account_id, a.report_date, a.account_number, a.client_id,
        a.account_type, a.currency_cd, a.current_balance, a.open_date, a.close_date
),
rolling_window as (
    -- CTE 3: скользящие окна 7 дней (алиас "a" совпадает с CTE2)
    select
        a.account_id,
        a.report_date,
        a.account_number,
        a.client_id,
        a.account_type,
        a.currency_cd,
        a.current_balance,
        a.daily_debit,
        a.daily_credit,
        a.daily_trx_count,
        sum(a.daily_debit) over (
            partition by a.account_id
            order by a.report_date
            rows between 6 preceding and current row
        ) as rolling_debit_7d,
        sum(a.daily_credit) over (
            partition by a.account_id
            order by a.report_date
            rows between 6 preceding and current row
        ) as rolling_credit_7d,
        avg(a.daily_trx_count) over (
            partition by a.account_id
            order by a.report_date
            rows between 6 preceding and current row
        ) as avg_trx_7d
    from daily_flows a
),
client_enriched as (
    -- CTE 4: профиль клиента (алиас "a" совпадает с CTE3)
    select
        a.account_id,
        a.report_date,
        a.account_number,
        a.client_id,
        a.account_type,
        a.currency_cd,
        a.current_balance,
        a.daily_debit,
        a.daily_credit,
        a.daily_trx_count,
        a.rolling_debit_7d,
        a.rolling_credit_7d,
        a.avg_trx_7d,
        cap.client_city,
        cap.active_passport,
        cap.address_type
    from rolling_window a
    left join ext_dds.client_account_profile cap
        on cap.account_id = a.account_id
),
risk_flagged as (
    -- CTE 5: флаги риска (алиас "a" совпадает с CTE4)
    select
        a.account_id,
        a.report_date,
        a.account_number,
        a.client_id,
        a.client_city,
        a.account_type,
        a.currency_cd,
        a.current_balance,
        a.daily_debit,
        a.daily_credit,
        a.daily_trx_count,
        a.rolling_debit_7d,
        a.rolling_credit_7d,
        a.avg_trx_7d,
        a.active_passport,
        a.address_type,
        case
            when a.rolling_debit_7d > a.current_balance * 0.5 then 'high'
            when a.rolling_debit_7d > a.current_balance * 0.2 then 'medium'
            else 'low'
        end as risk_level,
        case
            when a.daily_trx_count > 10 then 'spike'
            when a.daily_trx_count > 5 then 'elevated'
            else 'normal'
        end as activity_flag
    from client_enriched a
)
-- Финальный SELECT с дополнительными джойнами
select
    rf.account_id,
    rf.report_date,
    rf.account_number,
    rf.client_id,
    rf.client_city,
    rf.account_type,
    rf.currency_cd,
    rf.current_balance,
    rf.daily_debit,
    rf.daily_credit,
    rf.daily_trx_count,
    rf.rolling_debit_7d,
    rf.rolling_credit_7d,
    rf.avg_trx_7d,
    rf.risk_level,
    rf.activity_flag,
    rf.active_passport,
    rf.address_type,
    cd.masked_card_number,
    cd.card_system,
    cd.validity_status,
    cbs.total_trx_count as client_total_trx,
    cbs.total_credit_amt as client_total_credit,
    cbs.total_debit_amt as client_total_debit,
    csm.behavior_score,
    csm.wealth_grade,
    crp.client_segment,
    crp.avg_monthly_inflow,
    current_date as snapshot_date
from risk_flagged rf
left join ext_dds.card_detail cd
    on cd.account_id = rf.account_id
left join core.client_behavior_summary cbs
    on cbs.client_id = rf.client_id
left join core.client_scoring_model csm
    on csm.client_id = rf.client_id
left join core.client_revenue_potential crp
    on crp.account_id = rf.account_id
    and crp.report_date = current_date;


-- ==================== Комментарии ====================

comment on table core.daily_account_risk_monitor is '5 CTE с цепочечными ссылками (daily_flows → rolling_window → client_enriched → risk_flagged), дневные срезы через generate_series в первом CTE, финальный SELECT с 4 дополнительными джойнами. Слой DataMart.';


--витрины, собранная из 9 прошлых витрин, для отладки table линейджа
create table core.master_nine_mart_join as
select
    aa.transaction_id,
    aa.transaction_date,
    aa.transaction_ts,
    aa.account_id,
    aa.client_id,
    aa.client_full_name,
    aa.contract_id,
    aa.contract_number,
    aa.contract_type,
    aa.account_type,
    aa.currency_cd,
    aa.transaction_type,
    aa.amount_amt,
    aa.signed_amount_amt,
    aa.operation_category,
    aa.channel_cd,
    aa.transaction_status,
    aa.current_balance_amt,
    aa.interest_rate,
    aa.operation_context,
    aa.operation_details,

    cbs.total_trx_count,
    cbs.total_credit_amt,
    cbs.total_debit_amt,
    cbs.last_transaction_date as cbs_last_trx_date,
    cbs.used_channels,

    cra.card_id,
    cra.masked_card_number,
    cra.card_system,
    cra.validity_status,
    cra.risk_level as card_risk_level,
    cra.trx_count_30d,
    cra.debit_sum_30d,
    cra.credit_sum_30d,
    cra.unique_merchants_30d,
    cra.top_channel,

    crp.avg_monthly_inflow,
    crp.avg_monthly_outflow,
    crp.peak_monthly_trx,
    crp.total_inflow,
    crp.total_outflow,
    crp.active_months,
    crp.client_segment,
    crp.financial_behavior,

    csm.behavior_score,
    csm.wealth_grade,
    csm.lifetime_inflow,
    csm.lifetime_outflow,
    csm.premium_accounts_count,
    csm.max_peak_monthly_trx,
    csm.days_since_last_trx,

    aco.card_id as aco_card_id,
    aco.days_to_expiry,
    aco.account_tier,
    aco.product_bundle,
    aco.is_card_valid_flag,

    ucd.client_type as ucd_client_type,
    ucd.passport_full,
    ucd.total_balance_amt as ucd_total_balance,
    ucd.last_transaction_date as ucd_last_trx_date,
    ucd.accounts_count as ucd_accounts_count,

    cur.client_t,
    cur.cl_inn,
    cur.cl_snils,
    cur.total_balance_amt as cur_total_balance,
    cur.accounts_count as cur_accounts_count,
    cur.last_transaction_date as cur_last_trx_date,

    das.report_date,
    das.is_active_on_date,
    das.date_type,
    das.report_year,
    das.report_month,
    das.report_quarter

from core.account_activity aa
left join core.client_behavior_summary cbs 
    on cbs.client_id = aa.client_id
left join core.card_risk_analysis cra 
    on cra.account_id = aa.account_id
left join core.client_revenue_potential crp 
    on crp.account_id = aa.account_id
left join core.client_scoring_model csm 
    on csm.client_id = aa.client_id
left join core.account_card_overview aco 
    on aco.account_id = aa.account_id
left join core.unified_client_directory ucd 
    on ucd.client_id = aa.client_id
left join core.v_client_unified_registry_2 cur 
    on cur.cli_id = aa.client_id
left join core.daily_account_snapshot das 
    on das.account_id = aa.account_id 
    and das.report_date = aa.transaction_date;


-- ==================== Комментарий ====================

comment on table core.master_nine_mart_join is 'Мастер-витрина: объединение 9 витрин слоя DM через LEFT JOIN по client_id и account_id. Базовая таблица — core.account_activity, к ней джойнятся client_behavior_summary, card_risk_analysis, client_revenue_potential, client_scoring_model, account_card_overview, unified_client_directory, client_unified_registry и daily_account_snapshot. Без сложной трансформации.';

-- ==================== core.account_activity ====================

comment on table core.account_activity is 'Витрина данных: детальная активность по счетам с клиентской и договорной информацией. Слой DataMart для анализа транзакций и операционной активности.';

comment on column core.account_activity.transaction_id is 'Уникальный идентификатор транзакции (из DDS)';
comment on column core.account_activity.transaction_date is 'Дата совершения транзакции';
comment on column core.account_activity.transaction_ts is 'Дата и время совершения транзакции (с временной меткой)';
comment on column core.account_activity.client_id is 'Идентификатор клиента-владельца счёта';
comment on column core.account_activity.client_full_name is 'Полное ФИО клиента';
comment on column core.account_activity.contract_id is 'Идентификатор договора, связанного со счётом';
comment on column core.account_activity.contract_number is 'Номер договора в учётной системе';
comment on column core.account_activity.contract_type is 'Тип договора (кредитный, депозитный, текущий и т.д.)';
comment on column core.account_activity.account_id is 'Идентификатор счёта, по которому совершена транзакция';
comment on column core.account_activity.account_number is 'Номер банковского счёта';
comment on column core.account_activity.account_type is 'Тип счёта';
comment on column core.account_activity.currency_cd is 'Код валюты операции';
comment on column core.account_activity.transaction_type is 'Тип транзакции (debit — списание, credit — зачисление)';
comment on column core.account_activity.amount_amt is 'Абсолютная сумма транзакции (без знака)';
comment on column core.account_activity.signed_amount_amt is 'Сумма транзакции со знаком: отрицательная для списаний, положительная для зачислений';
comment on column core.account_activity.operation_category is 'Категория операции (merchant_operation, transfer, salary, other)';
comment on column core.account_activity.channel_cd is 'Канал совершения операции (online, atm, branch, mobile и т.д.)';
comment on column core.account_activity.transaction_status is 'Статус транзакции (completed, pending, declined и т.д.)';
comment on column core.account_activity.operation_context is 'Контекст операции: мерчант (если есть) или клиент/договор в качестве контрагента';
comment on column core.account_activity.operation_details is 'Детали операции: описание из транзакции или сгенерированное на основе категории и типа счёта';
comment on column core.account_activity.current_balance_amt is 'Текущий остаток на счёте на момент формирования витрины';
comment on column core.account_activity.interest_rate is 'Процентная ставка по договору (годовых)';


-- ==================== core.client_behavior_summary ====================

comment on table core.client_behavior_summary is 'Витрина данных: агрегированный профиль поведения клиента по транзакционной активности с паспортными данными и адресом. Слой DataMart для сегментации и анализа поведения.';

comment on column core.client_behavior_summary.client_id is 'Уникальный идентификатор клиента';
comment on column core.client_behavior_summary.client_full_name is 'Полное ФИО клиента';
comment on column core.client_behavior_summary.client_city is 'Город проживания клиента (из активного адреса)';
comment on column core.client_behavior_summary.active_passport is 'Действующий паспорт клиента (серия и номер)';
comment on column core.client_behavior_summary.total_trx_count is 'Общее количество транзакций клиента по всем счетам';
comment on column core.client_behavior_summary.total_credit_amt is 'Суммарный объём зачислений (credit) по всем счетам клиента';
comment on column core.client_behavior_summary.total_debit_amt is 'Суммарный объём списаний (debit) по всем счетам клиента';
comment on column core.client_behavior_summary.last_transaction_date is 'Дата последней транзакции клиента (по любому счёту)';
comment on column core.client_behavior_summary.used_channels is 'Список уникальных каналов операций, использованных клиентом (через запятую)';



-- ==================== Комментарии к таблице ====================

comment on table core.card_risk_analysis is 'Витрина с подзапросами в коде!!! Анализ рисков по банковским картам с подзапросами для расчёта транзакционной активности за 30 дней и интеграцией агрегированного профиля клиента. Слой DataMart для мониторинга рисков и выявления аномалий.';


-- ==================== Комментарии к полям ====================

comment on column core.card_risk_analysis.card_id is 'Уникальный идентификатор карты';
comment on column core.card_risk_analysis.masked_card_number is 'Маскированный номер карты в формате 6******4';
comment on column core.card_risk_analysis.card_system is 'Платёжная система карты (Visa, Mastercard, МИР и т.д.)';
comment on column core.card_risk_analysis.issue_date is 'Дата выпуска карты';
comment on column core.card_risk_analysis.expiry_date is 'Дата окончания срока действия карты';
comment on column core.card_risk_analysis.validity_status is 'Статус валидности карты: valid, expired, invalid';
comment on column core.card_risk_analysis.account_id is 'Идентификатор счёта, к которому привязана карта';
comment on column core.card_risk_analysis.account_number is 'Номер банковского счёта';
comment on column core.card_risk_analysis.account_type is 'Тип счёта';
comment on column core.card_risk_analysis.currency_cd is 'Код валюты счёта';
comment on column core.card_risk_analysis.client_id is 'Идентификатор клиента-владельца карты';
comment on column core.card_risk_analysis.client_full_name is 'Полное ФИО клиента';
comment on column core.card_risk_analysis.client_city is 'Город проживания клиента (из core.client_behavior_summary)';
comment on column core.card_risk_analysis.active_passport is 'Действующий паспорт клиента, серия и номер (из core.client_behavior_summary)';
comment on column core.card_risk_analysis.contract_id is 'Идентификатор договора, связанного со счётом';
comment on column core.card_risk_analysis.contract_number is 'Номер договора';
comment on column core.card_risk_analysis.contract_type is 'Тип договора';
comment on column core.card_risk_analysis.interest_rate is 'Процентная ставка по договору (годовых)';
comment on column core.card_risk_analysis.trx_count_30d is 'Количество транзакций по счёту за последние 30 дней (скалярный подзапрос)';
comment on column core.card_risk_analysis.debit_sum_30d is 'Сумма списаний (debit) за последние 30 дней (скалярный подзапрос)';
comment on column core.card_risk_analysis.credit_sum_30d is 'Сумма зачислений (credit) за последние 30 дней (скалярный подзапрос)';
comment on column core.card_risk_analysis.unique_merchants_30d is 'Количество уникальных мерчантов за последние 30 дней (скалярный подзапрос)';
comment on column core.card_risk_analysis.last_trx_date is 'Дата последней транзакции по счёту (скалярный подзапрос)';
comment on column core.card_risk_analysis.top_channel is 'Наиболее часто используемый канал операций (скалярный подзапрос с limit 1)';
comment on column core.card_risk_analysis.total_trx_count is 'Общее количество транзакций клиента за всё время (из core.client_behavior_summary)';
comment on column core.card_risk_analysis.total_credit_amt is 'Суммарный объём зачислений клиента за всё время (из core.client_behavior_summary)';
comment on column core.card_risk_analysis.total_debit_amt is 'Суммарный объём списаний клиента за всё время (из core.client_behavior_summary)';
comment on column core.card_risk_analysis.client_last_trx_date is 'Дата последней транзакции клиента по любому счёту (из core.client_behavior_summary)';
comment on column core.card_risk_analysis.used_channels is 'Список уникальных каналов операций клиента (из core.client_behavior_summary)';
comment on column core.card_risk_analysis.risk_level is 'Уровень риска карты: high (просрочена/невалидна), medium (высокая активность или списания > 50% баланса), low (остальные)';
comment on column core.card_risk_analysis.report_date is 'Дата формирования витрины';





-- ==================== Комментарии к таблице ====================
--Таблица с CTE With
comment on table core.client_revenue_potential is 'Витрина с CTE With!! Оценка выручочного потенциала и сегментация клиентов на основе помесячных оборотов по счетам. Слой DataMart. Использует CTE для агрегации транзакций из DDS.';


-- ==================== Комментарии к полям ====================

comment on column core.client_revenue_potential.client_id is 'Уникальный идентификатор клиента';
comment on column core.client_revenue_potential.client_full_name is 'Полное ФИО клиента';
comment on column core.client_revenue_potential.client_city is 'Город проживания клиента (из активного адреса)';
comment on column core.client_revenue_potential.active_passport is 'Действующий паспорт клиента, серия и номер';
comment on column core.client_revenue_potential.address_type is 'Тип адреса клиента (registration, residence и т.д.)';
comment on column core.client_revenue_potential.account_id is 'Идентификатор счёта';
comment on column core.client_revenue_potential.account_number is 'Номер банковского счёта';
comment on column core.client_revenue_potential.account_type is 'Тип счёта';
comment on column core.client_revenue_potential.currency_cd is 'Код валюты счёта';
comment on column core.client_revenue_potential.open_date is 'Дата открытия счёта';
comment on column core.client_revenue_potential.balance_amt is 'Текущий остаток на счёте';
comment on column core.client_revenue_potential.interest_rate is 'Процентная ставка по договору (годовых)';
comment on column core.client_revenue_potential.account_status is 'Статус счёта';
comment on column core.client_revenue_potential.avg_monthly_inflow is 'Среднемесячный объём зачислений (credit) по счёту';
comment on column core.client_revenue_potential.avg_monthly_outflow is 'Среднемесячный объём списаний (debit) по счёту';
comment on column core.client_revenue_potential.peak_monthly_trx is 'Максимальное количество транзакций за один месяц по счёту';
comment on column core.client_revenue_potential.total_inflow is 'Суммарный объём зачислений за всю историю по счёту';
comment on column core.client_revenue_potential.total_outflow is 'Суммарный объём списаний за всю историю по счёту';
comment on column core.client_revenue_potential.active_months is 'Количество месяцев с транзакционной активностью по счёту';
comment on column core.client_revenue_potential.last_active_month is 'Последний месяц, в котором были транзакции по счёту';
comment on column core.client_revenue_potential.client_segment is 'Клиентский сегмент: premium (>1M среднемесячных зачислений), gold (>100K), standard (остальные)';
comment on column core.client_revenue_potential.financial_behavior is 'Финансовое поведение: over spender (расходы > 2x баланса), saver (приход > расход), neutral (остальные)';
comment on column core.client_revenue_potential.report_date is 'Дата формирования витрины';




--Витрина и с CTE With и с подзапросами
comment on table core.client_scoring_model is 'Витрина и с CTE With и с подзапросами!! Скоринговая модель клиента для оценки поведенческой активности и благосостояния. Объединяет профиль клиента (DDS), поведенческую сводку (DM) и выручечный потенциал (DM). Содержит CTE и подзапросы.';


-- ==================== Комментарии к полям ====================

comment on column core.client_scoring_model.client_id is 'Уникальный идентификатор клиента';
comment on column core.client_scoring_model.client_full_name is 'Полное ФИО клиента';
comment on column core.client_scoring_model.client_city is 'Город проживания клиента (из активного адреса)';
comment on column core.client_scoring_model.active_passport is 'Действующий паспорт клиента, серия и номер';
comment on column core.client_scoring_model.address_type is 'Тип адреса клиента (registration, residence и т.д.)';
comment on column core.client_scoring_model.total_trx_count is 'Общее количество транзакций клиента за всё время (из core.client_behavior_summary)';
comment on column core.client_scoring_model.total_credit_amt is 'Суммарный объём зачислений клиента за всё время (из core.client_behavior_summary)';
comment on column core.client_scoring_model.total_debit_amt is 'Суммарный объём списаний клиента за всё время (из core.client_behavior_summary)';
comment on column core.client_scoring_model.last_transaction_date is 'Дата последней транзакции клиента по любому счёту (из core.client_behavior_summary)';
comment on column core.client_scoring_model.used_channels is 'Список уникальных каналов операций клиента (из core.client_behavior_summary)';
comment on column core.client_scoring_model.lifetime_inflow is 'Совокупный объём зачислений за всю историю по всем счетам клиента (агрегация CTE из core.client_revenue_potential)';
comment on column core.client_scoring_model.lifetime_outflow is 'Совокупный объём списаний за всю историю по всем счетам клиента (агрегация CTE)';
comment on column core.client_scoring_model.best_segment is 'Лучший клиентский сегмент среди всех счетов клиента (premium, gold, standard)';
comment on column core.client_scoring_model.accounts_count is 'Количество счетов клиента, представленных в core.client_revenue_potential';
comment on column core.client_scoring_model.total_balance is 'Суммарный остаток средств на всех счетах клиента';
comment on column core.client_scoring_model.last_revenue_month is 'Последний месяц с транзакционной активностью по счетам клиента';
comment on column core.client_scoring_model.premium_accounts_count is 'Количество счетов клиента сегмента premium (скалярный подзапрос)';
comment on column core.client_scoring_model.max_peak_monthly_trx is 'Максимальный пик транзакций в месяц среди всех счетов клиента (скалярный подзапрос)';
comment on column core.client_scoring_model.days_since_last_trx is 'Количество дней с момента последней транзакции (NULL, если транзакций не было)';
comment on column core.client_scoring_model.behavior_score is 'Поведенческий скоринг (0–100): premium + активность = 100, gold = 80, standard = 60, иначе 30';
comment on column core.client_scoring_model.wealth_grade is 'Класс благосостояния: A (>1M), B (>100K), C (>10K), D (остальные)';
comment on column core.client_scoring_model.report_date is 'Дата формирования витрины';




-- ==================== Комментарии к представлению ====================

comment on view core.v_client_daily_activity is 'Представление: ежедневная агрегированная активность клиентов по счетам. Содержит сводку транзакций за каждый день с разбивкой по типам операций, каналам и категориям. Слой DataMart для оперативной отчётности и дашбордов.';

comment on column core.v_client_daily_activity.transaction_date is 'Дата транзакций';
comment on column core.v_client_daily_activity.client_id is 'Идентификатор клиента';
comment on column core.v_client_daily_activity.client_full_name is 'Полное ФИО клиента';
comment on column core.v_client_daily_activity.account_id is 'Идентификатор счёта';
comment on column core.v_client_daily_activity.account_number is 'Номер банковского счёта';
comment on column core.v_client_daily_activity.account_type is 'Тип счёта';
comment on column core.v_client_daily_activity.currency_cd is 'Код валюты счёта';
comment on column core.v_client_daily_activity.daily_trx_count is 'Количество транзакций за день по счёту';
comment on column core.v_client_daily_activity.daily_net_amount is 'Чистая сумма за день (с учётом знака: зачисления положительные, списания отрицательные)';
comment on column core.v_client_daily_activity.daily_credit_amt is 'Сумма зачислений (credit) за день';
comment on column core.v_client_daily_activity.daily_debit_amt is 'Сумма списаний (debit) за день';
comment on column core.v_client_daily_activity.daily_channels_used is 'Количество уникальных каналов операций за день';
comment on column core.v_client_daily_activity.last_trx_ts is 'Временная метка последней транзакции за день';
comment on column core.v_client_daily_activity.daily_categories is 'Список категорий операций за день (через запятую)';




-- ===================
COMMENT ON TABLE core.account_card_overview IS 'Витрина с индексами, но без сгенерированных описаний';

-- ==================== Индексы для core.account_card_overview ====================

-- Уникальный индекс на идентификатор карты (PK-аналог)
create unique index idx_account_card_overview_card_id 
    on core.account_card_overview (card_id);

-- Индекс на идентификатор счёта для join-ов и фильтрации
create index idx_account_card_overview_account_id 
    on core.account_card_overview (account_id);

-- Составной индекс для типа счёта и валюты (типичные фильтры отчётов)
create index idx_account_card_overview_acc_type_currency 
    on core.account_card_overview (account_type, currency_cd);

-- Индекс на клиентский сегмент для быстрой сегментации
create index idx_account_card_overview_tier 
    on core.account_card_overview (account_tier);

-- Индекс на город для территориальной аналитики
create index idx_account_card_overview_city 
    on core.account_card_overview (city_name);

-- Частичный индекс на премиальных клиентов с положительным балансом
create index idx_account_card_overview_vip_positive 
    on core.account_card_overview (account_id, current_balance) 
    where account_tier = 'VIP' and current_balance > 0;


create table core.datamart_account_card_contract as
select * from ext_calc.account_card_contract;

COMMENT ON TABLE core.datamart_account_card_contract IS 'Витрина для теста foreign tables для dds.calc';


-------------------------------------------------
-------------------------------
create table sandbox_3.test3 as
select * from core.account_card_overview;


-- Витрина клиентов core.unified_client_directory
-- Структура: CTE (подготовка корп. клиентов + агрегаты по счетам/транзакциям)
--            -> финальный SELECT с UNION ALL из двух веток
--            -> первая ветка берет данные из CTE, вторая - напрямую из DDS-таблицы

create table core.second_unified_client_directory as

-- =============================================================
-- CTE 1: Подготовка данных по корпоративным клиентам
-- =============================================================
with corporate_enriched as (
    select
        'CORPORATE'                          as client_type,
        client_id,
        inn,
        null::varchar                        as snils,
        display_name                         as client_name,
        null::date                           as birth_date,
        company_age_days                     as age_days,
        null::varchar                        as passport_full,
        effective_address,
        phone,
        email,
        industry_cd                          as segment_cd,
        company_size_cd                      as sub_segment_cd,
        status_cd,
        0::decimal(18,2)                     as monthly_income_amt,
        null::varchar                        as income_level_cd,
        created_ts
    from ext_dds.corporate_client_detail
),

-- =============================================================
-- CTE 2: Агрегаты по счетам и транзакциям клиентов
-- (замена трех коррелирующих подзапросов одним групповым запросом)
-- =============================================================
client_aggregates as (
    select
        ad.client_id,
        count(distinct ad.account_id)        as accounts_count,
        coalesce(sum(ad.balance_amt), 0)     as total_balance_amt,
        max(td.transaction_date)             as last_transaction_date
    from ext_dds.account_detail ad
    left join ext_dds.transaction_detail td
           on td.account_id = ad.account_id
    group by ad.client_id
)

-- =============================================================
-- Финальная сборка витрины через UNION ALL
-- =============================================================
select
    -- Ветка 1: корпоративные клиенты (ВСЕ данные берутся из CTE)
    ce.client_type,
    ce.client_id,
    ce.inn,
    ce.snils,
    ce.client_name,
    ce.birth_date,
    ce.age_days,
    ce.passport_full,
    ce.effective_address,
    ce.phone,
    ce.email,
    ce.segment_cd,
    ce.sub_segment_cd,
    ce.status_cd,
    ce.monthly_income_amt,
    ce.income_level_cd,
    ce.created_ts,
    coalesce(ca.accounts_count, 0)           as accounts_count,
    coalesce(ca.total_balance_amt, 0)        as total_balance_amt,
    ca.last_transaction_date,
    current_date                             as report_date
from corporate_enriched ce
left join client_aggregates ca
       on ca.client_id = ce.client_id

union all

select
    -- Ветка 2: физические лица (данные берутся напрямую из DDS-таблицы)
    'INDIVIDUAL'                             as client_type,
    icd.client_id,
    icd.inn,
    icd.snils,
    icd.full_name                            as client_name,
    icd.birth_date,
    icd.age_days,
    icd.passport_full,
    icd.effective_address,
    icd.phone,
    icd.email,
    icd.marital_status_cd                    as segment_cd,
    icd.employment_type_cd                   as sub_segment_cd,
    icd.status_cd,
    icd.monthly_income_amt,
    icd.income_level_cd,
    icd.created_ts,
    coalesce(ca.accounts_count, 0)           as accounts_count,
    coalesce(ca.total_balance_amt, 0)        as total_balance_amt,
    ca.last_transaction_date,
    current_date                             as report_date
from ext_dds.individual_client_detail icd
left join client_aggregates ca
       on ca.client_id = icd.client_id;


-- =============================================================
-- Комментарии к таблице и колонкам
-- =============================================================
COMMENT ON TABLE core.second_unified_client_directory IS '(с CTE + UNION) Единый справочник клиентов: объединение юридических и физических лиц из DDS. Первая ветка UNION читает корп. клиентов из CTE, вторая - физлиц напрямую из DDS-таблицы. Агрегаты по счетам/транзакциям вынесены в отдельный CTE. Слой DataMart.';

COMMENT ON COLUMN core.second_unified_client_directory.client_type IS 'Тип клиента: CORPORATE (юридическое лицо) или INDIVIDUAL (физическое лицо)';
COMMENT ON COLUMN core.second_unified_client_directory.client_id IS 'Уникальный идентификатор клиента (из соответствующей DDS-таблицы)';
COMMENT ON COLUMN core.second_unified_client_directory.inn IS 'ИНН клиента';
COMMENT ON COLUMN core.second_unified_client_directory.snils IS 'СНИЛС (только для физических лиц)';
COMMENT ON COLUMN core.second_unified_client_directory.client_name IS 'Наименование клиента: название компании или ФИО';
COMMENT ON COLUMN core.second_unified_client_directory.birth_date IS 'Дата рождения (только для физических лиц)';
COMMENT ON COLUMN core.second_unified_client_directory.age_days IS 'Возраст в днях: компании (с даты регистрации) или человека (с даты рождения)';
COMMENT ON COLUMN core.second_unified_client_directory.passport_full IS 'Паспортные данные (только для физических лиц)';
COMMENT ON COLUMN core.second_unified_client_directory.effective_address IS 'Актуальный адрес: фактический (если есть) или юридический/регистрации';
COMMENT ON COLUMN core.second_unified_client_directory.phone IS 'Контактный телефон';
COMMENT ON COLUMN core.second_unified_client_directory.email IS 'Адрес электронной почты';
COMMENT ON COLUMN core.second_unified_client_directory.segment_cd IS 'Сегмент: отрасль (для юрлиц) или семейное положение (для физлиц)';
COMMENT ON COLUMN core.second_unified_client_directory.sub_segment_cd IS 'Подсегмент: размер компании (для юрлиц) или тип занятости (для физлиц)';
COMMENT ON COLUMN core.second_unified_client_directory.status_cd IS 'Статус клиента в CRM';
COMMENT ON COLUMN core.second_unified_client_directory.monthly_income_amt IS 'Ежемесячный доход (только для физических лиц, 0 для юрлиц)';
COMMENT ON COLUMN core.second_unified_client_directory.income_level_cd IS 'Уровень дохода: high/medium/low (только для физических лиц)';
COMMENT ON COLUMN core.second_unified_client_directory.created_ts IS 'Дата создания записи в ODS';
COMMENT ON COLUMN core.second_unified_client_directory.accounts_count IS 'Количество открытых счетов клиента (из CTE-агрегата)';
COMMENT ON COLUMN core.second_unified_client_directory.total_balance_amt IS 'Суммарный остаток средств на всех счетах клиента (из CTE-агрегата)';
COMMENT ON COLUMN core.second_unified_client_directory.last_transaction_date IS 'Дата последней транзакции по любому счёту клиента (из CTE-агрегата)';
COMMENT ON COLUMN core.second_unified_client_directory.report_date IS 'Дата формирования витрины';



-----------------------------------------
--OPENCODE
-----------------------------------------

-- DM-слой (medallion: gold). Создание 5 новых витрин из новых DDS-таблиц (ext_dds)
-- с джойнами на существующие детальные/справочные таблицы.
-- Запускать в БД dm с ролью, имеющей маппинг на FDW-сервер dds_server.

-- ============================================================
-- 1. Мастер витрина по менеджерам: активность менеджеров по закреплённым клиентам
--    Источники: ext_dds.manager_detail (новая) + ext_dds.client_contact_detail (новая)
-- ============================================================
DROP TABLE IF EXISTS core.manager_activity_overview;
CREATE TABLE core.manager_activity_overview AS
SELECT
    m.manager_id,
    m.manager_full_name,
    m.manager_role,
    m.branch_cd,
    m.assignment_date,
    count(DISTINCT m.client_id) AS assigned_clients_cnt,
    count(c.contact_id) AS contacts_cnt,
    count(c.contact_id) FILTER (WHERE c.contact_ts >= current_date - INTERVAL '30 days') AS contacts_last_30_days_cnt,
    count(c.contact_id) FILTER (WHERE c.result_txt IS NOT NULL) AS contacts_with_result_cnt,
    min(c.contact_ts) AS first_contact_ts,
    max(c.contact_ts) AS last_contact_ts
FROM ext_dds.manager_detail m
LEFT JOIN ext_dds.client_contact_detail c
    ON c.client_id = m.client_id
GROUP BY
    m.manager_id,
    m.manager_full_name,
    m.manager_role,
    m.branch_cd,
    m.assignment_date;

COMMENT ON TABLE core.manager_activity_overview IS
    'Витрина активности менеджеров: сводка по закреплённым клиентам и контактам. Слой DataMart для оценки работы клиентских менеджеров и нагрузки по отделениям.';
COMMENT ON COLUMN core.manager_activity_overview.manager_id IS 'Уникальный идентификатор менеджера';
COMMENT ON COLUMN core.manager_activity_overview.manager_full_name IS 'Полное ФИО менеджера';
COMMENT ON COLUMN core.manager_activity_overview.manager_role IS 'Роль менеджера (relationship_manager, premium_manager и т.д.)';
COMMENT ON COLUMN core.manager_activity_overview.branch_cd IS 'Код отделения банка';
COMMENT ON COLUMN core.manager_activity_overview.assignment_date IS 'Дата первого закрепления клиента за менеджером';
COMMENT ON COLUMN core.manager_activity_overview.assigned_clients_cnt IS 'Количество закреплённых за менеджером клиентов';
COMMENT ON COLUMN core.manager_activity_overview.contacts_cnt IS 'Всего контактов по клиентам менеджера';
COMMENT ON COLUMN core.manager_activity_overview.contacts_last_30_days_cnt IS 'Контактов за последние 30 дней';
COMMENT ON COLUMN core.manager_activity_overview.contacts_with_result_cnt IS 'Контактов с зафиксированным результатом';
COMMENT ON COLUMN core.manager_activity_overview.first_contact_ts IS 'Дата-время первого зафиксированного контакта';
COMMENT ON COLUMN core.manager_activity_overview.last_contact_ts IS 'Дата-время последнего зафиксированного контакта';

-- ============================================================
-- 2. Витрина динамики и истории остатков по счетам
--    Источники: ext_dds.account_balance_detail (новая) + ext_dds.account_detail
-- ============================================================
DROP TABLE IF EXISTS core.account_balance_dynamics;
CREATE TABLE core.account_balance_dynamics AS
SELECT
    b.account_id,
    a.account_number,
    a.account_type,
    b.currency_cd,
    b.balance_date,
    b.balance_amt,
    b.available_amt,
    b.balance_amt - b.available_amt AS blocked_amt,
    lag(b.balance_amt) OVER (PARTITION BY b.account_id ORDER BY b.balance_date) AS prev_balance_amt,
    round(
        (b.balance_amt / NULLIF(lag(b.balance_amt) OVER (PARTITION BY b.account_id ORDER BY b.balance_date), 0) - 1) * 100,
        2
    ) AS balance_change_pct,
    a.client_id,
    a.client_full_name,
    a.client_status,
    a.contract_type,
    a.account_status,
    a.open_date AS account_open_date,
    a.close_date AS account_close_date,
    a.balance_amt AS current_balance_amt
FROM ext_dds.account_balance_detail b
JOIN ext_dds.account_detail a
    ON a.account_id = b.account_id;

COMMENT ON TABLE core.account_balance_dynamics IS
    'Витрина динамики остатков по счетам: история балансов с клиентской и договорной информацией, изменение остатка между датами. Слой DataMart для анализа ликвидности и time-series.';
COMMENT ON COLUMN core.account_balance_dynamics.account_id IS 'Уникальный идентификатор счёта';
COMMENT ON COLUMN core.account_balance_dynamics.account_number IS 'Номер банковского счёта';
COMMENT ON COLUMN core.account_balance_dynamics.account_type IS 'Тип счёта (депозитный, текущий, кредитный и т.д.)';
COMMENT ON COLUMN core.account_balance_dynamics.currency_cd IS 'Код валюты счёта в формате ISO 4217';
COMMENT ON COLUMN core.account_balance_dynamics.balance_date IS 'Дата, на которую зафиксирован остаток';
COMMENT ON COLUMN core.account_balance_dynamics.balance_amt IS 'Баланс средств на счёте на дату';
COMMENT ON COLUMN core.account_balance_dynamics.available_amt IS 'Доступная сумма (с учётом заморозок и лимитов)';
COMMENT ON COLUMN core.account_balance_dynamics.blocked_amt IS 'Заблокированная сумма (баланс минус доступно)';
COMMENT ON COLUMN core.account_balance_dynamics.prev_balance_amt IS 'Остаток на предыдущую дату среза по счёту';
COMMENT ON COLUMN core.account_balance_dynamics.balance_change_pct IS 'Изменение остатка к предыдущему срезу, в процентах';
COMMENT ON COLUMN core.account_balance_dynamics.client_id IS 'Уникальный идентификатор клиента-владельца счёта';
COMMENT ON COLUMN core.account_balance_dynamics.client_full_name IS 'Полное ФИО клиента';
COMMENT ON COLUMN core.account_balance_dynamics.client_status IS 'Статус клиента в CRM';
COMMENT ON COLUMN core.account_balance_dynamics.contract_type IS 'Тип договора, к которому относится счёт';
COMMENT ON COLUMN core.account_balance_dynamics.account_status IS 'Статус счёта (active, closed, blocked и т.д.)';
COMMENT ON COLUMN core.account_balance_dynamics.account_open_date IS 'Дата открытия счёта';
COMMENT ON COLUMN core.account_balance_dynamics.account_close_date IS 'Дата закрытия счёта (NULL, если счёт активен)';
COMMENT ON COLUMN core.account_balance_dynamics.current_balance_amt IS 'Текущий остаток по счёту в детальном слое';

-- ============================================================
-- 3. Витрина платежей по картам с карточной и счетной информацией
--    Источники: ext_dds.card_payment_detail (новая) + ext_dds.card_detail + ext_dds.account_detail
-- ============================================================
DROP TABLE IF EXISTS core.card_payment_performance;
CREATE TABLE core.card_payment_performance AS
SELECT
    p.card_id,
    cd.masked_card_number,
    cd.card_system,
    cd.card_status,
    cd.validity_status,
    cd.expiry_date,
    p.account_id,
    ad.account_number,
    ad.client_id,
    ad.client_full_name,
    p.payment_date,
    p.payment_amt,
    p.principal_amt,
    p.interest_amt,
    p.debt_amt,
    p.payment_type_cd,
    row_number() OVER (PARTITION BY p.card_id ORDER BY p.payment_date DESC) AS payment_seq
FROM ext_dds.card_payment_detail p
JOIN ext_dds.card_detail cd
    ON cd.card_id = p.card_id
JOIN ext_dds.account_detail ad
    ON ad.account_id = p.account_id;

COMMENT ON TABLE core.card_payment_performance IS
    'Витрина платежей по картам: каждый платёж карты с параметрами карты, счёта и клиента. Слой DataMart для анализа платёжной дисциплины и погашения задолженности.';
COMMENT ON COLUMN core.card_payment_performance.card_id IS 'Уникальный идентификатор карты';
COMMENT ON COLUMN core.card_payment_performance.masked_card_number IS 'Маскированный номер карты в формате 6******4';
COMMENT ON COLUMN core.card_payment_performance.card_system IS 'Платёжная система карты (Visa, Mastercard, МИР и т.д.)';
COMMENT ON COLUMN core.card_payment_performance.card_status IS 'Статус карты в учётной системе';
COMMENT ON COLUMN core.card_payment_performance.validity_status IS 'Вычисляемый статус валидности карты (expired, valid, invalid)';
COMMENT ON COLUMN core.card_payment_performance.expiry_date IS 'Дата окончания срока действия карты';
COMMENT ON COLUMN core.card_payment_performance.account_id IS 'Уникальный идентификатор счёта карты';
COMMENT ON COLUMN core.card_payment_performance.account_number IS 'Номер банковского счёта карты';
COMMENT ON COLUMN core.card_payment_performance.client_id IS 'Уникальный идентификатор клиента-держателя карты';
COMMENT ON COLUMN core.card_payment_performance.client_full_name IS 'Полное ФИО клиента';
COMMENT ON COLUMN core.card_payment_performance.payment_date IS 'Дата совершения платежа';
COMMENT ON COLUMN core.card_payment_performance.payment_amt IS 'Сумма платежа';
COMMENT ON COLUMN core.card_payment_performance.principal_amt IS 'Сумма в погашение основного долга';
COMMENT ON COLUMN core.card_payment_performance.interest_amt IS 'Сумма в погашение процентов';
COMMENT ON COLUMN core.card_payment_performance.debt_amt IS 'Остаток задолженности после платежа';
COMMENT ON COLUMN core.card_payment_performance.payment_type_cd IS 'Тип платежа (scheduled, early, final и т.д.)';
COMMENT ON COLUMN core.card_payment_performance.payment_seq IS 'Порядковый номер платежа карты от последнего (1 — самый свежий)';

-- ============================================================
-- 4. Витрина вовлечённости клиентов по контактам с профилем и менеджером
--    Источники: ext_dds.client_contact_detail (новая) + ext_dds.client_account_profile + ext_dds.manager_detail (новая)
-- ============================================================
DROP TABLE IF EXISTS core.client_contact_engagement;
CREATE TABLE core.client_contact_engagement AS
SELECT
    cc.client_id,
    p.client_full_name,
    p.client_status,
    p.client_city,
    m.manager_full_name,
    m.manager_role,
    count(cc.contact_id) AS total_contacts_cnt,
    count(cc.contact_id) FILTER (WHERE cc.contact_type_cd = 'incoming_call') AS incoming_calls_cnt,
    count(cc.contact_id) FILTER (WHERE cc.contact_type_cd = 'outgoing_call') AS outgoing_calls_cnt,
    count(DISTINCT cc.channel_cd) AS channels_cnt,
    min(cc.contact_ts) AS first_contact_ts,
    max(cc.contact_ts) AS last_contact_ts
FROM ext_dds.client_contact_detail cc
JOIN ext_dds.manager_detail m
    ON m.client_id = cc.client_id
LEFT JOIN LATERAL (
    SELECT
        client_full_name,
        client_status,
        client_city
    FROM ext_dds.client_account_profile
    WHERE client_id = cc.client_id
    LIMIT 1
) p ON TRUE
GROUP BY
    cc.client_id,
    p.client_full_name,
    p.client_status,
    p.client_city,
    m.manager_full_name,
    m.manager_role;

COMMENT ON TABLE core.client_contact_engagement IS
    'Витрина вовлечённости клиентов: агрегация контактов по клиенту с профилем и ведущим менеджером. Слой DataMart для анализа обслуживания и качества клиентского сервиса.';
COMMENT ON COLUMN core.client_contact_engagement.client_id IS 'Уникальный идентификатор клиента';
COMMENT ON COLUMN core.client_contact_engagement.client_full_name IS 'Полное ФИО клиента';
COMMENT ON COLUMN core.client_contact_engagement.client_status IS 'Статус клиента в CRM (active, inactive, blocked и т.д.)';
COMMENT ON COLUMN core.client_contact_engagement.client_city IS 'Город клиента по актуальному адресу';
COMMENT ON COLUMN core.client_contact_engagement.manager_full_name IS 'Полное ФИО менеджера клиента';
COMMENT ON COLUMN core.client_contact_engagement.manager_role IS 'Роль менеджера';
COMMENT ON COLUMN core.client_contact_engagement.total_contacts_cnt IS 'Всего контактов с клиентом';
COMMENT ON COLUMN core.client_contact_engagement.incoming_calls_cnt IS 'Количество входящих звонков от клиента';
COMMENT ON COLUMN core.client_contact_engagement.outgoing_calls_cnt IS 'Количество исходящих звонков клиенту';
COMMENT ON COLUMN core.client_contact_engagement.channels_cnt IS 'Количество использованных каналов контакта';
COMMENT ON COLUMN core.client_contact_engagement.first_contact_ts IS 'Дата-время первого контакта';
COMMENT ON COLUMN core.client_contact_engagement.last_contact_ts IS 'Дата-время последнего контакта';

-- ============================================================
-- 5. Витрина залогового обеспечения корпоративных кредитов (аналитика рисков)
--    Источник: ext_dds.collateral_detail (новая)
-- ============================================================
DROP TABLE IF EXISTS core.collateral_risk_analysis;
CREATE TABLE core.collateral_risk_analysis AS
SELECT
    collateral_type_cd,
    insured_flg,
    count(*) AS collateral_cnt,
    count(DISTINCT credit_id) AS credits_cnt,
    sum(collateral_value_amt) AS total_value_amt,
    round(avg(collateral_value_amt), 2) AS avg_value_amt,
    min(appraisal_date) AS first_appraisal_date,
    max(appraisal_date) AS last_appraisal_date
FROM ext_dds.collateral_detail
GROUP BY
    collateral_type_cd,
    insured_flg;

COMMENT ON TABLE core.collateral_risk_analysis IS
    'Витрина залогового обеспечения по корпоративным кредитам: агрегация залогов по типу и страховке. Слой DataMart для анализа обеспеченности кредитного портфеля.';
COMMENT ON COLUMN core.collateral_risk_analysis.collateral_type_cd IS 'Тип залога (real_estate, equipment, vehicle и т.д.)';
COMMENT ON COLUMN core.collateral_risk_analysis.insured_flg IS 'Признак наличия страховки предмета залога';
COMMENT ON COLUMN core.collateral_risk_analysis.collateral_cnt IS 'Количество залогов в группе';
COMMENT ON COLUMN core.collateral_risk_analysis.credits_cnt IS 'Количество кредитных договоров, обеспеченных залогами группы';
COMMENT ON COLUMN core.collateral_risk_analysis.total_value_amt IS 'Совокупная оценочная стоимость залогов';
COMMENT ON COLUMN core.collateral_risk_analysis.avg_value_amt IS 'Средняя оценочная стоимость залога в группе';
COMMENT ON COLUMN core.collateral_risk_analysis.first_appraisal_date IS 'Самая ранняя дата оценки залогов группы';
COMMENT ON COLUMN core.collateral_risk_analysis.last_appraisal_date IS 'Самая поздняя дата оценки залогов группы';



-- DM-слой (medallion: gold). Master-витрина с большим количеством джойнов (18):
-- объединяет ключевые детальные, внешние и существующие витрины dm в одну широкую.
-- Запускать в БД dm после создания витрин из dm_seed_datamarts_from_dds.sql.
-- Роль должна иметь маппинг на FDW-сервер dds_server.

DROP TABLE IF EXISTS core.master_wide_join;
CREATE TABLE core.master_wide_join AS
SELECT
    -- базовая детальная информация по счёту
    ad.account_id,
    ad.account_number,
    ad.account_type,
    ad.currency_cd,
    ad.open_date,
    ad.close_date,
    ad.balance_amt AS current_balance_amt,
    ad.account_status,
    ad.contract_id,
    ad.contract_type,
    ad.interest_rate,
    ad.contract_status,
    ad.client_id,
    ad.client_full_name,
    ad.client_status,

    -- транзакции по счёту
    td.transaction_id,
    td.transaction_date,
    td.transaction_ts,
    td.transaction_type,
    td.amount_amt,
    td.channel_cd AS trx_channel_cd,
    td.transaction_status,
    td.operation_category,

    -- карта счёта
    cd.card_id,
    cd.masked_card_number,
    cd.card_system,
    cd.validity_status,
    cd.expiry_date,

    -- платежи по карте
    cpd.payment_id,
    cpd.payment_date,
    cpd.payment_amt,
    cpd.debt_amt,

    -- история остатков
    abd.balance_date,
    abd.balance_amt AS history_balance_amt,
    abd.available_amt,

    -- клиентский профиль
    cap.active_passport,
    cap.client_city,
    cap.address_type,

    -- менеджер и контакты
    mgr.manager_id,
    mgr.manager_full_name,
    mgr.manager_role,
    mgr.branch_cd,
    ccd.contact_id,
    ccd.contact_ts,
    ccd.contact_type_cd,
    ccd.subject_txt,

    -- индивидуальный и корпоративный профиль
    ind.full_name AS individual_full_name,
    ind.marital_status_cd,
    ind.monthly_income_amt,
    ind.income_level_cd,
    corp.inn AS corp_inn,
    corp.company_name,
    corp.industry_cd,
    corp.company_size_cd,

    -- лизинг (через ИНН корпоративного клиента)
    ld.leasing_id,
    ld.contract_number AS leasing_contract_number,
    ld.object_type_cd,
    ld.object_cost_amt,
    ld.contract_status_cd AS leasing_status,

    -- мастер-партия (связанные данные счёт/клиент/карта)
    map.party_type,
    map.total_trx_count AS map_trx_count,
    map.total_debit_amt AS map_debit_amt,
    map.total_credit_amt AS map_credit_amt,
    map2.total_trx_count AS map2_trx_count,

    -- карта+договор (ext_calc)
    acc.card_id AS acc_card_id,
    acc.card_system AS acc_card_system,
    acc.issue_date AS acc_card_issue_date,

    -- риск-аналитика по карте (dm.core)
    cra.risk_level,
    cra.trx_count_30d,
    cra.used_channels AS cra_channels,

    -- поведение клиента (dm.core)
    cbs.total_trx_count AS cbs_trx_count,
    cbs.total_credit_amt AS cbs_credit_amt,
    cbs.total_debit_amt AS cbs_debit_amt,
    cbs.last_transaction_date AS cbs_last_trx_date,

    -- ежедневные срезы по счёту (dm.core)
    das.report_date::date AS snapshot_report_date,
    das.is_active_on_date,
    das.date_type AS snapshot_date_type,

    -- сводка счёт+карта (dm.core)
    aco.account_tier,
    aco.product_bundle,
    aco.current_balance AS aco_current_balance,
    aco.days_to_expiry,

    -- дубль account_detail (для проверки связи витрин)
    v.account_age_days AS v_account_age_days

FROM ext_dds.account_detail ad
LEFT JOIN ext_dds.transaction_detail td        ON td.account_id = ad.account_id
LEFT JOIN ext_dds.card_detail cd               ON cd.account_id = ad.account_id
LEFT JOIN ext_dds.card_payment_detail cpd      ON cpd.card_id = cd.card_id
LEFT JOIN ext_dds.account_balance_detail abd   ON abd.account_id = ad.account_id
LEFT JOIN ext_dds.client_account_profile cap   ON cap.account_id = ad.account_id
LEFT JOIN ext_dds.manager_detail mgr           ON mgr.client_id = ad.client_id
LEFT JOIN ext_dds.client_contact_detail ccd    ON ccd.client_id = ad.client_id
LEFT JOIN ext_dds.individual_client_detail ind ON ind.client_id = ad.client_id::int
LEFT JOIN ext_dds.corporate_client_detail corp ON corp.client_id = ad.client_id::int
LEFT JOIN ext_dds.leasing_detail ld            ON ld.lessee_inn = corp.inn
LEFT JOIN ext_dds.master_account_party map     ON map.account_id = ad.account_id
LEFT JOIN ext_dds.master_account_party_2 map2  ON map2.account_id = ad.account_id
LEFT JOIN ext_calc.account_card_contract acc   ON acc.account_id = ad.account_id
LEFT JOIN core.card_risk_analysis cra          ON cra.card_id = cd.card_id
LEFT JOIN core.client_behavior_summary cbs     ON cbs.client_id = ad.client_id
LEFT JOIN core.daily_account_snapshot das      ON das.account_id = ad.account_id
LEFT JOIN core.account_card_overview aco       ON aco.account_id = ad.account_id AND aco.card_id = cd.card_id
LEFT JOIN ext_dds.v_test_account_detail v      ON v.account_id = ad.account_id;

COMMENT ON TABLE core.master_wide_join IS
    'Master-витрина с большим числом джойнов (18): счёт, транзакции, карты, платежи по картам, остатки, профиль клиента, менеджеры, контакты, индивидуальный/корпоративный профиль, лизинг, мастер-партии, карта+договор, риск-аналитика по картам, поведение клиента, ежедневные срезы и сводка счёт+карта. Слой DataMart для комплексного анализа клиента и счёта.';
COMMENT ON COLUMN core.master_wide_join.account_id IS 'Уникальный идентификатор счёта';
COMMENT ON COLUMN core.master_wide_join.account_number IS 'Номер банковского счёта';
COMMENT ON COLUMN core.master_wide_join.account_type IS 'Тип счёта (депозитный, текущий, кредитный и т.д.)';
COMMENT ON COLUMN core.master_wide_join.currency_cd IS 'Код валюты счёта в формате ISO 4217';
COMMENT ON COLUMN core.master_wide_join.open_date IS 'Дата открытия счёта';
COMMENT ON COLUMN core.master_wide_join.close_date IS 'Дата закрытия счёта (NULL, если счёт активен)';
COMMENT ON COLUMN core.master_wide_join.current_balance_amt IS 'Текущий остаток средств на счёте';
COMMENT ON COLUMN core.master_wide_join.account_status IS 'Статус счёта (active, closed, blocked и т.д.)';
COMMENT ON COLUMN core.master_wide_join.contract_id IS 'Идентификатор договора счёта';
COMMENT ON COLUMN core.master_wide_join.contract_type IS 'Тип договора';
COMMENT ON COLUMN core.master_wide_join.interest_rate IS 'Процентная ставка по договору (годовых)';
COMMENT ON COLUMN core.master_wide_join.contract_status IS 'Статус договора';
COMMENT ON COLUMN core.master_wide_join.client_id IS 'Уникальный идентификатор клиента-владельца счёта';
COMMENT ON COLUMN core.master_wide_join.client_full_name IS 'Полное ФИО клиента';
COMMENT ON COLUMN core.master_wide_join.client_status IS 'Статус клиента в CRM';
COMMENT ON COLUMN core.master_wide_join.transaction_id IS 'Уникальный идентификатор транзакции';
COMMENT ON COLUMN core.master_wide_join.transaction_date IS 'Дата транзакции';
COMMENT ON COLUMN core.master_wide_join.transaction_ts IS 'Дата-время транзакции';
COMMENT ON COLUMN core.master_wide_join.transaction_type IS 'Тип транзакции (credit, debit)';
COMMENT ON COLUMN core.master_wide_join.amount_amt IS 'Сумма транзакции';
COMMENT ON COLUMN core.master_wide_join.trx_channel_cd IS 'Канал совершения транзакции';
COMMENT ON COLUMN core.master_wide_join.transaction_status IS 'Статус транзакции';
COMMENT ON COLUMN core.master_wide_join.operation_category IS 'Категория операции';
COMMENT ON COLUMN core.master_wide_join.card_id IS 'Уникальный идентификатор карты';
COMMENT ON COLUMN core.master_wide_join.masked_card_number IS 'Маскированный номер карты 6******4';
COMMENT ON COLUMN core.master_wide_join.card_system IS 'Платёжная система карты';
COMMENT ON COLUMN core.master_wide_join.validity_status IS 'Статус валидности карты (expired, valid, invalid)';
COMMENT ON COLUMN core.master_wide_join.expiry_date IS 'Дата окончания действия карты';
COMMENT ON COLUMN core.master_wide_join.payment_id IS 'Идентификатор платежа по карте';
COMMENT ON COLUMN core.master_wide_join.payment_date IS 'Дата платежа по карте';
COMMENT ON COLUMN core.master_wide_join.payment_amt IS 'Сумма платежа по карте';
COMMENT ON COLUMN core.master_wide_join.debt_amt IS 'Остаток задолженности после платежа';
COMMENT ON COLUMN core.master_wide_join.balance_date IS 'Дата среза остатков';
COMMENT ON COLUMN core.master_wide_join.history_balance_amt IS 'Баланс на дату среза';
COMMENT ON COLUMN core.master_wide_join.available_amt IS 'Доступная сумма на дату среза';
COMMENT ON COLUMN core.master_wide_join.active_passport IS 'Активный паспорт клиента';
COMMENT ON COLUMN core.master_wide_join.client_city IS 'Город клиента';
COMMENT ON COLUMN core.master_wide_join.address_type IS 'Тип адреса клиента';
COMMENT ON COLUMN core.master_wide_join.manager_id IS 'Идентификатор менеджера клиента';
COMMENT ON COLUMN core.master_wide_join.manager_full_name IS 'Полное ФИО менеджера';
COMMENT ON COLUMN core.master_wide_join.manager_role IS 'Роль менеджера';
COMMENT ON COLUMN core.master_wide_join.branch_cd IS 'Код отделения банка';
COMMENT ON COLUMN core.master_wide_join.contact_id IS 'Идентификатор контакта с клиентом';
COMMENT ON COLUMN core.master_wide_join.contact_ts IS 'Дата-время контакта';
COMMENT ON COLUMN core.master_wide_join.contact_type_cd IS 'Тип контакта';
COMMENT ON COLUMN core.master_wide_join.subject_txt IS 'Тема/суть контакта';
COMMENT ON COLUMN core.master_wide_join.individual_full_name IS 'ФИО из индивидуального профиля';
COMMENT ON COLUMN core.master_wide_join.marital_status_cd IS 'Семейное положение';
COMMENT ON COLUMN core.master_wide_join.monthly_income_amt IS 'Ежемесячный доход клиента';
COMMENT ON COLUMN core.master_wide_join.income_level_cd IS 'Уровень дохода';
COMMENT ON COLUMN core.master_wide_join.corp_inn IS 'ИНН корпоративного клиента';
COMMENT ON COLUMN core.master_wide_join.company_name IS 'Наименование компании';
COMMENT ON COLUMN core.master_wide_join.industry_cd IS 'Отрасль компании';
COMMENT ON COLUMN core.master_wide_join.company_size_cd IS 'Размер компании';
COMMENT ON COLUMN core.master_wide_join.leasing_id IS 'Идентификатор лизингового договора';
COMMENT ON COLUMN core.master_wide_join.leasing_contract_number IS 'Номер лизингового договора';
COMMENT ON COLUMN core.master_wide_join.object_type_cd IS 'Тип предмета лизинга';
COMMENT ON COLUMN core.master_wide_join.object_cost_amt IS 'Стоимость предмета лизинга';
COMMENT ON COLUMN core.master_wide_join.leasing_status IS 'Статус лизингового договора';
COMMENT ON COLUMN core.master_wide_join.party_type IS 'Тип партии в мастер-документе';
COMMENT ON COLUMN core.master_wide_join.map_trx_count IS 'Число транзакций (мастер-партия)';
COMMENT ON COLUMN core.master_wide_join.map_debit_amt IS 'Обороты по дебету (мастер-партия)';
COMMENT ON COLUMN core.master_wide_join.map_credit_amt IS 'Обороты по кредиту (мастер-партия)';
COMMENT ON COLUMN core.master_wide_join.map2_trx_count IS 'Число транзакций (мастер-партия-2)';
COMMENT ON COLUMN core.master_wide_join.acc_card_id IS 'Идентификатор карты из витрины карта+договор';
COMMENT ON COLUMN core.master_wide_join.acc_card_system IS 'Платёжная система карты (карта+договор)';
COMMENT ON COLUMN core.master_wide_join.acc_card_issue_date IS 'Дата выпуска карты (карта+договор)';
COMMENT ON COLUMN core.master_wide_join.risk_level IS 'Уровень риска по карте';
COMMENT ON COLUMN core.master_wide_join.trx_count_30d IS 'Число транзакций за 30 дней';
COMMENT ON COLUMN core.master_wide_join.cra_channels IS 'Используемые каналы (риск-аналитика)';
COMMENT ON COLUMN core.master_wide_join.cbs_trx_count IS 'Всего транзакций клиента (поведение)';
COMMENT ON COLUMN core.master_wide_join.cbs_credit_amt IS 'Сумма поступлений клиента (поведение)';
COMMENT ON COLUMN core.master_wide_join.cbs_debit_amt IS 'Сумма списаний клиента (поведение)';
COMMENT ON COLUMN core.master_wide_join.cbs_last_trx_date IS 'Дата последней транзакции клиента (поведение)';
COMMENT ON COLUMN core.master_wide_join.snapshot_report_date IS 'Дата отчёта ежедневного среза';
COMMENT ON COLUMN core.master_wide_join.is_active_on_date IS 'Признак активности счёта на дату среза';
COMMENT ON COLUMN core.master_wide_join.snapshot_date_type IS 'Тип даты среза (календарный день)';
COMMENT ON COLUMN core.master_wide_join.account_tier IS 'Тир счёта (сводка счёт+карта)';
COMMENT ON COLUMN core.master_wide_join.product_bundle IS 'Продуктовый пакет счёта';
COMMENT ON COLUMN core.master_wide_join.aco_current_balance IS 'Текущий баланс счёта (сводка счёт+карта)';
COMMENT ON COLUMN core.master_wide_join.days_to_expiry IS 'Дней до истечения карты';
COMMENT ON COLUMN core.master_wide_join.v_account_age_days IS 'Возраст счёта в днях (из дубля account_detail)';

-- ============================================================================
-- Таблица public.sql_inventory и регистрация SQL-трансформаций
-- Используется генератором Data Catalog (sql_loader.py) для построения lineage.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.sql_inventory (
    target_schema text NOT NULL,
    target_table text NOT NULL,
    query_text text,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (target_schema, target_table)
);

DELETE FROM public.sql_inventory;

INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'account_activity', $$create table core.account_activity as
select
    t.transaction_id, --ID Транзакции /*Дата Транзакции*/
    t.transaction_date, /*Дата Транзакции*/
    t.transaction_ts,
    null as null_test_column,
    a.client_id --ID Транзакции /*Дата Транзакции*/
    ,a.client_full_name,
    a.contract_id,
    a.contract_number,
    a.contract_type,
    a.account_id,
    a.account_number,
    a.account_type,
    a.currency_cd,
    t.transaction_type,
    t.amount_amt,
    t.signed_amount_amt,
    t.operation_category,
    t.channel_cd,
    t.transaction_status,
    coalesce(
        t.merchant_name,
        a.client_full_name || ' / ' || a.contract_number
    ) as operation_context,
    coalesce(
        t.description_txt,
        t.operation_category || ' for ' || a.account_type
    ) as operation_details,
    a.balance_amt as current_balance_amt,
    a.interest_rate
from ext_dds.transaction_detail t
join ext_dds.account_detail a
    on a.account_id = t.account_id$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'account_balance_dynamics', $$CREATE TABLE core.account_balance_dynamics AS
SELECT
    b.account_id,
    a.account_number,
    a.account_type,
    b.currency_cd,
    b.balance_date,
    b.balance_amt,
    b.available_amt,
    b.balance_amt - b.available_amt AS blocked_amt,
    lag(b.balance_amt) OVER (PARTITION BY b.account_id ORDER BY b.balance_date) AS prev_balance_amt,
    round(
        (b.balance_amt / NULLIF(lag(b.balance_amt) OVER (PARTITION BY b.account_id ORDER BY b.balance_date), 0) - 1) * 100,
        2
    ) AS balance_change_pct,
    a.client_id,
    a.client_full_name,
    a.client_status,
    a.contract_type,
    a.account_status,
    a.open_date AS account_open_date,
    a.close_date AS account_close_date,
    a.balance_amt AS current_balance_amt
FROM ext_dds.account_balance_detail b
JOIN ext_dds.account_detail a
    ON a.account_id = b.account_id$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'account_card_overview', $$--витрина без комментариев
create table dm.core.account_card_overview as (
select
    ad.account_id,
    ad.account_number,
    ad.account_type,
    ad.currency_cd,
    cd.card_id,
    cd.card_system,
    cap.address_type,
    
    ad.client_full_name as client_name,
    cap.client_city as city_name,
    cap.active_passport as passport,
    ad.contract_number as agreement_num,
    ad.contract_type as agreement_type,
    ad.balance_amt as current_balance,
    ad.interest_rate as annual_rate_pct,
    
    current_date - ad.open_date as account_age_days,
    cd.expiry_date - current_date as days_to_expiry,
    round(ad.balance_amt * ad.interest_rate / 100 / 12, 2) as monthly_interest_amt,
    case 
        when ad.balance_amt >= 100000 then 'VIP' 
        when ad.balance_amt >= 10000 then 'Gold' 
        else 'Standard' 
    end as account_tier,
    concat_ws(' | ', ad.account_type, ad.currency_cd, cd.card_system) as product_bundle,
    case when cd.validity_status = 'valid' then 1 else 0 end as is_card_valid_flag
from ext_dds.account_detail ad
join ext_dds.card_detail cd 
    on cd.account_id = ad.account_id
left join ext_dds.client_account_profile cap 
    on cap.account_id = ad.account_id)$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'card_payment_performance', $$CREATE TABLE core.card_payment_performance AS
SELECT
    p.card_id,
    cd.masked_card_number,
    cd.card_system,
    cd.card_status,
    cd.validity_status,
    cd.expiry_date,
    p.account_id,
    ad.account_number,
    ad.client_id,
    ad.client_full_name,
    p.payment_date,
    p.payment_amt,
    p.principal_amt,
    p.interest_amt,
    p.debt_amt,
    p.payment_type_cd,
    row_number() OVER (PARTITION BY p.card_id ORDER BY p.payment_date DESC) AS payment_seq
FROM ext_dds.card_payment_detail p
JOIN ext_dds.card_detail cd
    ON cd.card_id = p.card_id
JOIN ext_dds.account_detail ad
    ON ad.account_id = p.account_id$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'card_risk_analysis', $$create table core.card_risk_analysis as
select
    cd.card_id,
    cd.masked_card_number,
    cd.card_system,
    cd.issue_date,
    cd.expiry_date,
    cd.validity_status,
    aap.account_id,
    aap.account_number,
    aap.account_type,
    aap.currency_cd,
    aap.client_id,
    aap.client_full_name,
    cbs.client_city,
    cbs.active_passport,
    aap.contract_id,
    aap.contract_number,
    aap.contract_type,
    aap.interest_rate,
    -- Подзапрос: количество транзакций по счёту за последние 30 дней
    (
        select count(*)
        from ext_dds.transaction_detail td
        where td.account_id = cd.account_id
          and td.transaction_date >= current_date - interval '30 days'
    ) as trx_count_30d,
    -- Подзапрос: сумма списаний за последние 30 дней
    (
        select coalesce(sum(td.amount_amt), 0)
        from ext_dds.transaction_detail td
        where td.account_id = cd.account_id
          and td.transaction_type = 'debit'
          and td.transaction_date >= current_date - interval '30 days'
    ) as debit_sum_30d,
    -- Подзапрос: сумма зачислений за последние 30 дней
    (
        select coalesce(sum(td.amount_amt), 0)
        from ext_dds.transaction_detail td
        where td.account_id = cd.account_id
          and td.transaction_type = 'credit'
          and td.transaction_date >= current_date - interval '30 days'
    ) as credit_sum_30d,
    -- Подзапрос: количество уникальных мерчантов за последние 30 дней
    (
        select count(distinct td.merchant_name)
        from ext_dds.transaction_detail td
        where td.account_id = cd.account_id
          and td.transaction_date >= current_date - interval '30 days'
          and td.merchant_name is not null
    ) as unique_merchants_30d,
    -- Подзапрос: дата последней транзакции по счёту
    (
        select max(td.transaction_date)
        from ext_dds.transaction_detail td
        where td.account_id = cd.account_id
    ) as last_trx_date,
    -- Подзапрос: наиболее частый канал операций
    (
        select td.channel_cd
        from ext_dds.transaction_detail td
        where td.account_id = cd.account_id
        group by td.channel_cd
        order by count(*) desc
        limit 1
    ) as top_channel,
    -- Данные из витрины core.client_behavior_summary
    cbs.total_trx_count,
    cbs.total_credit_amt,
    cbs.total_debit_amt,
    cbs.last_transaction_date as client_last_trx_date,
    cbs.used_channels,
    -- Расчётные риск-метрики
    case
        when cd.validity_status = 'expired' then 'high'
        when cd.validity_status = 'invalid' then 'high'
        when (
            select count(*)
            from ext_dds.transaction_detail td
            where td.account_id = cd.account_id
              and td.transaction_date >= current_date - interval '30 days'
        ) > 100 then 'medium'
        when (
            select coalesce(sum(td.amount_amt), 0)
            from ext_dds.transaction_detail td
            where td.account_id = cd.account_id
              and td.transaction_type = 'debit'
              and td.transaction_date >= current_date - interval '30 days'
        ) > aap.balance_amt * 0.5 then 'medium'
        else 'low'
    end as risk_level,
    current_date as report_date
from ext_dds.card_detail cd
join ext_dds.account_detail aap
    on aap.account_id = cd.account_id
left join core.client_behavior_summary cbs
    on cbs.client_id = aap.client_id$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'client_behavior_summary', $$create table core.client_behavior_summary as
select
    cap.client_id,
    cap.client_full_name,
    cap.client_city,
    cap.active_passport,
    count(td.transaction_id) as total_trx_count,
    sum(case when td.transaction_type = 'credit' then td.amount_amt else 0 end) as total_credit_amt,
    sum(case when td.transaction_type = 'debit' then td.amount_amt else 0 end) as total_debit_amt,
    max(td.transaction_date) as last_transaction_date,
    string_agg(distinct td.channel_cd, ', ') as used_channels
from ext_dds.client_account_profile cap
left join ext_dds.transaction_detail td
    on cap.account_id = td.account_id
group by
    cap.client_id,
    cap.client_full_name,
    cap.client_city,
    cap.active_passport$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'client_contact_engagement', $$CREATE TABLE core.client_contact_engagement AS
SELECT
    cc.client_id,
    p.client_full_name,
    p.client_status,
    p.client_city,
    m.manager_full_name,
    m.manager_role,
    count(cc.contact_id) AS total_contacts_cnt,
    count(cc.contact_id) FILTER (WHERE cc.contact_type_cd = 'incoming_call') AS incoming_calls_cnt,
    count(cc.contact_id) FILTER (WHERE cc.contact_type_cd = 'outgoing_call') AS outgoing_calls_cnt,
    count(DISTINCT cc.channel_cd) AS channels_cnt,
    min(cc.contact_ts) AS first_contact_ts,
    max(cc.contact_ts) AS last_contact_ts
FROM ext_dds.client_contact_detail cc
JOIN ext_dds.manager_detail m
    ON m.client_id = cc.client_id
LEFT JOIN LATERAL (
    SELECT
        client_full_name,
        client_status,
        client_city
    FROM ext_dds.client_account_profile
    WHERE client_id = cc.client_id
    LIMIT 1
) p ON TRUE
GROUP BY
    cc.client_id,
    p.client_full_name,
    p.client_status,
    p.client_city,
    m.manager_full_name,
    m.manager_role$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'client_revenue_potential', $$-- ==================== Создание витрины dm.core.client_revenue_potential ====================
--Таблица с CTE With
create table dm.core.client_revenue_potential as
with monthly_turnover as (
    -- Помесячная агрегация транзакций по каждому счёту
    select 
        account_id,
        date_trunc('month', transaction_date) as trx_month,
        sum(case when transaction_type = 'credit' then amount_amt else 0 end) as monthly_inflow,
        sum(case when transaction_type = 'debit' then amount_amt else 0 end) as monthly_outflow,
        count(*) as monthly_trx_count,
        count(distinct channel_cd) as monthly_channels
    from ext_dds.transaction_detail
    group by account_id, date_trunc('month', transaction_date)
),
account_stats as (
    -- Сводная статистика по счёту на основе помесячных оборотов
    select 
        account_id,
        avg(monthly_inflow) as avg_monthly_inflow,
        avg(monthly_outflow) as avg_monthly_outflow,
        max(monthly_trx_count) as peak_monthly_trx,
        sum(monthly_inflow) as total_inflow,
        sum(monthly_outflow) as total_outflow,
        count(distinct trx_month) as active_months,
        max(trx_month) as last_active_month,
        '2' as constant_column
    from monthly_turnover
    group by account_id
)
select
    cap.client_id,
    ast.constant_column,
    cap.client_full_name,
    cap.client_city,
    cap.active_passport,
    cap.address_type,
    ad.account_id,
    ad.account_number,
    ad.account_type,
    ad.currency_cd,
    ad.open_date,
    ad.balance_amt,
    ad.interest_rate,
    ad.account_status,
    coalesce(ast.avg_monthly_inflow, 0) as avg_monthly_inflow,
    coalesce(ast.avg_monthly_outflow, 0) as avg_monthly_outflow,
    ast.peak_monthly_trx,
    coalesce(ast.total_inflow, 0) as total_inflow,
    coalesce(ast.total_outflow, 0) as total_outflow,
    coalesce(ast.active_months, 0) as active_months,
    ast.last_active_month,
    case 
        when coalesce(ast.avg_monthly_inflow, 0) > 1000000 then 'premium'
        when coalesce(ast.avg_monthly_inflow, 0) > 100000 then 'gold'
        else 'standard'
    end as client_segment,
    case
        when ad.balance_amt > 0 and coalesce(ast.avg_monthly_outflow, 0) > ad.balance_amt * 2 then 'over spender'
        when coalesce(ast.avg_monthly_inflow, 0) > coalesce(ast.avg_monthly_outflow, 0) then 'saver'
        else 'neutral'
    end as financial_behavior,
    current_date as report_date
from ext_dds.client_account_profile cap
join ext_dds.account_detail ad 
    on ad.account_id = cap.account_id
left join account_stats ast 
    on ast.account_id = ad.account_id$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'client_scoring_model', $$-- ==================== Создание витрины dm.core.client_scoring_model ====================
--Витрина и с CTE With и с подзапросами
create table dm.core.client_scoring_model as
with revenue_metrics as (
    -- CTE: агрегация выручечных метрик по клиенту из витрины dm.core.client_revenue_potential
    select 
        client_id,
        sum(total_inflow) as lifetime_inflow,
        sum(total_outflow) as lifetime_outflow,
        max(client_segment) as best_segment,
        count(*) as accounts_count,
        sum(balance_amt) as total_balance,
        max(last_active_month) as last_revenue_month
    from dm.core.client_revenue_potential
    group by client_id
)
select
    cap.client_id,
    cap.client_full_name,
    cap.client_city,
    cap.active_passport,
    cap.address_type,
    
    -- Данные из dm.core.client_behavior_summary
    cbs.total_trx_count,
    cbs.total_credit_amt,
    cbs.total_debit_amt,
    cbs.last_transaction_date,
    cbs.used_channels,
    
    -- Данные из CTE revenue_metrics
    rm.lifetime_inflow,
    rm.lifetime_outflow,
    rm.best_segment,
    rm.accounts_count,
    rm.total_balance,
    rm.last_revenue_month,
    
    -- Подзапрос 1: количество премиальных счетов клиента
    (
        select count(*)
        from dm.core.client_revenue_potential crp2
        where crp2.client_id = cap.client_id
          and crp2.client_segment = 'premium'
    ) as premium_accounts_count,
    
    -- Подзапрос 2: максимальный пик транзакций в месяц по всем счетам клиента
    (
        select max(peak_monthly_trx)
        from dm.core.client_revenue_potential crp3
        where crp3.client_id = cap.client_id
    ) as max_peak_monthly_trx,
    
    -- Расчётное поле: дней с последней транзакции
    current_date - cbs.last_transaction_date as days_since_last_trx,
    
    -- Скоринговая оценка поведения (0–100)
    case
        when rm.best_segment = 'premium' and cbs.total_trx_count > 500 then 100
        when rm.best_segment = 'gold' and cbs.total_trx_count > 100 then 80
        when rm.best_segment = 'standard' and cbs.total_trx_count > 50 then 60
        else 30
    end as behavior_score,
    
    -- Класс благосостояния
    case
        when rm.total_balance > 1000000 then 'A'
        when rm.total_balance > 100000 then 'B'
        when rm.total_balance > 10000 then 'C'
        else 'D'
    end as wealth_grade,
    
    current_date as report_date
from ext_dds.client_account_profile cap
left join dm.core.client_behavior_summary cbs 
    on cbs.client_id = cap.client_id
left join revenue_metrics rm 
    on rm.client_id = cap.client_id$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'collateral_risk_analysis', $$CREATE TABLE core.collateral_risk_analysis AS
SELECT
    collateral_type_cd,
    insured_flg,
    count(*) AS collateral_cnt,
    count(DISTINCT credit_id) AS credits_cnt,
    sum(collateral_value_amt) AS total_value_amt,
    round(avg(collateral_value_amt), 2) AS avg_value_amt,
    min(appraisal_date) AS first_appraisal_date,
    max(appraisal_date) AS last_appraisal_date
FROM ext_dds.collateral_detail
GROUP BY
    collateral_type_cd,
    insured_flg;$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'daily_account_risk_monitor', $$--сложная витрина
create table dm.core.daily_account_risk_monitor as
with account_calendar as (
    -- CTE 1: дневные срезы через generate_series для каждого счёта
    select
        a.account_id,
        a.account_number,
        a.client_id,
        a.account_type,
        a.currency_cd,
        a.balance_amt as current_balance,
        a.open_date,
        a.close_date,
        report_date
    from ext_dds.account_detail a
    cross join lateral generate_series(
        a.open_date,
        coalesce(a.close_date, current_date),
        interval '1 day'
    ) as report_date
),
daily_flows as (
    -- CTE 2: ежедневные обороты по счёту (алиас "a" совпадает с CTE1)
    select
        a.account_id,
        a.report_date,
        a.account_number,
        a.client_id,
        a.account_type,
        a.currency_cd,
        a.current_balance,
        a.open_date,
        a.close_date,
        coalesce(sum(t.amount_amt) filter (where t.transaction_type = 'debit'), 0) as daily_debit,
        coalesce(sum(t.amount_amt) filter (where t.transaction_type = 'credit'), 0) as daily_credit,
        count(t.transaction_id) as daily_trx_count
    from account_calendar a
    left join ext_dds.transaction_detail t
        on t.account_id = a.account_id
        and t.transaction_date = a.report_date
    group by
        a.account_id, a.report_date, a.account_number, a.client_id,
        a.account_type, a.currency_cd, a.current_balance, a.open_date, a.close_date
),
rolling_window as (
    -- CTE 3: скользящие окна 7 дней (алиас "a" совпадает с CTE2)
    select
        a.account_id,
        a.report_date,
        a.account_number,
        a.client_id,
        a.account_type,
        a.currency_cd,
        a.current_balance,
        a.daily_debit,
        a.daily_credit,
        a.daily_trx_count,
        sum(a.daily_debit) over (
            partition by a.account_id
            order by a.report_date
            rows between 6 preceding and current row
        ) as rolling_debit_7d,
        sum(a.daily_credit) over (
            partition by a.account_id
            order by a.report_date
            rows between 6 preceding and current row
        ) as rolling_credit_7d,
        avg(a.daily_trx_count) over (
            partition by a.account_id
            order by a.report_date
            rows between 6 preceding and current row
        ) as avg_trx_7d
    from daily_flows a
),
client_enriched as (
    -- CTE 4: профиль клиента (алиас "a" совпадает с CTE3)
    select
        a.account_id,
        a.report_date,
        a.account_number,
        a.client_id,
        a.account_type,
        a.currency_cd,
        a.current_balance,
        a.daily_debit,
        a.daily_credit,
        a.daily_trx_count,
        a.rolling_debit_7d,
        a.rolling_credit_7d,
        a.avg_trx_7d,
        cap.client_city,
        cap.active_passport,
        cap.address_type
    from rolling_window a
    left join ext_dds.client_account_profile cap
        on cap.account_id = a.account_id
),
risk_flagged as (
    -- CTE 5: флаги риска (алиас "a" совпадает с CTE4)
    select
        a.account_id,
        a.report_date,
        a.account_number,
        a.client_id,
        a.client_city,
        a.account_type,
        a.currency_cd,
        a.current_balance,
        a.daily_debit,
        a.daily_credit,
        a.daily_trx_count,
        a.rolling_debit_7d,
        a.rolling_credit_7d,
        a.avg_trx_7d,
        a.active_passport,
        a.address_type,
        case
            when a.rolling_debit_7d > a.current_balance * 0.5 then 'high'
            when a.rolling_debit_7d > a.current_balance * 0.2 then 'medium'
            else 'low'
        end as risk_level,
        case
            when a.daily_trx_count > 10 then 'spike'
            when a.daily_trx_count > 5 then 'elevated'
            else 'normal'
        end as activity_flag
    from client_enriched a
)
-- Финальный SELECT с дополнительными джойнами
select
    rf.account_id,
    rf.report_date,
    rf.account_number,
    rf.client_id,
    rf.client_city,
    rf.account_type,
    rf.currency_cd,
    rf.current_balance,
    rf.daily_debit,
    rf.daily_credit,
    rf.daily_trx_count,
    rf.rolling_debit_7d,
    rf.rolling_credit_7d,
    rf.avg_trx_7d,
    rf.risk_level,
    rf.activity_flag,
    rf.active_passport,
    rf.address_type,
    cd.masked_card_number,
    cd.card_system,
    cd.validity_status,
    cbs.total_trx_count as client_total_trx,
    cbs.total_credit_amt as client_total_credit,
    cbs.total_debit_amt as client_total_debit,
    csm.behavior_score,
    csm.wealth_grade,
    crp.client_segment,
    crp.avg_monthly_inflow,
    current_date as snapshot_date
from risk_flagged rf
left join ext_dds.card_detail cd
    on cd.account_id = rf.account_id
left join dm.core.client_behavior_summary cbs
    on cbs.client_id = rf.client_id
left join dm.core.client_scoring_model csm
    on csm.client_id = rf.client_id
left join dm.core.client_revenue_potential crp
    on crp.account_id = rf.account_id
    and crp.report_date = current_date$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'daily_account_snapshot', $$----
-- ==================== Создание ежедневных срезов dm.core.daily_account_snapshot ====================

create table dm.core.daily_account_snapshot as
select
    a.account_id,
    a.account_number,
    a.client_id,
    a.client_full_name,
    a.account_type,
    a.currency_cd,
    a.balance_amt,
    a.interest_rate,
    a.account_status,
    report_date,
    a.open_date,
    a.close_date,
    current_date - a.open_date as account_age_days,
    case 
        when report_date between a.open_date and coalesce(a.close_date, current_date) 
        then true 
        else false 
    end as is_active_on_date,
    case 
        when report_date = a.open_date then 'open_day'
        when report_date = a.close_date then 'close_day'
        else 'regular'
    end as date_type,
    extract(year from report_date) as report_year,
    extract(month from report_date) as report_month,
    extract(quarter from report_date) as report_quarter
from ext_dds.account_detail a
cross join lateral generate_series(
    a.open_date,
    coalesce(a.close_date, current_date),
    interval '1 day'
) as report_date$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'datamart_account_card_contract', $$create table dm.core.datamart_account_card_contract as
select * from ext_calc.account_card_contract$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'manager_activity_overview', $$CREATE TABLE core.manager_activity_overview AS
SELECT
    m.manager_id,
    m.manager_full_name,
    m.manager_role,
    m.branch_cd,
    m.assignment_date,
    count(DISTINCT m.client_id) AS assigned_clients_cnt,
    count(c.contact_id) AS contacts_cnt,
    count(c.contact_id) FILTER (WHERE c.contact_ts >= current_date - INTERVAL '30 days') AS contacts_last_30_days_cnt,
    count(c.contact_id) FILTER (WHERE c.result_txt IS NOT NULL) AS contacts_with_result_cnt,
    min(c.contact_ts) AS first_contact_ts,
    max(c.contact_ts) AS last_contact_ts
FROM ext_dds.manager_detail m
LEFT JOIN ext_dds.client_contact_detail c
    ON c.client_id = m.client_id
GROUP BY
    m.manager_id,
    m.manager_full_name,
    m.manager_role,
    m.branch_cd,
    m.assignment_date$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'master_nine_mart_join', $$--витрины, собранная из 9 прошлых витрин, для отладки table линейджа
create table dm.core.master_nine_mart_join as
select
    aa.transaction_id,
    aa.transaction_date,
    aa.transaction_ts,
    aa.account_id,
    aa.client_id,
    aa.client_full_name,
    aa.contract_id,
    aa.contract_number,
    aa.contract_type,
    aa.account_type,
    aa.currency_cd,
    aa.transaction_type,
    aa.amount_amt,
    aa.signed_amount_amt,
    aa.operation_category,
    aa.channel_cd,
    aa.transaction_status,
    aa.current_balance_amt,
    aa.interest_rate,
    aa.operation_context,
    aa.operation_details,

    cbs.total_trx_count,
    cbs.total_credit_amt,
    cbs.total_debit_amt,
    cbs.last_transaction_date as cbs_last_trx_date,
    cbs.used_channels,

    cra.card_id,
    cra.masked_card_number,
    cra.card_system,
    cra.validity_status,
    cra.risk_level as card_risk_level,
    cra.trx_count_30d,
    cra.debit_sum_30d,
    cra.credit_sum_30d,
    cra.unique_merchants_30d,
    cra.top_channel,

    crp.avg_monthly_inflow,
    crp.avg_monthly_outflow,
    crp.peak_monthly_trx,
    crp.total_inflow,
    crp.total_outflow,
    crp.active_months,
    crp.client_segment,
    crp.financial_behavior,

    csm.behavior_score,
    csm.wealth_grade,
    csm.lifetime_inflow,
    csm.lifetime_outflow,
    csm.premium_accounts_count,
    csm.max_peak_monthly_trx,
    csm.days_since_last_trx,

    aco.card_id as aco_card_id,
    aco.days_to_expiry,
    aco.account_tier,
    aco.product_bundle,
    aco.is_card_valid_flag,

    ucd.client_type as ucd_client_type,
    ucd.passport_full,
    ucd.total_balance_amt as ucd_total_balance,
    ucd.last_transaction_date as ucd_last_trx_date,
    ucd.accounts_count as ucd_accounts_count,

    cur.client_t,
    cur.cl_inn,
    cur.cl_snils,
    cur.total_balance_amt as cur_total_balance,
    cur.accounts_count as cur_accounts_count,
    cur.last_transaction_date as cur_last_trx_date,

    das.report_date,
    das.is_active_on_date,
    das.date_type,
    das.report_year,
    das.report_month,
    das.report_quarter

from core.account_activity aa
left join dm.core.client_behavior_summary cbs 
    on cbs.client_id = aa.client_id
left join dm.core.card_risk_analysis cra 
    on cra.account_id = aa.account_id
left join dm.core.client_revenue_potential crp 
    on crp.account_id = aa.account_id
left join dm.core.client_scoring_model csm 
    on csm.client_id = aa.client_id
left join dm.core.account_card_overview aco 
    on aco.account_id = aa.account_id
left join dm.core.unified_client_directory ucd 
    on ucd.client_id = aa.client_id
left join dm.core.v_client_unified_registry_2 cur 
    on cur.cli_id = aa.client_id
left join dm.core.daily_account_snapshot das 
    on das.account_id = aa.account_id 
    and das.report_date = aa.transaction_date$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'master_wide_join', $$CREATE TABLE core.master_wide_join AS
SELECT
    -- базовая детальная информация по счёту
    ad.account_id,
    ad.account_number,
    ad.account_type,
    ad.currency_cd,
    ad.open_date,
    ad.close_date,
    ad.balance_amt AS current_balance_amt,
    ad.account_status,
    ad.contract_id,
    ad.contract_type,
    ad.interest_rate,
    ad.contract_status,
    ad.client_id,
    ad.client_full_name,
    ad.client_status,

    -- транзакции по счёту
    td.transaction_id,
    td.transaction_date,
    td.transaction_ts,
    td.transaction_type,
    td.amount_amt,
    td.channel_cd AS trx_channel_cd,
    td.transaction_status,
    td.operation_category,

    -- карта счёта
    cd.card_id,
    cd.masked_card_number,
    cd.card_system,
    cd.validity_status,
    cd.expiry_date,

    -- платежи по карте
    cpd.payment_id,
    cpd.payment_date,
    cpd.payment_amt,
    cpd.debt_amt,

    -- история остатков
    abd.balance_date,
    abd.balance_amt AS history_balance_amt,
    abd.available_amt,

    -- клиентский профиль
    cap.active_passport,
    cap.client_city,
    cap.address_type,

    -- менеджер и контакты
    mgr.manager_id,
    mgr.manager_full_name,
    mgr.manager_role,
    mgr.branch_cd,
    ccd.contact_id,
    ccd.contact_ts,
    ccd.contact_type_cd,
    ccd.subject_txt,

    -- индивидуальный и корпоративный профиль
    ind.full_name AS individual_full_name,
    ind.marital_status_cd,
    ind.monthly_income_amt,
    ind.income_level_cd,
    corp.inn AS corp_inn,
    corp.company_name,
    corp.industry_cd,
    corp.company_size_cd,

    -- лизинг (через ИНН корпоративного клиента)
    ld.leasing_id,
    ld.contract_number AS leasing_contract_number,
    ld.object_type_cd,
    ld.object_cost_amt,
    ld.contract_status_cd AS leasing_status,

    -- мастер-партия (связанные данные счёт/клиент/карта)
    map.party_type,
    map.total_trx_count AS map_trx_count,
    map.total_debit_amt AS map_debit_amt,
    map.total_credit_amt AS map_credit_amt,
    map2.total_trx_count AS map2_trx_count,

    -- карта+договор (ext_calc)
    acc.card_id AS acc_card_id,
    acc.card_system AS acc_card_system,
    acc.issue_date AS acc_card_issue_date,

    -- риск-аналитика по карте (core)
    cra.risk_level,
    cra.trx_count_30d,
    cra.used_channels AS cra_channels,

    -- поведение клиента (core)
    cbs.total_trx_count AS cbs_trx_count,
    cbs.total_credit_amt AS cbs_credit_amt,
    cbs.total_debit_amt AS cbs_debit_amt,
    cbs.last_transaction_date AS cbs_last_trx_date,

    -- ежедневные срезы по счёту (core)
    das.report_date::date AS snapshot_report_date,
    das.is_active_on_date,
    das.date_type AS snapshot_date_type,

    -- сводка счёт+карта (core)
    aco.account_tier,
    aco.product_bundle,
    aco.current_balance AS aco_current_balance,
    aco.days_to_expiry,

    -- дубль account_detail (для проверки связи витрин)
    v.account_age_days AS v_account_age_days

FROM ext_dds.account_detail ad
LEFT JOIN ext_dds.transaction_detail td        ON td.account_id = ad.account_id
LEFT JOIN ext_dds.card_detail cd               ON cd.account_id = ad.account_id
LEFT JOIN ext_dds.card_payment_detail cpd      ON cpd.card_id = cd.card_id
LEFT JOIN ext_dds.account_balance_detail abd   ON abd.account_id = ad.account_id
LEFT JOIN ext_dds.client_account_profile cap   ON cap.account_id = ad.account_id
LEFT JOIN ext_dds.manager_detail mgr           ON mgr.client_id = ad.client_id
LEFT JOIN ext_dds.client_contact_detail ccd    ON ccd.client_id = ad.client_id
LEFT JOIN ext_dds.individual_client_detail ind ON ind.client_id = ad.client_id::int
LEFT JOIN ext_dds.corporate_client_detail corp ON corp.client_id = ad.client_id::int
LEFT JOIN ext_dds.leasing_detail ld            ON ld.lessee_inn = corp.inn
LEFT JOIN ext_dds.master_account_party map     ON map.account_id = ad.account_id
LEFT JOIN ext_dds.master_account_party_2 map2  ON map2.account_id = ad.account_id
LEFT JOIN ext_calc.account_card_contract acc   ON acc.account_id = ad.account_id
LEFT JOIN core.card_risk_analysis cra          ON cra.card_id = cd.card_id
LEFT JOIN core.client_behavior_summary cbs     ON cbs.client_id = ad.client_id
LEFT JOIN core.daily_account_snapshot das      ON das.account_id = ad.account_id
LEFT JOIN core.account_card_overview aco       ON aco.account_id = ad.account_id AND aco.card_id = cd.card_id
LEFT JOIN ext_dds.v_test_account_detail v      ON v.account_id = ad.account_id$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'second_unified_client_directory', $$create table dm.core.second_unified_client_directory as

-- =============================================================
-- CTE 1: Подготовка данных по корпоративным клиентам
-- =============================================================
with corporate_enriched as (
    select
        'CORPORATE'                          as client_type,
        client_id,
        inn,
        null::varchar                        as snils,
        display_name                         as client_name,
        null::date                           as birth_date,
        company_age_days                     as age_days,
        null::varchar                        as passport_full,
        effective_address,
        phone,
        email,
        industry_cd                          as segment_cd,
        company_size_cd                      as sub_segment_cd,
        status_cd,
        0::decimal(18,2)                     as monthly_income_amt,
        null::varchar                        as income_level_cd,
        created_ts
    from dm.ext_dds.corporate_client_detail
),

-- =============================================================
-- CTE 2: Агрегаты по счетам и транзакциям клиентов
-- (замена трех коррелирующих подзапросов одним групповым запросом)
-- =============================================================
client_aggregates as (
    select
        ad.client_id,
        count(distinct ad.account_id)        as accounts_count,
        coalesce(sum(ad.balance_amt), 0)     as total_balance_amt,
        max(td.transaction_date)             as last_transaction_date
    from dm.ext_dds.account_detail ad
    left join dm.ext_dds.transaction_detail td
           on td.account_id = ad.account_id
    group by ad.client_id
)

-- =============================================================
-- Финальная сборка витрины через UNION ALL
-- =============================================================
select
    -- Ветка 1: корпоративные клиенты (ВСЕ данные берутся из CTE)
    ce.client_type,
    ce.client_id,
    ce.inn,
    ce.snils,
    ce.client_name,
    ce.birth_date,
    ce.age_days,
    ce.passport_full,
    ce.effective_address,
    ce.phone,
    ce.email,
    ce.segment_cd,
    ce.sub_segment_cd,
    ce.status_cd,
    ce.monthly_income_amt,
    ce.income_level_cd,
    ce.created_ts,
    coalesce(ca.accounts_count, 0)           as accounts_count,
    coalesce(ca.total_balance_amt, 0)        as total_balance_amt,
    ca.last_transaction_date,
    current_date                             as report_date
from corporate_enriched ce
left join client_aggregates ca
       on ca.client_id = ce.client_id

union all

select
    -- Ветка 2: физические лица (данные берутся напрямую из DDS-таблицы)
    'INDIVIDUAL'                             as client_type,
    icd.client_id,
    icd.inn,
    icd.snils,
    icd.full_name                            as client_name,
    icd.birth_date,
    icd.age_days,
    icd.passport_full,
    icd.effective_address,
    icd.phone,
    icd.email,
    icd.marital_status_cd                    as segment_cd,
    icd.employment_type_cd                   as sub_segment_cd,
    icd.status_cd,
    icd.monthly_income_amt,
    icd.income_level_cd,
    icd.created_ts,
    coalesce(ca.accounts_count, 0)           as accounts_count,
    coalesce(ca.total_balance_amt, 0)        as total_balance_amt,
    ca.last_transaction_date,
    current_date                             as report_date
from dm.ext_dds.individual_client_detail icd
left join client_aggregates ca
       on ca.client_id = icd.client_id$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'unified_client_directory', $$-- ==================== 4. Создание витрины DM (с WITH + UNION) ====================

create table dm.core.unified_client_directory as
with corporate_enriched as (
    select
        'CORPORATE' as client_type,
        client_id,
        inn,
        null::varchar as snils,
        display_name as client_name,
        null::date as birth_date,
        company_age_days as age_days,
        null::varchar as passport_full,
        effective_address,
        phone,
        email,
        industry_cd as segment_cd,
        company_size_cd as sub_segment_cd,
        status_cd,
        0::decimal(18,2) as monthly_income_amt,
        null::varchar as income_level_cd,
        created_ts
    from ext_dds.corporate_client_detail
),
individual_enriched as (
    select
        'INDIVIDUAL' as client_type,
        client_id,
        inn,
        snils,
        full_name as client_name,
        birth_date,
        age_days,
        passport_full,
        effective_address,
        phone,
        email,
        marital_status_cd as segment_cd,
        employment_type_cd as sub_segment_cd,
        status_cd,
        monthly_income_amt,
        income_level_cd,
        created_ts
    from ext_dds.individual_client_detail
),
unified_base as (
    select * from corporate_enriched
    union all
    select * from individual_enriched
)
select
    ub.*,
    -- Подзапрос: количество счетов клиента
    (
        select count(*)
        from ext_dds.account_detail ad
        where ad.client_id = ub.client_id
    ) as accounts_count,
    -- Подзапрос: суммарный баланс по всем счетам
    (
        select coalesce(sum(balance_amt), 0)
        from ext_dds.account_detail ad
        where ad.client_id = ub.client_id
    ) as total_balance_amt,
    -- Подзапрос: дата последней транзакции
    (
        select max(transaction_date)
        from ext_dds.transaction_detail td
        join ext_dds.account_detail ad on ad.account_id = td.account_id
        where ad.client_id = ub.client_id
    ) as last_transaction_date,
    current_date as report_date
from unified_base ub$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'v_client_daily_activity', $$-- ==================== Создание представления dm.core.v_client_daily_activity ====================

create or replace view dm.core.v_client_daily_activity as 
select
    t.transaction_date,
    a.client_id,
    a.client_full_name,
    a.account_id,
    a.account_number,
    a.account_type,
    a.currency_cd,
    /* тестовый двустрочный
    комментарий*/
    count(t.transaction_id) as daily_trx_count,
    sum(t.signed_amount_amt) as daily_net_amount,
    sum(case when t.transaction_type = 'credit' then t.amount_amt else 0 end) as daily_credit_amt,
    sum(case when t.transaction_type = 'debit' then t.amount_amt else 0 end) as daily_debit_amt,
    count(distinct t.channel_cd) as daily_channels_used,
    max(t.transaction_ts) as last_trx_ts,
    string_agg(distinct t.operation_category, ', ' order by t.operation_category) as daily_categories
from ext_dds.transaction_detail t
join ext_dds.account_detail a 
    on a.account_id = t.account_id
group by 
    t.transaction_date,
    a.client_id,
    a.client_full_name,
    a.account_id,
    a.account_number,
    a.account_type,
    a.currency_cd$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'v_client_unified_registry_2', $$--Витрина Георгия с подзапросом с алиасом и union внутри него
create or replace view  dm.core.v_client_unified_registry_2 as
select distinct
    client_type as  client_t,
    client_id as cli_id,
    client_name as  client_n,
    inn as cl_inn,
    snils as cl_snils,
    effective_address,
    phone --тест /* тест */
    ,email,
    segment_cd, --тест /* тест */
    status_cd,
    monthly_income_amt,
    (
        select count(*)
        from ext_dds.account_detail ad
        where ad.client_id = u.client_id
    ) as accounts_count,
    (
        select coalesce(sum(balance_amt), 0)
        from ext_dds.account_detail ad
        where ad.client_id = u.client_id
    ) as total_balance_amt,
    (
        select max(td.transaction_date)
        from ext_dds.transaction_detail td
        join ext_dds.account_detail ad on ad.account_id = td.account_id
        where ad.client_id = u.client_id
    ) as last_transaction_date,
    current_date as report_date
from (
    select
        'CORPORATE' as client_type,
        cc.client_id,
        cc.display_name as client_name,
        cc.inn,
        null::varchar as snils,
        cc.effective_address,
        cc.phone,
        cc.email,
        cc.industry_cd as segment_cd,
        cc.status_cd,
        0::decimal(18,2) as monthly_income_amt
    from ext_dds.corporate_client_detail cc
    union
    select
        'INDIVIDUAL' as client_type,
        cc.client_id,
        cc.full_name as client_name,
        cc.inn,
        cc.snils,
        cc.effective_address,
        cc.phone,
        cc.email,
        cc.marital_status_cd as segment_cd,
        cc.status_cd,
        cc.monthly_income_amt
    from ext_dds.individual_client_detail cc
) u$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('sandbox_3', 'test3', $$-------------------------------------------------
-------------------------------
create table dm.sandbox_3.test3 as
select * from dm.core.account_card_overview$$);

