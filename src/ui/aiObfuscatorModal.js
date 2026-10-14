/* 
MODULE: src/ui/aiObfuscatorModal.js
ROLE: Модальное окно AI-обфускатора/деобфускатора для безопасной работы с нейросетями.
Вызывается по глобальному хоткею Alt + O.
*/

import { obfuscatePromptAndSql, deobfuscateText } from '../utils/sqlObfuscator.js';

let modalElement = null;
let currentSessionMapping = null;
let currentDialect = 'postgres';
let currentTab = 'obfuscate';
let maskStringsEnabled = true;

/**
 * Инициализирует глобальный слушатель хоткея Alt + O
 */
export function initAiObfuscator() {
  window.addEventListener('keydown', (e) => {
    // Проверяем Alt + O (включая русскую раскладку 'о' / 'О' и e.code 'KeyO')
    const isO = e.code === 'KeyO' || e.key === 'o' || e.key === 'O' || e.key === 'о' || e.key === 'О';
    if (e.altKey && isO) {
      e.preventDefault();
      toggleAiObfuscatorModal();
    }
  });
}

/**
 * Открывает или закрывает модальное окно обфускатора
 */
export function toggleAiObfuscatorModal() {
  if (modalElement && document.body.contains(modalElement)) {
    closeAiObfuscatorModal();
  } else {
    openAiObfuscatorModal();
  }
}

/**
 * Закрывает модальное окно
 */
export function closeAiObfuscatorModal() {
  if (modalElement) {
    modalElement.remove();
    modalElement = null;
  }
}

/**
 * Открывает модальное окно и отрисовывает его содержимое
 */
export function openAiObfuscatorModal() {
  if (modalElement) {
    modalElement.remove();
  }

  modalElement = document.createElement('div');
  modalElement.className = 'ai-obf-overlay';
  modalElement.id = 'ai-obfuscator-modal';

  modalElement.innerHTML = `
    <div class="ai-obf-modal" role="dialog" aria-modal="true" aria-labelledby="ai-obf-title">
      <!-- Шапка -->
      <div class="ai-obf-header">
        <div class="ai-obf-header-left">
          <div class="ai-obf-shield-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
          </div>
          <div>
            <h2 id="ai-obf-title" class="ai-obf-title">AI Prompt & SQL Обфускатор</h2>
            <div class="ai-obf-subtitle">Локальное обезличивание для безопасных запросов в нейросеть</div>
          </div>
        </div>
        <div class="ai-obf-header-right">
          <span class="ai-obf-hotkey-badge" title="Горячая клавиша для быстрого вызова">Alt + O</span>
          <button class="ai-obf-close-btn" id="ai-obf-close-btn" title="Закрыть (Esc)">&times;</button>
        </div>
      </div>

      <!-- Панель настроек (Диалект и вкладки) -->
      <div class="ai-obf-toolbar">
        <div class="ai-obf-tabs">
          <button class="ai-obf-tab-btn ${currentTab === 'obfuscate' ? 'is-active' : ''}" data-tab="obfuscate">
            1. Обезличить (Запрос к ИИ)
          </button>
          <button class="ai-obf-tab-btn ${currentTab === 'deobfuscate' ? 'is-active' : ''}" data-tab="deobfuscate">
            2. Восстановить (Ответ ИИ)
          </button>
        </div>
        <div class="ai-obf-dialect-wrap">
          <span class="ai-obf-dialect-label">Диалект SQL:</span>
          <label class="ai-obf-radio-label">
            <input type="radio" name="ai-obf-dialect" value="postgres" ${currentDialect === 'postgres' ? 'checked' : ''}>
            <span>PostgreSQL</span>
          </label>
          <label class="ai-obf-radio-label">
            <input type="radio" name="ai-obf-dialect" value="mssql" ${currentDialect === 'mssql' ? 'checked' : ''}>
            <span>MS SQL</span>
          </label>
        </div>
      </div>

      <!-- Тело модального окна -->
      <div class="ai-obf-body">
        <!-- ВКЛАДКА 1: ОБЕЗЛИЧИВАНИЕ -->
        <div class="ai-obf-tab-pane ${currentTab === 'obfuscate' ? 'is-active' : ''}" id="ai-obf-pane-obfuscate">
          <div class="ai-obf-form-group">
            <label class="ai-obf-field-label" for="ai-obf-prompt-input">
              Вопрос или промпт аналитика:
            </label>
            <textarea
              id="ai-obf-prompt-input"
              class="ai-obf-textarea ai-obf-prompt-area"
              rows="3"
              placeholder="Например: В таблице dds.fct_credit_deals задваиваются записи по полю deal_rk при джойне с dict_branch. Перепиши через оконную функцию..."
            ></textarea>
          </div>

          <div class="ai-obf-form-group">
            <label class="ai-obf-field-label" for="ai-obf-sql-input">
              Исходный SQL-скрипт:
            </label>
            <textarea
              id="ai-obf-sql-input"
              class="ai-obf-textarea ai-obf-sql-area"
              rows="5"
              placeholder="SELECT d.deal_rk, b.branch_name&#10;FROM dds.fct_credit_deals d&#10;JOIN core.dict_branch b ON d.branch_rk = b.branch_rk&#10;WHERE d.deal_status = 'ACTIVE'"
            ></textarea>
          </div>

          <div class="ai-obf-actions-bar">
            <div class="ai-obf-actions-left">
              <button class="ai-obf-btn ai-obf-btn-primary" id="ai-obf-process-btn">
                ⚡ Обезличить
              </button>
              <label class="ai-obf-cb-label">
                <input type="checkbox" id="ai-obf-cb-strings" ${maskStringsEnabled ? 'checked' : ''}>
                <span>Обезличивать строковые константы ('текст' &rarr; STR_001)</span>
              </label>
            </div>
            <button class="ai-obf-btn ai-obf-btn-secondary" id="ai-obf-clear-btn-1">
              Очистить
            </button>
          </div>

          <!-- Блок результатов обфускации -->
          <div class="ai-obf-result-box hidden" id="ai-obf-obfuscated-result-box">
            <div class="ai-obf-result-header">
              <span class="ai-obf-result-title">Готовый обезличенный запрос (для отправки в нейросеть):</span>
              <button class="ai-obf-copy-btn" id="ai-obf-copy-combined-btn">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
                <span>Скопировать всё для ИИ</span>
              </button>
            </div>
            <textarea id="ai-obf-combined-output" class="ai-obf-textarea ai-obf-code-output" rows="6" readonly></textarea>

            <!-- Список заменённых токенов -->
            <div class="ai-obf-mapping-container">
              <div class="ai-obf-mapping-header" id="ai-obf-toggle-mapping-btn">
                <span id="ai-obf-mapping-summary">Таблица замен</span>
                <span class="ai-obf-mapping-arrow">&#9662;</span>
              </div>
              <div class="ai-obf-mapping-list" id="ai-obf-mapping-list"></div>
            </div>
          </div>
        </div>

        <!-- ВКЛАДКА 2: ВОССТАНОВЛЕНИЕ (ДЕОБФУСКАЦИЯ) -->
        <div class="ai-obf-tab-pane ${currentTab === 'deobfuscate' ? 'is-active' : ''}" id="ai-obf-pane-deobfuscate">
          <div class="ai-obf-form-group">
            <div class="ai-obf-restore-info-bar">
              <label class="ai-obf-field-label" for="ai-obf-restore-input">
                Ответ нейросети (SQL или текст с токенами OBJ_... / STR_...):
              </label>
              <span class="ai-obf-session-status" id="ai-obf-session-status"></span>
            </div>
            <textarea
              id="ai-obf-restore-input"
              class="ai-obf-textarea ai-obf-sql-area"
              rows="8"
              placeholder="Вставьте сюда ответ, полученный от нейросети (содержащий OBJ_001, OBJ_002 и т.д.)..."
            ></textarea>
          </div>

          <div class="ai-obf-actions-bar">
            <button class="ai-obf-btn ai-obf-btn-primary" id="ai-obf-restore-btn">
              🔄 Восстановить названия
            </button>
            <button class="ai-obf-btn ai-obf-btn-secondary" id="ai-obf-clear-btn-2">
              Очистить
            </button>
          </div>

          <!-- Блок результатов деобфускации -->
          <div class="ai-obf-result-box hidden" id="ai-obf-restored-result-box">
            <div class="ai-obf-result-header">
              <span class="ai-obf-result-title">Восстановленный результат (с реальными названиями):</span>
              <button class="ai-obf-copy-btn" id="ai-obf-copy-restored-btn">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
                <span>Скопировать результат</span>
              </button>
            </div>
            <textarea id="ai-obf-restored-output" class="ai-obf-textarea ai-obf-code-output" rows="8" readonly></textarea>
          </div>
        </div>
      </div>

      <!-- Футер -->
      <div class="ai-obf-footer">
        <span class="ai-obf-security-note">
          🔒 <strong>100% локально:</strong> обработка выполняется в памяти браузера, данные не покидают ваш компьютер.
        </span>
        <span class="ai-obf-hint-note">Закрыть: Esc или Alt+O</span>
      </div>
    </div>
  `;

  document.body.appendChild(modalElement);
  _attachModalEvents(modalElement);
  _updateSessionStatus();
}

/**
 * Подключение обработчиков событий модального окна
 */
function _attachModalEvents(modal) {
  // Закрытие по крестику
  const closeBtn = modal.querySelector('#ai-obf-close-btn');
  closeBtn?.addEventListener('click', closeAiObfuscatorModal);

  // Закрытие по клику на оверлей вне модального окна
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeAiObfuscatorModal();
    }
  });

  // Закрытие по Escape
  const onKeydown = (e) => {
    if (e.key === 'Escape') {
      closeAiObfuscatorModal();
      window.removeEventListener('keydown', onKeydown);
    }
  };
  window.addEventListener('keydown', onKeydown);

  // Переключение вкладок
  const tabBtns = modal.querySelectorAll('.ai-obf-tab-btn');
  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      currentTab = btn.getAttribute('data-tab');
      tabBtns.forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');

      modal.querySelectorAll('.ai-obf-tab-pane').forEach((pane) => {
        pane.classList.remove('is-active');
      });
      const activePane = modal.querySelector(`#ai-obf-pane-${currentTab}`);
      activePane?.classList.add('is-active');

      if (currentTab === 'deobfuscate') {
        _updateSessionStatus();
      }
    });
  });

  // Переключение диалекта SQL
  const dialectRadios = modal.querySelectorAll('input[name="ai-obf-dialect"]');
  dialectRadios.forEach((radio) => {
    radio.addEventListener('change', (e) => {
      currentDialect = e.target.value;
    });
  });

  // Чекбокс маскирования строк
  const cbStrings = modal.querySelector('#ai-obf-cb-strings');
  cbStrings?.addEventListener('change', (e) => {
    maskStringsEnabled = e.target.checked;
  });

  // Кнопка Очистить (вкладка 1)
  modal.querySelector('#ai-obf-clear-btn-1')?.addEventListener('click', () => {
    modal.querySelector('#ai-obf-prompt-input').value = '';
    modal.querySelector('#ai-obf-sql-input').value = '';
    modal.querySelector('#ai-obf-obfuscated-result-box')?.classList.add('hidden');
  });

  // Кнопка Очистить (вкладка 2)
  modal.querySelector('#ai-obf-clear-btn-2')?.addEventListener('click', () => {
    modal.querySelector('#ai-obf-restore-input').value = '';
    modal.querySelector('#ai-obf-restored-result-box')?.classList.add('hidden');
  });

  // Кнопка «⚡ Обезличить»
  modal.querySelector('#ai-obf-process-btn')?.addEventListener('click', () => {
    const promptInput = modal.querySelector('#ai-obf-prompt-input')?.value || '';
    const sqlInput = modal.querySelector('#ai-obf-sql-input')?.value || '';

    if (!promptInput.trim() && !sqlInput.trim()) {
      alert('Пожалуйста, введите текст промпта или SQL-скрипт для обезличивания.');
      return;
    }

    const catalogData = window.catalogData || null;

    const result = obfuscatePromptAndSql({
      prompt: promptInput,
      sql: sqlInput,
      dialect: currentDialect,
      catalogData,
      maskStrings: maskStringsEnabled
    });

    currentSessionMapping = result.mapping;

    // Отображаем результат
    const resultBox = modal.querySelector('#ai-obf-obfuscated-result-box');
    const combinedOutput = modal.querySelector('#ai-obf-combined-output');
    if (resultBox && combinedOutput) {
      combinedOutput.value = result.combinedText;
      resultBox.classList.remove('hidden');
    }

    // Рендерим бейджи маппинга
    _renderMappingList(result.mapping);
  });

  // Сворачивание / разворачивание таблицы соответствий
  modal.querySelector('#ai-obf-toggle-mapping-btn')?.addEventListener('click', () => {
    const list = modal.querySelector('#ai-obf-mapping-list');
    const arrow = modal.querySelector('.ai-obf-mapping-arrow');
    if (list) {
      const isExpanded = list.classList.toggle('is-expanded');
      if (arrow) arrow.textContent = isExpanded ? '▴' : '▾';
    }
  });

  // Кнопка копирования готового запроса
  const copyCombinedBtn = modal.querySelector('#ai-obf-copy-combined-btn');
  copyCombinedBtn?.addEventListener('click', () => {
    const text = modal.querySelector('#ai-obf-combined-output')?.value;
    if (text) {
      _copyTextWithFeedback(text, copyCombinedBtn, 'Скопировано для ИИ!');
    }
  });

  // Кнопка «🔄 Восстановить названия»
  modal.querySelector('#ai-obf-restore-btn')?.addEventListener('click', () => {
    const restoreInput = modal.querySelector('#ai-obf-restore-input')?.value || '';

    if (!restoreInput.trim()) {
      alert('Пожалуйста, вставьте ответ нейросети в поле ввода.');
      return;
    }

    if (!currentSessionMapping || !currentSessionMapping.tokenToOriginal) {
      alert('Внимание: активная таблица соответствий пуста. Сначала выполните обезличивание на шаге 1, чтобы сформировать словарь токенов.');
      return;
    }

    const restoredText = deobfuscateText(restoreInput, currentSessionMapping);

    const resultBox = modal.querySelector('#ai-obf-restored-result-box');
    const restoredOutput = modal.querySelector('#ai-obf-restored-output');
    if (resultBox && restoredOutput) {
      restoredOutput.value = restoredText;
      resultBox.classList.remove('hidden');
    }
  });

  // Кнопка копирования восстановленного результата
  const copyRestoredBtn = modal.querySelector('#ai-obf-copy-restored-btn');
  copyRestoredBtn?.addEventListener('click', () => {
    const text = modal.querySelector('#ai-obf-restored-output')?.value;
    if (text) {
      _copyTextWithFeedback(text, copyRestoredBtn, 'Скопировано!');
    }
  });
}

/**
 * Отрисовывает список токенов и замен
 */
function _renderMappingList(mapping) {
  if (!modalElement) return;
  const list = modalElement.querySelector('#ai-obf-mapping-list');
  const summary = modalElement.querySelector('#ai-obf-mapping-summary');
  if (!list) return;

  list.innerHTML = '';
  const count = mapping?.items?.length || 0;
  if (summary) {
    summary.textContent = `Таблица замен (${count} ${count === 1 ? 'объект' : count < 5 ? 'объекта' : 'объектов'}):`;
  }

  if (count === 0) {
    list.innerHTML = '<span class="ai-obf-mapping-empty">Нет заменённых объектов</span>';
    return;
  }

  mapping.items.forEach((item) => {
    const badge = document.createElement('span');
    badge.className = `ai-obf-mapping-badge ${item.type === 'string' ? 'ai-obf-badge-string' : ''}`;
    badge.innerHTML = `<strong>${item.token}</strong> &harr; <code>${_escapeHtml(item.original)}</code>`;
    list.appendChild(badge);
  });
}

/**
 * Обновляет плашку состояния сессии маппинга во вкладке 2
 */
function _updateSessionStatus() {
  if (!modalElement) return;
  const statusEl = modalElement.querySelector('#ai-obf-session-status');
  if (!statusEl) return;

  const count = currentSessionMapping?.items?.length || 0;
  if (count > 0) {
    statusEl.className = 'ai-obf-session-status is-ready';
    statusEl.innerHTML = `&check; В памяти активно соответствий: <strong>${count}</strong>`;
  } else {
    statusEl.className = 'ai-obf-session-status is-empty';
    statusEl.innerHTML = `&#9888; Словарь пуст (выполните Шаг 1)`;
  }
}

/**
 * Утилита копирования с индикацией
 */
function _copyTextWithFeedback(text, button, successMsg) {
  navigator.clipboard.writeText(text).then(() => {
    const originalHtml = button.innerHTML;
    button.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#00D084" stroke-width="2.5">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
      <span style="color: #047857; font-weight: 600;">${successMsg}</span>
    `;
    setTimeout(() => {
      button.innerHTML = originalHtml;
    }, 2000);
  }).catch((err) => {
    console.error('Ошибка при копировании:', err);
  });
}

function _escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
