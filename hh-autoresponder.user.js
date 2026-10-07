(function () {
    'use strict';

    // ============================================================
    //  КОНФИГУРАЦИЯ И СОСТОЯНИЕ
    // ============================================================
    const CONFIG = {
        // Шаблон сопроводительного письма.
        coverLetterTemplate: `Здравствуйте.
Меня заинтересовала ваша вакансия.
У меня более 6 лет опыта в тестировании веб- и backend-приложений. Работал с функциональным, регрессионным и API-тестированием, анализом требований, локализацией дефектов и сопровождением релизов.
Использую в работе SQL, Postman, REST API, Jira, Git. Также участвовал во внедрении автотестов на Playwright и автоматизации отдельных QA-процессов.
Основной фокус в работе — поиск критичных сценариев и снижение рисков до релиза, а не только формальное прохождение тест-кейсов. Есть опыт взаимодействия с разработчиками, аналитиками и product командой при проработке требований и проверке новых фич.
Буду рад обсудить, как мой опыт может быть полезен вашей команде.
С уважением,
Александр Пантин
Telegram: @alxptn
Email: pantin_42@inbox.ru`,
        autoModeDelay: 3000, // Задержка в мс для авто-режима
        fieldFillDelay: 300, // Задержка перед заполнением каждого поля
        submitDelay: 3000, // Задержка в мс перед отправкой отклика
        // Не останавливаться при капче: закрыть её, пропустить вакансию и продолжить (на свой риск)
        ignoreCaptcha: !!(GM_getValue('hh_autoresponder_config', {}) || {}).ignoreCaptcha,
    };

    const CAPTCHA_IGNORE_WARNING =
        'ВНИМАНИЕ!\n\n' +
        'Работа без остановки с игнорированием капчи возможна, но за корректную работу скрипта, ' +
        'сохранность аккаунта и корректную обработку откликов никто не отвечает.\n\n' +
        'При капче скрипт закроет её окно, пропустит вакансию (отклик, скорее всего, не отправится) и продолжит.\n\n' +
        'Включить?';

    function saveConfig() {
        GM_setValue('hh_autoresponder_config', { ignoreCaptcha: CONFIG.ignoreCaptcha });
    }

    const STATE = {
        vacancies: [],
        currentVacancyIndex: 0,
        isAutoMode: false,
        // Пользователь нажал Next: обработать ОДНУ вакансию после перехода на её страницу
        pendingManualStep: false,
        persistentLogs: [], // Для отладки между перезагрузками
    };

    let autoResponseInterval = null;
    // Поднимается кнопкой "Стоп" — прерывает текущую обработку страницы
    let stopRequested = false;

    function saveState() {
        GM_setValue('hh_autoresponder_state', {
            vacancies: STATE.vacancies,
            currentVacancyIndex: STATE.currentVacancyIndex,
            isAutoMode: STATE.isAutoMode,
            pendingManualStep: STATE.pendingManualStep,
            persistentLogs: STATE.persistentLogs,
        });
    }

    async function loadState() {
        const savedState = await GM_getValue('hh_autoresponder_state', null);
        if (savedState) {
            STATE.vacancies = savedState.vacancies || [];
            STATE.currentVacancyIndex = savedState.currentVacancyIndex || 0;
            STATE.isAutoMode = !!savedState.isAutoMode;
            STATE.pendingManualStep = !!savedState.pendingManualStep;
            STATE.persistentLogs = savedState.persistentLogs || [];
        }
    }

    // ============================================================
    //  СЕЛЕКТОРЫ
    // ============================================================
    const SELECTORS = {
        taskBody: '[data-qa="task-body"]',
        taskQuestion: '[data-qa="task-question"]',
        coverLetterToggle: '[data-qa="vacancy-response-letter-toggle"]',
        coverLetterInput: '[data-qa="vacancy-response-popup-form-letter-input"]',
        submitButton: '[data-qa="vacancy-response-submit-popup"]',
        alreadyRespondedText: '[data-qa="already-responded-text"]',
        captcha: '[data-qa="account-captcha-picture"], [data-qa="account-captcha-input"], [data-qa="account-captcha-error"], img[src*="/captcha/picture"]',
    };

    // ============================================================
    //  УТИЛИТЫ
    // ============================================================
    function log(msg, type = 'info') {
        const prefix = '[HH-Responder]';
        const styles = {
            info: 'color: #2196F3; font-weight: bold',
            success: 'color: #4CAF50; font-weight: bold',
            warn: 'color: #FF9800; font-weight: bold',
            error: 'color: #F44336; font-weight: bold',
            step: 'color: #9C27B0; font-weight: bold',
        };
        console.log(`%c${prefix} ${msg}`, styles[type] || styles.info);
        updateLogPanel(msg, type);
    }

    /**
     * Сохраняет лог, который не стирается при перезагрузке страницы.
     * @param {string} message - Сообщение для лога.
     */
    function persistentLog(message) {
        const timestamp = new Date().toLocaleTimeString();
        const logEntry = `[${timestamp}] ${message}`;
        
        // Добавляем в начало и храним последние 10 записей
        STATE.persistentLogs.unshift(logEntry);
        if (STATE.persistentLogs.length > 10) {
            STATE.persistentLogs.pop();
        }
        console.log(`%c[Persistent] ${logEntry}`, 'color: #f0f; font-weight: bold;');
    }

    function wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function qs(selector, parent = document) { return parent.querySelector(selector); }
    function qsa(selector, parent = document) { return Array.from(parent.querySelectorAll(selector)); }

    /**
     * Проверяет, есть ли на странице отметка "Вы откликнулись".
     * @returns {boolean}
     */
    function isAlreadyRespondedOnPage() {
        // Ищем блок data-qa="already-responded-text"
        return !!qs(SELECTORS.alreadyRespondedText);
    }

    // Элемент реально отображается (закрытые модалки остаются в DOM)
    function isVisible(el) {
        return !!el && document.documentElement.contains(el) && el.getClientRects().length > 0;
    }

    const CAPTCHA_TEXT_RE = /пройдите капчу|подтвердите, что вы не робот|подтвердить, что вы не робот/i;

    // Капча: модал «Пройдите капчу» или полностраничный редирект на /captcha
    function isCaptchaDetected() {
        if (qsa(SELECTORS.captcha).some(isVisible)) return true;
        if (/\/captcha/i.test(window.location.href)) return true;
        return CAPTCHA_TEXT_RE.test((document.body.innerText || '').replace(/\s+/g, ' '));
    }

    // Закрыть окно капчи: крестик в шапке модалки, затем Escape
    async function dismissCaptcha() {
        const dialog = qsa('[role="dialog"]').filter(isVisible).find(d =>
            qs(SELECTORS.captcha, d) || CAPTCHA_TEXT_RE.test(d.textContent.replace(/\s+/g, ' '))
        );
        if (!dialog) return false;
        const closeBtn = qs('[data-qa="modal-header"] button', dialog);
        if (closeBtn) {
            closeBtn.click();
            await wait(500);
        }
        if (isVisible(dialog)) {
            const opts = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
            dialog.dispatchEvent(new KeyboardEvent('keydown', opts));
            document.dispatchEvent(new KeyboardEvent('keydown', opts));
            await wait(500);
        }
        return !isVisible(dialog);
    }

    /**
     * Капча обнаружена: по настройке либо останавливаемся (вакансия остаётся текущей,
     * после прохождения капчи можно нажать Next), либо закрываем капчу и идём дальше.
     */
    async function handleCaptcha(vacancyData) {
        const title = (vacancyData && vacancyData.vacancyTitle) || 'вакансия';
        if (CONFIG.ignoreCaptcha) {
            log(`Капча на "${title}". Игнорирую (настройка), пропускаю вакансию.`, 'warn');
            const closed = await dismissCaptcha();
            if (!closed) log('Окно капчи закрыть не удалось — продолжаю', 'warn');
            moveToNextVacancy();
            return;
        }
        console.error('[HH-Responder] Капча! Пройдите капчу вручную, затем нажмите Next или Автоответ. ' +
            '(Можно включить "Не останавливаться при капче" в панели — на свой риск.)');
        log(`Капча на "${title}". Скрипт остановлен — пройдите капчу и нажмите Next/Автоответ.`, 'error');
        haltScript();
        setStepDesc(`КАПЧА на "${title}". Пройдите её вручную, затем Next или Автоответ.`);
    }

    // Прерывание по "Стоп" или по капче. true — дальше не работаем.
    async function checkInterrupt(vacancyData) {
        if (stopRequested) {
            log('Обработка прервана кнопкой "Стоп".', 'warn');
            return true;
        }
        if (isCaptchaDetected()) {
            await handleCaptcha(vacancyData);
            return true;
        }
        return false;
    }

    // Ожидание, которое можно прервать кнопкой "Стоп"
    async function interruptibleWait(ms) {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            if (stopRequested) return false;
            await wait(Math.min(200, end - Date.now()));
        }
        return !stopRequested;
    }

    // ============================================================
    //  ЛОГИКА ОТВЕТОВ
    // ============================================================

    /**
     * Обрабатывает следующую вакансию из списка.
     */
    async function processNextVacancy() {
        if (STATE.currentVacancyIndex >= STATE.vacancies.length) {
            log('Все вакансии из файла обработаны.', 'success');
            setStepDesc('Все вакансии обработаны.');
            haltScript(); // Останавливаем авто-режим
            return;
        }

        const vacancy = STATE.vacancies[STATE.currentVacancyIndex];
        log(`Перехожу к вакансии: "${vacancy.vacancyTitle}"`, 'step');
        persistentLog(`processNextVacancy: Перехожу к вакансии #${STATE.currentVacancyIndex} (${vacancy.vacancyUrl})`);
        setStepDesc(`Переход на URL: ${vacancy.vacancyUrl}`);

        // Если мы уже на нужной странице, начинаем обработку. Иначе - переходим.
        if (window.location.href.split('#')[0] === vacancy.vacancyUrl.split('#')[0]) {
            saveState(); // Сохраняем состояние перед обработкой
            await handleResponsePage(vacancy);
        } else {
            window.location.href = vacancy.vacancyUrl;
        }
    }

    /**
     * Основная логика для страницы с вопросами.
     * @param {object} vacancyData - Данные о текущей вакансии из JSON.
     */
    async function handleResponsePage(vacancyData) {
        persistentLog(`handleResponsePage: Начал обработку страницы для вакансии #${STATE.currentVacancyIndex}`);
        log(`На странице "${vacancyData.vacancyTitle}". Начинаю обработку вопросов.`, 'info');
        setStepDesc(`Отвечаю на вопросы для "${vacancyData.vacancyTitle}"`);

        if (await checkInterrupt(vacancyData)) return;

        // ПРОВЕРКА: если уже откликнулись, пропускаем
        if (isAlreadyRespondedOnPage()) {
            log('Обнаружен маркер "Вы откликнулись". Пропускаю вакансию.', 'warn');
            moveToNextVacancy();
            return;
        }

        const questionBlocks = qsa(SELECTORS.taskBody);
        if (questionBlocks.length === 0) {
            log('Не найдено блоков с вопросами. Пропускаю.', 'warn');
            moveToNextVacancy();
            return;
        }

        let allQuestionsAnswered = true;

        // Проходим по каждому блоку с вопросом на странице
        for (const block of questionBlocks) {
            // Добавляем задержку перед обработкой каждого вопроса
            await wait(CONFIG.fieldFillDelay);
            if (await checkInterrupt(vacancyData)) return;

            const pageQuestionTextEl = qs(SELECTORS.taskQuestion, block);
            if (!pageQuestionTextEl) continue;

            // Нормализуем текст вопроса со страницы: заменяем переносы строк и множественные пробелы на один пробел.
            const pageQuestionText = pageQuestionTextEl.innerText.replace(/\s+/g, ' ').trim();

            // Ищем соответствующий вопрос в наших данных из файла
            const questionData = vacancyData.answers.find(q => {
                // Также нормализуем текст вопроса из JSON перед сравнением.
                const jsonQuestionText = q.question.replace(/\s+/g, ' ').trim();
                return jsonQuestionText === pageQuestionText;
            });

            if (!questionData || !questionData.answer) {
                log(`Ответ для вопроса "${pageQuestionText}" не найден в файле. Пропускаю.`, 'warn');
                allQuestionsAnswered = false;
                continue;
            }

            log(`Найден вопрос: "${pageQuestionText}". Ответ: "${questionData.answer}"`, 'info');

            // В зависимости от типа вопроса, выбираем ответ
            const radioButtons = qsa('input[type="radio"]', block);
            const checkboxes = qsa('input[type="checkbox"]', block);
            const textField = qs('textarea', block) || qs('input[type="text"]', block);

            // --- ОБНОВЛЕННАЯ ЛОГИКА ОБРАБОТКИ ОТВЕТОВ ---

            const processAnswer = async (answer) => {
                let optionText = answer;
                let customText = null;

                if (typeof answer === 'object' && answer !== null && !Array.isArray(answer)) {
                    optionText = answer.option;
                    customText = answer.text;
                }

                const findAndClick = (elements, text) => {
                    const target = Array.from(elements).find(el => {
                        const labelElement = el.closest('label');
                        if (labelElement) {
                            const labelTextElement = labelElement.querySelector('[data-qa="cell-text-content"]');
                            return labelTextElement && labelTextElement.textContent.trim() === text;
                        }
                        return false;
                    });

                    if (target) {
                        // Повторный клик по уже отмеченному чекбоксу снял бы отметку
                        if (!target.checked) target.click();
                        log(`   -> Выбран ответ: "${text}"`, 'success');
                        return target.closest('label');
                    }
                    log(`   -> Не удалось найти вариант: "${text}"`, 'error');
                    allQuestionsAnswered = false;
                    return null;
                };

                if (radioButtons.length > 0) {
                    const clickedLabel = findAndClick(radioButtons, optionText);
                    if (clickedLabel && customText) {
                        await fillCustomText(clickedLabel, customText);
                    }
                } else if (checkboxes.length > 0) {
                    const clickedLabel = findAndClick(checkboxes, optionText);
                    if (clickedLabel && customText) {
                        await fillCustomText(clickedLabel, customText);
                    }
                } else if (textField) {
                    fillTextField(textField, optionText);
                }
            };

            if (Array.isArray(questionData.answer)) { // Мультивыбор (чекбоксы)
                for (const singleAnswer of questionData.answer) {
                    await processAnswer(singleAnswer);
                    await wait(100); // Небольшая пауза между выбором опций
                }
            } else { // Одиночный ответ (радио, текст, или объект для "своего варианта")
                await processAnswer(questionData.answer);
            }
        }

        async function fillCustomText(labelElement, text) {
            const customInput = qs('input[type="text"], textarea', labelElement);
            if (customInput) {
                log(`   -> Заполняю "Свой вариант" текстом: "${text}"`, 'success');
                fillTextField(customInput, text);
            } else {
                log(`   -> Не найдено текстовое поле для "Своего варианта" после выбора опции.`, 'warn');
            }
        }

        function fillTextField(element, text) {
            const elementPrototype = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(elementPrototype, 'value').set;
            if (nativeInputValueSetter) {
                nativeInputValueSetter.call(element, text);
                element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            } else {
                element.value = text;
                element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            }
        }

        if (!allQuestionsAnswered) {
            log('Не на все вопросы были даны ответы. Пропускаю отправку.', 'error');
            moveToNextVacancy();
            return;
        }

        // Прикладываем сопроводительное письмо
        log('Прикладываю сопроводительное письмо...', 'step');
        // Добавляем задержку перед заполнением сопроводительного письма
        await wait(CONFIG.fieldFillDelay);
        if (await checkInterrupt(vacancyData)) return;

        const toggle = qs(SELECTORS.coverLetterToggle);
        if (toggle) {
            toggle.click();
            await wait(1000);
        }

        const coverLetterTextarea = qs(SELECTORS.coverLetterInput);
        if (coverLetterTextarea) {
            let attempts = 0;
            let filled = false;
            while (attempts < 3 && !filled) {
                attempts++;
                log(`Попытка ${attempts}/3: Заполнение сопроводительного письма...`, 'step');
                fillTextField(coverLetterTextarea, CONFIG.coverLetterTemplate);

                await wait(200); // Небольшая пауза для обновления DOM

                if (coverLetterTextarea.value === CONFIG.coverLetterTemplate) {
                    filled = true;
                    log('Сопроводительное письмо вставлено.', 'success');
                } else {
                    log(`Попытка ${attempts} не удалась. Поле не заполнилось.`, 'warn');
                    await wait(500); // Пауза перед следующей попыткой
                }
            }

            if (!filled) {
                log('Не удалось заполнить поле сопроводительного письма после 3 попыток. поле не заполняется, помогите', 'error');
                moveToNextVacancy();
                return;
            }
        } else {
            log('Не найдено поле для сопроводительного письма.', 'warn');
        }

        await wait(500);

        // --- НОВОЕ: Автоматическая отправка ---
        const submitButton = qs(SELECTORS.submitButton);
        if (submitButton && !submitButton.disabled) {
            log(`Все поля заполнены. Ожидаю ${CONFIG.submitDelay / 1000} сек. перед отправкой (можно нажать "Стоп")...`, 'success');
            setStepDesc(`Все поля для "${vacancyData.vacancyTitle}" заполнены. Отправка через ${CONFIG.submitDelay / 1000} сек...`);
            await interruptibleWait(CONFIG.submitDelay);
            if (await checkInterrupt(vacancyData)) return;

            log('Нажимаю "Откликнуться"...', 'step');
            submitButton.click();

            // После клика может выскочить капча — тогда отклик не отправлен
            for (let i = 0; i < 10; i++) {
                await wait(300);
                if (isCaptchaDetected()) {
                    await handleCaptcha(vacancyData);
                    return;
                }
            }
            persistentLog(`handleResponsePage: Отклик на вакансию #${STATE.currentVacancyIndex} отправлен. Вызываю moveToNextVacancy.`);
            log('Отклик отправлен. Перехожу к следующей вакансии.', 'success');
            moveToNextVacancy();
        } else {
            log('Кнопка "Откликнуться" не найдена или неактивна. Пропускаю.', 'error');
            moveToNextVacancy();
        }
    }


    /**
     * Увеличивает индекс и планирует следующий шаг.
     */
    function moveToNextVacancy() {
        STATE.currentVacancyIndex++;
        STATE.pendingManualStep = false;
        saveState();
        updateStats();
        if (STATE.isAutoMode && !stopRequested) {
            if (autoResponseInterval) clearTimeout(autoResponseInterval);
            autoResponseInterval = setTimeout(processNextVacancy, CONFIG.autoModeDelay);
        } else if (STATE.currentVacancyIndex < STATE.vacancies.length) {
            // Ручной режим: один Next = одна вакансия, дальше ждём пользователя
            const next = STATE.vacancies[STATE.currentVacancyIndex];
            setStepDesc(`Готово. Следующая: "${next.vacancyTitle}". Нажмите Next.`);
        } else {
            log('Все вакансии из файла обработаны.', 'success');
            setStepDesc('Все вакансии обработаны.');
        }
    }

    /**
     * Кнопка Next: обработать ровно одну текущую вакансию (перейти на неё, ответить, отправить).
     */
    function manualNext() {
        if (STATE.isAutoMode) return; // в авто-режиме Next не нужен
        stopRequested = false;
        STATE.pendingManualStep = true;
        saveState();
        processNextVacancy();
    }

    // ============================================================
    //  UI ПАНЕЛЬ (стили и шаблоны)
    // ============================================================
    const PANEL_CSS = `
        #hh-responder-panel {
            position: fixed; bottom: 20px; left: 20px; width: 380px; max-height: 450px;
            background: #1a2e1e; border: 2px solid #4CAF50; border-radius: 12px;
            z-index: 99998; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #eee; box-shadow: 0 8px 32px rgba(0,0,0,0.4); display: flex; flex-direction: column;
        }
        #hh-responder-header {
            background: #4CAF50; padding: 10px 15px; cursor: move; font-weight: bold;
        }
        #hh-responder-body { padding: 15px; overflow-y: auto; flex: 1; }
        .resp-btn { padding: 8px 15px; border: none; border-radius: 6px; cursor: pointer; margin-right: 10px; }
        .resp-btn-primary { background: #4CAF50; color: white; }
        .resp-btn-secondary { background: #333; color: white; }
        .resp-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        #hh-responder-log {
            background: #0d1117; border-radius: 6px; padding: 8px; height: 120px; overflow-y: auto;
            font-size: 11px; margin-top: 10px; line-height: 1.5;
        }
        .log-info { color: #58a6ff; } .log-success { color: #3fb950; }
        .log-warn { color: #d29922; } .log-error { color: #f85149; } .log-step { color: #bc8cff; }
        .resp-check { display: flex; align-items: center; gap: 6px; margin-top: 10px; font-size: 12px; color: #ccc; cursor: pointer; }
        .resp-check-note { font-size: 11px; color: #f85149; margin-top: 2px; }
    `;

    function panelHTML() {
        return `
            <div id="hh-responder-header">HH AutoResponder</div>
            <div id="hh-responder-body">
                <p><b>Статус:</b> <span id="resp-step-desc">Ожидание файла...</span></p>
                <p><b id="resp-stats">Вакансий: 0 | Обработано: 0</b></p>
                <input type="file" id="resp-file-input" accept=".json" style="margin-bottom: 10px;">
                <div>
                    <button id="resp-btn-next" class="resp-btn resp-btn-primary" disabled>Next</button>
                    <button id="resp-btn-auto" class="resp-btn resp-btn-secondary" disabled>Автоответ</button>
                    <button id="resp-btn-stop" class="resp-btn" style="background: #f44336; color: white;" disabled>Стоп</button>
                </div>
                <label class="resp-check">
                    <input type="checkbox" id="resp-input-ignore-captcha" ${CONFIG.ignoreCaptcha ? 'checked' : ''} />
                    Не останавливаться при капче
                </label>
                <div class="resp-check-note" id="resp-ignore-captcha-note" style="display:${CONFIG.ignoreCaptcha ? 'block' : 'none'};">
                    ⚠ Капча игнорируется — работа на свой риск
                </div>
                <div id="hh-responder-log"></div>
            </div>
        `;
    }

    function createUI() {
        GM_addStyle(PANEL_CSS);

        const panel = document.createElement('div');
        panel.id = 'hh-responder-panel';
        panel.innerHTML = panelHTML();
        document.body.appendChild(panel);

        document.getElementById('resp-file-input').addEventListener('change', handleFileSelect);
        document.getElementById('resp-btn-next').onclick = manualNext;
        document.getElementById('resp-btn-auto').onclick = toggleAutoMode;
        document.getElementById('resp-btn-stop').onclick = stopScript;
        document.getElementById('resp-input-ignore-captcha').addEventListener('change', (e) => {
            if (e.target.checked && !window.confirm(CAPTCHA_IGNORE_WARNING)) {
                e.target.checked = false;
                return;
            }
            CONFIG.ignoreCaptcha = e.target.checked;
            saveConfig();
            document.getElementById('resp-ignore-captcha-note').style.display = CONFIG.ignoreCaptcha ? 'block' : 'none';
            log(CONFIG.ignoreCaptcha
                ? 'Капча игнорируется: скрипт не будет останавливаться (на свой риск)'
                : 'При капче скрипт будет останавливаться', CONFIG.ignoreCaptcha ? 'warn' : 'success');
        });

        initDragDrop(panel, 'hh-responder-header', 'hh_responder_panel_pos');
    }

    function initDragDrop(panel, headerId, posKey) {
        const header = document.getElementById(headerId);
        if (!header) return;
        let isDragging = false;
        let dragOffsetX = 0;
        let dragOffsetY = 0;

        const savedPos = GM_getValue(posKey, null);
        if (savedPos) {
            panel.style.bottom = 'auto';
            panel.style.left = savedPos.left;
            panel.style.top = savedPos.top;
        }

        header.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
            isDragging = true;
            const rect = panel.getBoundingClientRect();
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;

            panel.style.bottom = 'auto';
            panel.style.right = 'auto';
            panel.style.margin = '0';

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });

        function onMouseMove(e) {
            if (!isDragging) return;
            panel.style.left = (e.clientX - dragOffsetX) + 'px';
            panel.style.top = (e.clientY - dragOffsetY) + 'px';
        }

        function onMouseUp() {
            isDragging = false;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            GM_setValue(posKey, { left: panel.style.left, top: panel.style.top });
        }
    }

    function updateLogPanel(msg, type) {
        const logEl = document.getElementById('hh-responder-log');
        if (!logEl) return;
        const line = document.createElement('div');
        line.className = 'log-' + type;
        line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        logEl.appendChild(line);
        // Ограничиваем количество строк в панели, чтобы не разрастался DOM
        while (logEl.children.length > 200) {
            logEl.removeChild(logEl.firstChild);
        }
        logEl.scrollTop = logEl.scrollHeight;
    }

    function setStepDesc(text) {
        const el = document.getElementById('resp-step-desc');
        if (el) el.textContent = text;
    }

    function updateStats() {
        const el = document.getElementById('resp-stats');
        if (el) {
            el.textContent = `Вакансий: ${STATE.vacancies.length} | Обработано: ${STATE.currentVacancyIndex}`;
        }
    }

    /**
     * Полностью останавливает скрипт.
     */
    function stopScript() {
        log('Скрипт остановлен пользователем. Можно отвечать вручную.', 'error');
        haltScript();
        setStepDesc('Остановлено. Нажмите Next (одна вакансия) или "Автоответ".');
    }

    // Остановка без сообщений: гасит авто-режим, таймеры и текущую обработку (переживает перезагрузку)
    function haltScript() {
        stopRequested = true;
        if (autoResponseInterval) {
            clearTimeout(autoResponseInterval);
            autoResponseInterval = null;
        }
        STATE.isAutoMode = false;
        STATE.pendingManualStep = false;
        saveState();
        updateAutoButton();
    }

    function updateAutoButton() {
        const btn = document.getElementById('resp-btn-auto');
        if (!btn) return;
        btn.textContent = STATE.isAutoMode ? 'Пауза' : 'Автоответ';
        btn.style.background = STATE.isAutoMode ? '#FF9800' : '';
    }

    function toggleAutoMode() {
        if (STATE.isAutoMode) {
            log('Авто-режим остановлен.', 'warn');
            haltScript();
            setStepDesc('Авто-режим остановлен.');
            return;
        }
        stopRequested = false;
        STATE.isAutoMode = true;
        STATE.pendingManualStep = false;
        saveState();
        updateAutoButton();
        log('Авто-режим запущен.', 'warn');
        processNextVacancy();
    }

    /**
     * Читает и обрабатывает выбранный JSON-файл.
     * @param {Event} evt - Событие выбора файла.
     */
    function handleFileSelect(evt) {
        const file = evt.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                // Фильтруем только те вакансии, где есть вопросы и ответы
                // ИЗМЕНЕНО: фильтруем по v.answers
                STATE.vacancies = data.filter(v => v.answers && v.answers.some(q => q.answer));
                STATE.currentVacancyIndex = 0;
                // Загрузка файла НИЧЕГО не запускает: старт только по Next или "Автоответ"
                haltScript();
                if (STATE.vacancies.length > 0) {
                    log(`Загружено ${STATE.vacancies.length} вакансий с ответами.`, 'success');
                    setStepDesc('Файл загружен. Нажмите Next (одна вакансия) или "Автоответ".');
                    document.getElementById('resp-btn-next').disabled = false;
                    document.getElementById('resp-btn-auto').disabled = false;
                    document.getElementById('resp-btn-stop').disabled = false;
                } else {
                    log('В файле не найдено вакансий с вопросами и ответами.', 'warn');
                    setStepDesc('В файле нет подходящих вакансий.');
                }
                updateStats();
            } catch (ex) {
                log('Ошибка парсинга JSON: ' + ex.message, 'error');
                setStepDesc('Ошибка чтения файла.');
            }
        };
        reader.readAsText(file);
    }

    /**
     * Инициализация скрипта.
     */
    async function init() {
        // --- НОВАЯ ПРОВЕРКА ---
        // Игнорируем служебные страницы, на которых скрипт не должен работать.
        if (window.location.hostname.startsWith('websocket.')) {
            console.log('[HH-Responder] Скрипт запущен на служебной странице websocket.hh.ru, работа прекращена.');
            return;
        }
        persistentLog(`init: Скрипт запущен на URL: ${window.location.href}`);
        // Создаем UI на всех страницах, где сработает скрипт
        createUI();
        await loadState();
        updateStats();
        updateAutoButton();

        // Выводим историю логов для отладки
        if (STATE.persistentLogs.length > 0) {
            console.log('%c[Persistent] История последних действий:', 'color: #f0f; font-weight: bold; font-size: 14px;');
            [...STATE.persistentLogs].reverse().forEach(logMsg => {
                console.log(`%c  -> ${logMsg}`, 'color: #f0f;');
            });
        }
        persistentLog(`init: Состояние восстановлено. isAutoMode: ${STATE.isAutoMode}, currentVacancyIndex: ${STATE.currentVacancyIndex}`);

        if (STATE.vacancies.length > 0 && STATE.currentVacancyIndex < STATE.vacancies.length) {
            log(`Восстановлено состояние: ${STATE.vacancies.length} вакансий, текущая #${STATE.currentVacancyIndex + 1}`, 'success');
            setStepDesc(`Готов к работе. Следующая: "${STATE.vacancies[STATE.currentVacancyIndex].vacancyTitle}"`);
            document.getElementById('resp-btn-next').disabled = false;
            document.getElementById('resp-btn-auto').disabled = false;
            document.getElementById('resp-btn-stop').disabled = false;

            // Сам по себе скрипт ничего не запускает: работаем только в авто-режиме
            // или если пользователь нажал Next (pendingManualStep)
            const vacancy = STATE.vacancies[STATE.currentVacancyIndex];
            const onVacancyPage = window.location.href.split('#')[0] === vacancy.vacancyUrl.split('#')[0];
            const shouldWork = STATE.isAutoMode || STATE.pendingManualStep;

            if (!shouldWork) {
                persistentLog('init: скрипт на паузе, ничего не делаю.');
                if (onVacancyPage) setStepDesc(`Пауза. Вы на странице "${vacancy.vacancyTitle}" — отвечайте вручную или нажмите Next.`);
                return;
            }

            if (isCaptchaDetected()) {
                await handleCaptcha(vacancy);
                return;
            }

            if (onVacancyPage) {
                persistentLog(`init: URL совпал, вызываю handleResponsePage для вакансии #${STATE.currentVacancyIndex}`);
                await handleResponsePage(vacancy);
            } else if (STATE.isAutoMode) {
                persistentLog(`init: URL НЕ совпал. Текущий: ${window.location.href}, ожидаемый: ${vacancy.vacancyUrl}.`);
                log('Авто-режим включен, но мы не на нужной странице. Инициирую переход...', 'warn');
                processNextVacancy();
            } else {
                // Next нажат, но страница вакансии не открылась (редирект и т.п.) — не зацикливаемся
                STATE.pendingManualStep = false;
                saveState();
                setStepDesc(`Не удалось открыть страницу вакансии. Нажмите Next ещё раз.`);
            }
        }
    }

    // Запуск
    init();
})();
