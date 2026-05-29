// ==UserScript==
// @name         HH.ru AutoApply
// @namespace    http://tampermonkey.net/
// @version      0.2.0
// @description  Автоматический отклик на hh.ru с сопроводительным письмом. Поддерживает ручной (Next) и авто-режим.
// @author       You
// @match        https://*.hh.ru/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    //  КОНФИГУРАЦИЯ
    // ============================================================
    const CONFIG = {
        // Шаблон сопроводительного письма.
        coverLetterTemplate: `Здравствуйте.
Меня заинтересовала ваша вакансия.
У меня более 6 лет опыта в тестировании веб- и backend-приложений. Работал с функциональным, регрессионным и API-тестированием, анализом требований, локализацией дефектов и сопровождением релизов.
Использую в работе SQL, Postman, REST API, Jira, Git. Также участвовал во внедрении автотестов на Playwright и автоматизации отдельных QA-процессов.
Основной фокус в работе — поиск критичных сценариев и снижение рисков до релиза, а не только формальное прохождение тест-кейсов. Есть опыт взаимодействия с разработчиками, аналитиками и product-командой при проработке требований и проверке новых фич.
Буду рад обсудить, как мой опыт может быть полезен вашей команде.
С уважением,
Александр Пантин
Telegram: @alxptn
Email: pantin_42@inbox.ru`,
        // Задержка перед кликом (мс)
        clickDelay: 300,
        // URL поиска вакансий для возврата при редиректе на страницу отклика (questions)
        searchRedirectUrl: "https://tver.hh.ru/search/vacancy?resume=3340516fff092acd5b0039ed1f737448347a6b&text=&excluded_text=&area=113&salary=&salary=&currency_code=RUR&experience=doesNotMatter&order_by=relevance&search_period=0&items_on_page=100&L_save_area=true&hhtmFrom=vacancy_search_filter",
        // Дневной лимит откликов
        dailyLimit: 150,
    };

    // ============================================================
    //  СЕЛЕКТОРЫ hh.ru (вычислены из анализа HTML-страниц)
    // ============================================================
    const SELECTORS = {
        // --- Страница поиска вакансий ---
        vacancyCard: '[data-qa="vacancy-serp__vacancy"]',
        vacancyTitle: '[data-qa="serp-item__title"]',
        vacancyTitleLink: 'a[data-qa="serp-item__title"]',
        applyButton: '[data-qa="vacancy-serp__vacancy_response"]',

        // --- Модалка отклика (popup) ---
        responseModal: '[data-qa="vacancy-response-popup"]',
        responseModalTitle: '[data-qa="title"]',
        responseModalClose: '[data-qa="response-popup-close"]',
        // Основное поле в popup
        coverLetterInput: '[data-qa="vacancy-response-popup-form-letter-input"]',
        // Альтернативные селекторы для inline-формы, появляющейся после клика "Приложить письмо"
        coverLetterInputAlt: 'form[id^="cover-letter-"] textarea[name="text"], [data-qa="textarea-native-wrapper"] textarea, textarea[name="text"]',
        // Кнопки отправки: popup и inline-форма
        submitButton: '[data-qa="vacancy-response-submit-popup"], [data-qa="vacancy-response-letter-submit"]',
        generateCoverLetterBtn: '[data-qa="generate-cover-letter"]',
        coverLetterToggle: '[data-qa="vacancy-response-letter-toggle"], [data-qa="vacancy-response-letter-toggle-text"]',

        // --- Страница вопросов (вместо модалки — полный редирект) ---
        employerAskingForTest: '[data-qa="employer-asking-for-test"]',
        taskQuestion: '[data-qa="task-question"]',
        testDescription: '[data-qa="test-description"]',
        taskBody: '[data-qa="task-body"]',
        radioInput: 'input[type="radio"]',
        vacancyResponseForm: '#RESPONSE_MODAL_FORM_ID',

        // --- Страница уже откликнулся ---
        alreadyRespondedText: '[data-qa="already-responded-text"]',

        // --- Общие ---
        coverLetterRequired: 'Сопроводительное письмо обязательное',
        resumeTitle: '[data-qa="resume-title"]',
    };

    // ============================================================
    //  СОСТОЯНИЕ
    // ============================================================
    const STATE = {
        stepIndex: 0,
        steps: [],
        vacancies: [],
        currentVacancyIndex: 0,
        outlineLinks: [],     // вакансии, требующие ручной обработки
        // URL вакансий, которые требуют ответов/аутлайн и должны быть пропущены
        skippedVacancyUrls: [],
        appliedCount: 0,
        skippedCount: 0,
        isRunning: false,
        returnedFromOutline: false,  // флаг: вернулись ли с страницы вопросов
        retryDelay: 0,              // 0 - первый сбор, 3000 - второй, 7000 - третий и далее
    };

    function saveState() {
        GM_setValue('hh_autoapply_state', {
            outlineLinks: STATE.outlineLinks,
            appliedCount: STATE.appliedCount,
            skippedCount: STATE.skippedCount,
            skippedVacancyUrls: STATE.skippedVacancyUrls,
            returnedFromOutline: STATE.returnedFromOutline,
            isRunning: STATE.isRunning,
            retryDelay: STATE.retryDelay
        });
    }

    // ============================================================
    //  ДНЕВНОЙ ЛИМИТ ОТКЛИКОВ
    // ============================================================
    function getTodayStr() {
        return new Date().toISOString().split('T')[0]; // 'YYYY-MM-DD'
    }

    function getDailyCount() {
        const saved = GM_getValue('hh_daily_counter', {});
        const today = getTodayStr();
        if (saved.date === today) {
            return saved.count || 0;
        }
        return 0;
    }

    function incrementDailyCount() {
        const saved = GM_getValue('hh_daily_counter', {});
        const today = getTodayStr();
        const count = (saved.date === today ? (saved.count || 0) : 0) + 1;
        GM_setValue('hh_daily_counter', { date: today, count: count });
        return count;
    }

    function isDailyLimitReached() {
        return getDailyCount() >= CONFIG.dailyLimit;
    }

    function getRemainingDailyCount() {
        const remaining = CONFIG.dailyLimit - getDailyCount();
        return remaining > 0 ? remaining : 0;
    }

    // ============================================================
    //  УТИЛИТЫ
    // ============================================================
    function log(msg, type = 'info') {
        const prefix = '[HH-AutoApply]';
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

    function wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function qs(selector, parent = document) {
        return parent.querySelector(selector);
    }

    function qsa(selector, parent = document) {
        return Array.from(parent.querySelectorAll(selector));
    }

    function isAlreadyResponded(card) {
        if (!card) return false;
        // Ищем явный маркер отклика
        if (card.querySelector('[data-qa="vacancy-serp__vacancy_responded"]')) return true;
        // Или текстовый маркер внутри карточки
        try {
            // Очищаем от неразрывных пробелов (&nbsp; -> \u00A0)
            const txt = (card.textContent || '').replace(/\u00A0/g, ' ').trim();
            if (txt.includes('Вы откликнулись')) return true;
        } catch (e) {}
        return false;
    }

    // Заполняет textarea письмом и обновляет визуальный клон magritte
    function fillTextarea(textarea) {
        const letterText = CONFIG.coverLetterTemplate;
        textarea.focus();
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
        ).set;
        nativeInputValueSetter.call(textarea, letterText);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
        // Обновляем визуальный клон magritte
        try {
            const wrapper = textarea.closest('[data-qa="textarea-native-wrapper"]') || textarea.parentElement;
            if (wrapper) {
                const clonePre = wrapper.querySelector('pre') || wrapper.querySelector('[class*="magritte-value-clone"] pre');
                if (clonePre) clonePre.textContent = letterText;
            }
        } catch (e) { /* не критично */ }
    }

    // Находит textarea для письма: если есть кнопка "Приложить письмо" — кликает, иначе ищет напрямую
    async function ensureCoverLetterFieldVisible() {
        const toggle = qs(SELECTORS.coverLetterToggle);
        if (toggle) {
            log('Нажимаю кнопку "Приложить письмо"...', 'step');
            const clickTarget = toggle.closest('button, [role="button"], label') || toggle;
            clickTarget.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
            await wait(100);
            clickTarget.click();
            // Ждём появления и завершения анимации textarea (выезжает сверху)
            await wait(1500);
            let textarea = qs(SELECTORS.coverLetterInput) || qs(SELECTORS.coverLetterInputAlt);
            if (textarea) return textarea;
            log('После клика поле письма не найдено, пробую ещё раз...', 'warn');
            clickTarget.click();
            await wait(1500);
            textarea = qs(SELECTORS.coverLetterInput) || qs(SELECTORS.coverLetterInputAlt);
            if (textarea) return textarea;
        } else {
            log('Кнопка "Приложить письмо" не найдена', 'warn');
        }
        return qs(SELECTORS.coverLetterInput) || qs(SELECTORS.coverLetterInputAlt);
    }

    // Сценарий 2: модальное окно с обязательным письмом (textarea видна сразу)
    async function handleModalForCoverLetterOnSearchPage(vacancy) {
        log('Обработка модального окна письма на странице поиска...', 'step');
        
        // Ищем textarea
        const textarea = qs(SELECTORS.coverLetterInput) || qs(SELECTORS.coverLetterInputAlt);
        if (!textarea) {
            log('Textarea для письма не найдена', 'warn');
            return false;
        }

        // Заполняем письмо
        fillTextarea(textarea);
        log('Письмо заполнено', 'success');
        await wait(300);

        // Ищем кнопку "Откликнуться" в модальном окне
        let applyBtn = null;
        try {
            // Ищем в модалке - проверяем селектор submit button
            applyBtn = qs(SELECTORS.submitButton);
            if (!applyBtn) {
                // Ищем по тексту или классам magritte
                const btns = qsa('button, [role="button"]');
                for (const btn of btns) {
                    const txt = (btn.textContent || '').trim();
                    if (txt === 'Откликнуться' || txt.includes('Откликнуться')) {
                        applyBtn = btn;
                        break;
                    }
                }
            }
        } catch (e) { log('Ошибка поиска кнопки: ' + e.message, 'error'); }

        if (!applyBtn) {
            log('Кнопка "Откликнуться" не найдена в модальном окне', 'warn');
            return false;
        }

        // Кликаем кнопку
        try {
            applyBtn.scrollIntoView({ block: 'center', inline: 'center' });
            await wait(100);
            applyBtn.click();
            log('Нажата кнопка "Откликнуться" в модальном окне', 'step');
        } catch (e) { 
            log('Ошибка клика по кнопке: ' + e.message, 'error');
            return false;
        }

        // Ждём результата: либо карточка обновится, либо редирект
        for (let i = 0; i < 12; i++) {
            await wait(500);

            // Проверяем редирект на страницу вопросов
            if (detectPageType() === 'response') {
                log('После отклика произошёл редирект на страницу вопросов. Сохраняю в аутлайн и возвращаюсь на поиск.', 'warn');
                addToOutline(vacancy.title, vacancy.link || window.location.href);
                STATE.returnedFromOutline = true;
                saveState();
                try { window.location.href = CONFIG.searchRedirectUrl; } catch (e) { }
                return false;
            }

            // Проверяем, исчезло ли модальное окно (модалка закрылась - отклик отправлен)
            const stillHasTextarea = qs(SELECTORS.coverLetterInput) || qs(SELECTORS.coverLetterInputAlt);
            if (!stillHasTextarea) {
                log('Модальное окно закрылось - отклик отправлен', 'success');
                return true;
            }
        }

        log('Не удалось определить результат отклика, но письмо было отправлено', 'warn');
        return true;
    }

    // Сценарий 1: inline-карточка с кнопкой "Приложить письмо" (письмо необязательно)
    async function handleInlineCoverLetterCard(vacancy) {
        const textarea = await ensureCoverLetterFieldVisible();
        if (!textarea) {
            log('Не удалось открыть поле для сопроводительного письма.', 'warn');
            return false;
        }

        fillTextarea(textarea);
        log('Сопроводительное письмо вставлено в inline-карточку.', 'success');
        await wait(300);

        // Попробуем найти кнопку отклика в карточке: сначала по известным селекторам, затем по тексту 'Откликнуться'
        let applyBtn = null;
        try {
            applyBtn = qs(SELECTORS.submitButton, vacancy.card) || qs(SELECTORS.applyButton, vacancy.card) || qs(SELECTORS.applyButton);
            if (!applyBtn) {
                // Ищем span с текстом или magritte label
                const labels = vacancy.card ? Array.from(vacancy.card.querySelectorAll('span')) : [];
                for (const l of labels) {
                    const txt = (l.textContent || '').trim();
                    if (txt === 'Откликнуться' || txt.includes('Откликнуться')) {
                        applyBtn = l.closest('button') || l.parentElement;
                        break;
                    }
                }
            }
        } catch (e) { log('Ошибка при поиске кнопки отклика: ' + e.message, 'error'); }

        if (!applyBtn) {
            log('Кнопка "Откликнуться" не найдена в карточке. Оставляю заполненным и помечаю для ручной проверки.', 'warn');
            return false;
        }

        // Кликаем кнопку отклика
        try {
            applyBtn.scrollIntoView({ block: 'center', inline: 'center' });
            await wait(100);
            applyBtn.click();
            log('Нажата кнопка "Откликнуться"', 'step');
        } catch (e) { log('Не удалось кликнуть кнопку отклика: ' + e.message, 'error'); }

        // Ждём результата: либо карточка сменит состояние на "Вы откликнулись", либо будет редирект на страницу отклика (questions)
        for (let i = 0; i < 12; i++) {
            await wait(500);
            // Редирект на страницу отклика
            if (detectPageType() === 'response') {
                log('После клика произошёл редирект на страницу отклика (вопросы). Сохраняю в аутлайн и возвращаюсь на поиск.', 'warn');
                addToOutline(vacancy.title, vacancy.link || window.location.href);
                STATE.returnedFromOutline = true;
                saveState();
                try { window.location.href = CONFIG.searchRedirectUrl; } catch (e) { log('Не удалось перенаправить: ' + e.message, 'error'); }
                return false;
            }

            // Проверяем, сменился ли статус карточки на отвеченный
            if (isAlreadyResponded(vacancy.card)) {
                STATE.appliedCount++;
                incrementDailyCount();
                log(`Отклик зарегистрирован для: "${vacancy.title}"`, 'success');
                if (isDailyLimitReached()) {
                    log('Достигнут дневной лимит откликов! (' + CONFIG.dailyLimit + ')', 'error');
                    setStepDesc('⚠ Достигнут дневной лимит (' + CONFIG.dailyLimit + ' откликов)!');
                }
                return true;
            }
        }

        log('Не удалось обнаружить подтверждение отклика после нажатия. Проверьте вручную.', 'warn');
        return false;
    }

    // Определяем тип текущей страницы
    function detectPageType() {
        const url = location.href;
        if (url.includes('/search/vacancy')) return 'search';
        if (url.includes('/applicant/vacancy_response')) return 'response';
        if (url.includes('/vacancy/')) return 'vacancy';
        return 'unknown';
    }

    // Определяем тип отклика
    function detectResponseType() {
        // Есть вопросы работодателя? (full page /applicant/vacancy_response)
        if (qs(SELECTORS.employerAskingForTest)) return 'outline';  // вопросы = аутлайн
        if (qs(SELECTORS.testDescription) || qs(SELECTORS.taskBody)) return 'outline';

        const titleDesc = qs('[data-qa="title-description"]');
        if (titleDesc) {
            const cleanText = titleDesc.textContent.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ');
            if (cleanText.includes('ответить на несколько вопросов')) return 'outline';
        }

        // Модалка с сопроводительным (обязательным или нет)
        const modal = qs(SELECTORS.responseModal);
        if (modal) {
            const requiredText = modal.textContent || '';
            if (requiredText.includes('Сопроводительное письмо обязательное')) return 'deferred';
            // Если есть кнопка "Приложить письмо" — тоже deferred (письмо можно приложить)
            if (qs(SELECTORS.coverLetterToggle, modal)) return 'deferred';
            return 'instant';
        }

        // Страница отклика (не модалка)
        if (detectPageType() === 'response') {
            const pageText = document.body.textContent || '';
            const cleanPageText = pageText.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ');
            if (cleanPageText.includes('ответить на несколько вопросов')) return 'outline';
            if (cleanPageText.includes('Сопроводительное письмо обязательное')) return 'deferred';
            return 'instant';
        }

        return 'unknown';
    }

    // ============================================================
    //  UI ПАНЕЛЬ
    // ============================================================
    function createUI() {
        // Стили
        GM_addStyle(`
            #hh-autoapply-panel {
                position: fixed;
                bottom: 20px;
                right: 20px;
                width: 420px;
                max-height: 500px;
                background: #1a1a2e;
                border: 2px solid #e94560;
                border-radius: 12px;
                z-index: 99999;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                font-size: 13px;
                color: #eee;
                overflow: hidden;
                box-shadow: 0 8px 32px rgba(0,0,0,0.4);
                display: flex;
                flex-direction: column;
            }
            #hh-autoapply-panel.minimized {
                max-height: 48px;
            }
            #hh-autoapply-header {
                background: #e94560;
                padding: 12px 16px;
                cursor: move;
                display: flex;
                justify-content: space-between;
                align-items: center;
                font-weight: bold;
                font-size: 14px;
                user-select: none;
            }
            #hh-autoapply-header button {
                background: none;
                border: none;
                color: white;
                font-size: 18px;
                cursor: pointer;
                padding: 0 4px;
            }
            #hh-autoapply-body {
                padding: 12px 16px;
                overflow-y: auto;
                max-height: 400px;
                flex: 1;
            }
            .hh-step-info {
                background: #16213e;
                border-radius: 8px;
                padding: 10px 12px;
                margin-bottom: 8px;
                border-left: 3px solid #e94560;
            }
            .hh-step-info .step-label {
                color: #e94560;
                font-weight: bold;
                font-size: 12px;
                text-transform: uppercase;
            }
            .hh-step-info .step-desc {
                margin-top: 4px;
                color: #ccc;
                line-height: 1.4;
            }
            .hh-btn {
                display: inline-block;
                padding: 8px 20px;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-size: 13px;
                font-weight: 600;
                margin: 4px;
                transition: all 0.2s;
            }
            .hh-btn:hover { opacity: 0.9; transform: translateY(-1px); }
            .hh-btn-primary { background: #e94560; color: white; }
            .hh-btn-secondary { background: #0f3460; color: white; }
            .hh-btn-success { background: #4CAF50; color: white; }
            .hh-btn-warn { background: #FF9800; color: white; }
            .hh-btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }
            .hh-stats {
                display: flex;
                gap: 12px;
                margin: 8px 0;
                flex-wrap: wrap;
            }
            .hh-stat {
                background: #16213e;
                padding: 6px 12px;
                border-radius: 6px;
                text-align: center;
            }
            .hh-stat-val { font-size: 18px; font-weight: bold; color: #e94560; }
            .hh-stat-label { font-size: 10px; color: #888; text-transform: uppercase; }
            #hh-autoapply-log {
                background: #0d1117;
                border-radius: 6px;
                padding: 8px;
                max-height: 120px;
                overflow-y: auto;
                font-family: 'Consolas', 'Monaco', monospace;
                font-size: 11px;
                margin-top: 8px;
                line-height: 1.5;
            }
            .log-info { color: #58a6ff; }
            .log-success { color: #3fb950; }
            .log-warn { color: #d29922; }
            .log-error { color: #f85149; }
            .log-step { color: #bc8cff; }
            .hh-btn-row { display: flex; gap: 8px; margin: 8px 0; flex-wrap: wrap; }
        `);

        // Панель
        const panel = document.createElement('div');
        panel.id = 'hh-autoapply-panel';
        panel.innerHTML = `
            <div id="hh-autoapply-header">
                <span>HH AutoApply (Trace)</span>
                <div>
                    <button id="hh-btn-minimize" title="Свернуть">_</button>
                </div>
            </div>
            <div id="hh-autoapply-body">
                <div class="hh-stats">
                    <div class="hh-stat">
                        <div class="hh-stat-val" id="hh-stat-applied">0</div>
                        <div class="hh-stat-label">Отклики</div>
                    </div>
                    <div class="hh-stat">
                        <div class="hh-stat-val" id="hh-stat-skipped">0</div>
                        <div class="hh-stat-label">Пропущено</div>
                    </div>
                    <div class="hh-stat">
                        <div class="hh-stat-val" id="hh-stat-outline">0</div>
                        <div class="hh-stat-label">Аутлайн</div>
                    </div>
                    <div class="hh-stat">
                        <div class="hh-stat-val" id="hh-stat-total">0</div>
                        <div class="hh-stat-label">Всего</div>
                    </div>
                    <div class="hh-stat" style="border: 1px solid #e94560;">
                        <div class="hh-stat-val" id="hh-stat-daily">0</div>
                        <div class="hh-stat-label">Дневной лимит / ${CONFIG.dailyLimit}</div>
                    </div>
                </div>
                <div class="hh-step-info" id="hh-current-step">
                    <div class="step-label">Текущий шаг</div>
                    <div class="step-desc" id="hh-step-desc">Нажмите "Собрать вакансии" для начала</div>
                </div>
                <div class="hh-btn-row">
                    <button class="hh-btn hh-btn-primary" id="hh-btn-collect">Собрать вакансии</button>
                    <button class="hh-btn hh-btn-success" id="hh-btn-next" disabled>Next →</button>
                    <button class="hh-btn hh-btn-secondary" id="hh-btn-auto">Авто</button>
                    <button class="hh-btn hh-btn-warn" id="hh-btn-show-outline">Аутлайн</button>
                    <button class="hh-btn hh-btn-error" id="hh-btn-clear-outline" style="background:#555;color:white;">Очистить</button>
                </div>
                <div id="hh-autoapply-log"></div>
            </div>
        `;
        document.body.appendChild(panel);

        // Кнопки
        const btnMinimize = document.getElementById('hh-btn-minimize');
        if (btnMinimize) btnMinimize.onclick = () => panel.classList.toggle('minimized');
        
        const btnCollect = document.getElementById('hh-btn-collect');
        if (btnCollect) btnCollect.onclick = collectVacancies;
        
        const btnNext = document.getElementById('hh-btn-next');
        if (btnNext) btnNext.onclick = executeNextStep;
        
        const btnAuto = document.getElementById('hh-btn-auto');
        if (btnAuto) btnAuto.onclick = toggleAutoMode;
        
        const btnShowOutline = document.getElementById('hh-btn-show-outline');
        if (btnShowOutline) btnShowOutline.onclick = showOutlineLinks;
        
        const btnClearOutline = document.getElementById('hh-btn-clear-outline');
        if (btnClearOutline) btnClearOutline.onclick = clearOutlineLinks;

        updateAutoButton();

        log('Панель загружена. Страница: ' + detectPageType());
    }

    function updateLogPanel(msg, type = 'info') {
        const logEl = document.getElementById('hh-autoapply-log');
        if (!logEl) return;
        const line = document.createElement('div');
        line.className = 'log-' + type;
        const time = new Date().toLocaleTimeString('ru-RU');
        line.textContent = `[${time}] ${msg}`;
        logEl.appendChild(line);
        logEl.scrollTop = logEl.scrollHeight;
    }

    function updateStats() {
        const el = (id) => document.getElementById(id);
        if (el('hh-stat-applied')) el('hh-stat-applied').textContent = STATE.appliedCount;
        if (el('hh-stat-skipped')) el('hh-stat-skipped').textContent = STATE.skippedCount;
        if (el('hh-stat-outline')) el('hh-stat-outline').textContent = STATE.outlineLinks.length;
        if (el('hh-stat-total')) el('hh-stat-total').textContent = STATE.vacancies.length || '-';
        if (el('hh-stat-daily')) {
            const daily = getDailyCount();
            const remaining = getRemainingDailyCount();
            el('hh-stat-daily').textContent = `${daily} / ${CONFIG.dailyLimit}`;
            // Если лимит исчерпан — подсвечиваем красным
            if (daily >= CONFIG.dailyLimit) {
                el('hh-stat-daily').style.color = '#f85149';
            } else {
                el('hh-stat-daily').style.color = '#e94560';
            }
        }
    }

    function setStepDesc(text) {
        const el = document.getElementById('hh-step-desc');
        if (el) el.textContent = text;
    }

    // ============================================================
    //  ЛОГИКА ОТКЛИКОВ
    // ============================================================

    // Собрать вакансии со страницы поиска
    function collectVacancies() {
        const pageType = detectPageType();

        if (pageType !== 'search') {
            log('Вы не на странице поиска вакансий! Перейдите на /search/vacancy', 'error');
            return false;
        }

        // Ищем карточки вакансий
        const cards = qsa(SELECTORS.vacancyCard);

        STATE.vacancies = [];
        STATE.currentVacancyIndex = 0;

        cards.forEach((card, idx) => {
            if (isAlreadyResponded(card)) {
                log(`Пропускаю уже откликавшуюся вакансию (карточка #${idx + 1})`, 'info');
                return;
            }
            const titleEl = qs(SELECTORS.vacancyTitleLink, card) || qs(SELECTORS.vacancyTitle, card);
            const title = titleEl ? titleEl.textContent.trim() : `Вакансия #${idx + 1}`;
            const link = titleEl ? titleEl.href : '';
            if (link && STATE.skippedVacancyUrls.includes(link)) {
                log(`Пропускаю запомненную аутлайн-вакансию: ${link}`, 'info');
                return;
            }
            const applyBtn = qs(SELECTORS.applyButton, card);

            STATE.vacancies.push({
                index: idx,
                title: title,
                link: link,
                applyBtn: applyBtn,
                card: card,
            });
        });

        updateStats();

        // Если вакансий не найдено — переходим по URL и ждём
        if (STATE.vacancies.length === 0) {
            const delay = STATE.retryDelay || 3000;
            log(`Вакансии не найдены. Перехожу по URL и жду ${delay/1000} сек...`, 'warn');
            setStepDesc(`Вакансии не найдены. Перезагрузка (ожидание ${delay/1000} сек)...`);
            // Увеличиваем задержку для следующего раза: 0→3сек, 3→7сек, 7→7сек
            STATE.retryDelay = STATE.retryDelay === 0 ? 3000 : 7000;
            saveState();
            window.location.href = CONFIG.searchRedirectUrl;
            return false;
        }
        
        // Сброс retryDelay при успешном сборе
        STATE.retryDelay = 0;

        log(`Найдено ${STATE.vacancies.length} вакансий на странице`, 'success');
        setStepDesc(`Найдено ${STATE.vacancies.length} вакансий. Нажмите Next для отклика на первую.`);
        document.getElementById('hh-btn-next').disabled = false;
        return true;
    }

    // Проверка дневного лимита
    function checkDailyLimitAndStop() {
        if (isDailyLimitReached()) {
            log('Достигнут дневной лимит откликов! (' + CONFIG.dailyLimit + ')', 'error');
            setStepDesc('⚠ Достигнут дневной лимит (' + CONFIG.dailyLimit + ' откликов)! Скрипт остановлен до завтра.');
            document.getElementById('hh-btn-next').disabled = true;
            // Останавливаем авто-режим если запущен
            if (autoInterval) {
                clearTimeout(autoInterval);
                autoInterval = null;
            }
            STATE.isRunning = false;
            saveState();
            updateAutoButton();
            updateStats();
            return true;
        }
        return false;
    }

    // Выполнить следующий шаг
    async function executeNextStep() {
        // Проверяем дневной лимит перед каждым шагом
        if (checkDailyLimitAndStop()) return;

            if (STATE.currentVacancyIndex >= STATE.vacancies.length) {
            log('Все вакансии обработаны!', 'success');
            setStepDesc('Готово! Все вакансии обработаны.');
            document.getElementById('hh-btn-next').disabled = true;
            
            // Если включён авто-режим — перезапрашиваем страницу для новых вакансий
            if (STATE.isRunning) {
                log('Авто-режим: все вакансии обработаны. Перезапрашиваю страницу...', 'success');
                setTimeout(() => {
                    try {
                        if (window.location.href.split('#')[0] === CONFIG.searchRedirectUrl.split('#')[0]) {
                            window.location.reload();
                        } else {
                            window.location.href = CONFIG.searchRedirectUrl;
                        }
                    } catch (e) { }
                }, 3000);
            }
            return;
        }

        const vacancy = STATE.vacancies[STATE.currentVacancyIndex];
        const pageType = detectPageType();

        if (pageType === 'search') {
            await handleSearchPageStep(vacancy);
        } else if (pageType === 'response') {
            await handleResponsePageStep();
        } else if (pageType === 'vacancy') {
            await handleVacancyPageStep();
        } else {
            log('Неизвестный тип страницы!', 'error');
        }

        // Если авто-режим включен, планируем следующий шаг
        if (STATE.isRunning) {
            log('Ожидаю 2 секунды перед следующим шагом...', 'info');
            autoInterval = setTimeout(() => {
                if (STATE.isRunning) executeNextStep();
            }, 2000);
        }
    }

    // Шаг на странице поиска: клик "Откликнуться" → ждём 3 сек → модалка/inline/редирект
    async function handleSearchPageStep(vacancy) {
        log(`Шаг: Обработка "${vacancy.title}"`, 'step');
        setStepDesc(`Отклик на: "${vacancy.title}"\nНажимаю кнопку отклика...`);

        if (!vacancy.applyBtn) {
            log('Кнопка отклика не найдена, пробуем перейти по ссылке вакансии', 'warn');
            // Переходим на страницу вакансии
            if (vacancy.link) {
                log(`Переход: ${vacancy.link}`, 'info');
                window.location.href = vacancy.link;
                return;
            }
            STATE.skippedCount++;
            STATE.currentVacancyIndex++;
            updateStats();
            return;
        }

        // Кликаем "Откликнуться"
        log('Кликаю кнопку отклика...', 'step');
        vacancy.applyBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await wait(CONFIG.clickDelay);
        vacancy.applyBtn.click();

        // Ждём 3 секунды — за это время может появиться модалка, inline-карточка с кнопкой "Приложить письмо" или редирект
        await wait(3000);

        // Проверяем — появилась модалка?
        const modal = qs(SELECTORS.responseModal);
        if (modal) {
            log('Появилась модалка отклика!', 'step');
            const rtype = detectResponseType();
            log(`Тип отклика: ${rtype}`, 'info');
            await handleModalStep(vacancy, rtype);
            return;
        }

        // Проверяем редирект на страницу вопросов
        if (detectPageType() === 'response') {
            log('Редирект на страницу отклика (вопросы) — сохраняю в аутлайн и возвращаюсь на поиск', 'step');
            addToOutline(vacancy.title, vacancy.link || window.location.href);
            STATE.returnedFromOutline = true;
            saveState();
            try {
                window.location.href = CONFIG.searchRedirectUrl;
            } catch (e) {
                log('Не удалось перенаправить: ' + e.message, 'error');
            }
            return;
        }

        // Проверяем: может ли быть модальное окно требования письма прямо на странице поиска (сценарий 2)
        const coverLetterTextarea = qs(SELECTORS.coverLetterInput) || qs(SELECTORS.coverLetterInputAlt);
        if (coverLetterTextarea && detectPageType() === 'search') {
            log('Обнаружено модальное окно требования письма на странице поиска (сценарий 2)', 'step');
            const handled = await handleModalForCoverLetterOnSearchPage(vacancy);
            if (handled) {
                STATE.appliedCount++;
                incrementDailyCount();
                STATE.currentVacancyIndex++;
                updateStats();
                if (isDailyLimitReached()) {
                    log('Достигнут дневной лимит откликов! (' + CONFIG.dailyLimit + ')', 'error');
                    setStepDesc('⚠ Достигнут дневной лимит (' + CONFIG.dailyLimit + ' откликов)!');
                    return;
                }
                setStepDesc(`Письмо добавлено и отклик отправлен: "${vacancy.title}". Нажмите Next для следующей.`);
                return;
            }
        }

        // Проверяем inline-карточку с кнопкой "Приложить письмо" (сценарий 1)
        const inlineToggle = qs(SELECTORS.coverLetterToggle);
        if (inlineToggle) {
            log('Найден интерфейс "Приложить письмо" после отклика на странице поиска', 'step');
            const handled = await handleInlineCoverLetterCard(vacancy);
            if (handled) {
                STATE.currentVacancyIndex++;
                updateStats();
                setStepDesc(`Письмо приложено: "${vacancy.title}". Нажмите Next для следующей.`);
                return;
            }
        }

        log('Модалка не появилась. Пропускаю.', 'warn');
        STATE.skippedCount++;
        STATE.currentVacancyIndex++;
        updateStats();
        setStepDesc(`Пропущено: "${vacancy.title}". Нажмите Next для следующей.`);
    }

    // Шаг в модалке
    async function handleModalStep(vacancy, responseType) {
        if (responseType === 'instant') {
            log('Мгновенный отклик — просто нажимаю "Откликнуться"', 'step');
            setStepDesc('Мгновенный отклик. Нажимаю "Откликнуться"...');

            const submitBtn = qs(SELECTORS.submitButton);
            if (submitBtn && !submitBtn.disabled) {
                submitBtn.click();
                STATE.appliedCount++;
                incrementDailyCount();
                log(`Отклик отправлен: "${vacancy.title}"`, 'success');
                if (isDailyLimitReached()) {
                    log('Достигнут дневной лимит откликов! (' + CONFIG.dailyLimit + ')', 'error');
                    setStepDesc('⚠ Достигнут дневной лимит (' + CONFIG.dailyLimit + ' откликов)!');
                    return;
                }
            } else {
                // Кнопка disabled — возможно нужно выбрать резюме
                log('Кнопка disabled. Возможно нужно выбрать резюме.', 'warn');
                setStepDesc('Кнопка "Откликнуться" неактивна. Выберите резюме вручную, затем нажмите Next.');
                // Ждём ручного выбора резюме
                return;
            }
        } else if (responseType === 'deferred') {
            log('Отложенный отклик — требуется сопроводительное письмо', 'step');
            setStepDesc('Заполняю сопроводительное письмо...');

            let textarea = qs(SELECTORS.coverLetterInput) || qs(SELECTORS.coverLetterInputAlt);
            if (!textarea) textarea = await ensureCoverLetterFieldVisible();
            if (textarea) {
                fillTextarea(textarea);
                log('Сопроводительное вставлено!', 'success');
                await wait(500);

                // Теперь кнопка должна стать активной
                const submitBtn = qs(SELECTORS.submitButton);
                if (submitBtn && !submitBtn.disabled) {
                    log('Нажимаю "Откликнуться"...', 'step');
                    submitBtn.click();
                    STATE.appliedCount++;
                    incrementDailyCount();
                    log(`Отклик отправлен: "${vacancy.title}"`, 'success');
                    if (isDailyLimitReached()) {
                        log('Достигнут дневной лимит откликов! (' + CONFIG.dailyLimit + ')', 'error');
                        setStepDesc('⚠ Достигнут дневной лимит (' + CONFIG.dailyLimit + ' откликов)!');
                        return;
                    }
                } else {
                    log('Сопроводительное вставлено, но кнопка disabled. Возможно нужно выбрать резюме.', 'warn');
                    setStepDesc('Сопроводительное вставлено, но кнопка disabled. Выберите резюме и нажмите Next.');
                    return;
                }
            }
        } else if (responseType === 'outline') {
            log('Аутлайн — вопросы работодателя. Сохраняю ссылку.', 'warn');
            addToOutline(vacancy.title, vacancy.link || window.location.href);
            saveState();

            // Закрываем модалку
            const closeBtn = qs(SELECTORS.responseModalClose);
            if (closeBtn) closeBtn.click();
        }

        STATE.currentVacancyIndex++;
        updateStats();

        // Ждём закрытия модалки
        await wait(800);
        setStepDesc(`Обработано ${STATE.currentVacancyIndex}/${STATE.vacancies.length}. Нажмите Next для следующей.`);
    }

    // Добавляет вакансию в аутлайн с проверкой на дубликат по URL
    function addToOutline(title, url) {
        // Проверяем, нет ли уже такой ссылки в аутлайне
        const exists = STATE.outlineLinks.some(item => item.link === url);
        if (exists) {
            log(`Вакансия уже в аутлайне: "${title}"`, 'info');
            return false;
        }
        STATE.outlineLinks.push({ title: title, link: url });
        // Также запоминаем URL, чтобы пропускать при сборе
        if (url && !STATE.skippedVacancyUrls.includes(url)) {
            STATE.skippedVacancyUrls.push(url);
        }
        log(`Добавлено в аутлайн: "${title}"`, 'warn');
        return true;
    }

    // Проверяет, есть ли на странице отклика отметка "Вы откликнулись"
    function isAlreadyRespondedOnPage() {
        // Ищем блок data-qa="already-responded-text" или текст "Вы откликнулись"
        if (qs(SELECTORS.alreadyRespondedText)) return true;
        // Также проверим по тексту (на случай если селектор изменится)
        try {
            const pageText = document.body.textContent.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ');
            if (pageText.includes('Вы откликнулись')) return true;
        } catch (e) {}
        return false;
    }

    // Пытается извлечь название вакансии из текста страницы
    function extractVacancyTitleFromPage() {
        // На странице вопросов (аутлайн) название вакансии лежит в блоке data-qa="vacancy-credentials"
        const credsBlock = qs('[data-qa="vacancy-credentials"]');
        if (credsBlock) {
            // Внутри ищем элемент с data-qa="cell-text-content" (там название)
            const titleEl = credsBlock.querySelector('[data-qa="cell-text-content"]');
            if (titleEl) {
                const text = titleEl.textContent.trim();
                if (text) return text;
            }
        }
        // Пробуем найти заголовок вакансии на странице
        const titleEl = qs('[data-qa="vacancy-title"]') || 
                        qs('[data-qa="title"]') || 
                        qs('h1') ||
                        qs('[data-qa="vacancy-response__title"]');
        if (titleEl) {
            const text = titleEl.textContent.trim();
            if (text) return text;
        }
        // Пробуем извлечь из document.title (обычно там "Название вакансии — hh.ru")
        if (document.title) {
            let t = document.title.replace(/— hh\.ru$/, '').replace(/— HH\.RU$/i, '').trim();
            if (t) return t;
        }
        return 'Неизвестная вакансия';
    }

    // Шаг на странице отклика /applicant/vacancy_response
    async function handleResponsePageStep() {
        const rtype = detectResponseType();
        log(`Страница отклика. Тип: ${rtype}`, 'step');

        if (rtype === 'outline') {
            // Проверяем, не откликнулись ли уже на эту вакансию
            if (isAlreadyRespondedOnPage()) {
                log('Уже откликнулись на эту вакансию — пропускаем (не заносим в аутлайн)', 'info');
                STATE.skippedCount++;
                STATE.currentVacancyIndex++;
                updateStats();
                setStepDesc('Уже откликнулись. Пропускаем.');
                return;
            }

            log('Это страница с вопросами — аутлайн!', 'warn');
            const title = extractVacancyTitleFromPage();
            addToOutline(title, window.location.href);
            STATE.returnedFromOutline = true;
            saveState();
            log(`Сохранено в аутлайн, перенаправляю на поиск...`, 'info');
            
            // Автоматически перенаправляем на страницу поиска
            try {
                window.location.href = CONFIG.searchRedirectUrl;
                return;
            } catch (e) {
                log('Ошибка перенаправления: ' + e.message, 'error');
                setStepDesc('Ошибка при перенаправлении. Нажмите Next для продолжения.');
            }
            return;
        }

        // Если на этой странице просто нужно заполнить cover letter
        let textarea = qs(SELECTORS.coverLetterInput) || qs(SELECTORS.coverLetterInputAlt);
        if (!textarea) textarea = await ensureCoverLetterFieldVisible();
        if (textarea) {
            fillTextarea(textarea);
            log('Сопроводительное вставлено на странице отклика!', 'success');
            setStepDesc('Сопроводительное вставлено. Нажмите Next для отправки.');
            return;
        }

        // Пробуем нажать submit
        const submitBtn = qs(SELECTORS.submitButton);
        if (submitBtn && !submitBtn.disabled) {
            submitBtn.click();
            STATE.appliedCount++;
            incrementDailyCount();
            log('Отклик отправлен!', 'success');
            if (isDailyLimitReached()) {
                log('Достигнут дневной лимит откликов! (' + CONFIG.dailyLimit + ')', 'error');
                setStepDesc('⚠ Достигнут дневной лимит (' + CONFIG.dailyLimit + ' откликов)!');
                return;
            }
        } else {
            log('Не удалось отправить отклик на этой странице', 'warn');
        }

        STATE.currentVacancyIndex++;
        updateStats();
    }

    // Шаг на странице вакансии /vacancy/ (если попали туда по ссылке)
    async function handleVacancyPageStep() {
        log('Страница вакансии — ищу кнопку отклика', 'step');

        // Кнопка "Откликнуться" на странице вакансии
        const applyBtn = qs('[data-qa="vacancy-response-link-top"]') ||
                         qs('[data-qa="vacancy-response-link-bottom"]') ||
                         qs('button[data-qa*="response"]');

        if (applyBtn) {
            applyBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await wait(500);
            applyBtn.click();
            log('Нажал кнопку отклика на странице вакансии', 'step');
            await wait(1500);

            // Проверяем модалку
            const modal = qs(SELECTORS.responseModal);
            if (modal) {
                const vacancy = {
                    title: document.title,
                    link: window.location.href,
                };
                const rtype = detectResponseType();
                await handleModalStep(vacancy, rtype);
            }
        } else {
            log('Кнопка отклика не найдена на странице вакансии', 'warn');
            STATE.skippedCount++;
            STATE.currentVacancyIndex++;
            updateStats();
        }
    }

    // ============================================================
    //  АВТОМАТИЧЕСКИЙ РЕЖИМ (заглушка — будет реализован позже)
    // ============================================================
    let autoInterval = null;

    function toggleAutoMode() {
        STATE.isRunning = !STATE.isRunning;
        saveState();
        updateAutoButton();
        
        if (STATE.isRunning) {
            log('Авто-режим запущен', 'success');
            // Если вакансии не собраны или все обработаны, пробуем собрать
            if (STATE.vacancies.length === 0 || STATE.currentVacancyIndex >= STATE.vacancies.length) {
                if (detectPageType() === 'search') {
                    collectVacancies();
                }
            }
            // Запускаем отклик
            autoInterval = setTimeout(() => {
                if (STATE.isRunning) executeNextStep();
            }, 500);
        } else {
            log('Авто-режим остановлен', 'warn');
            if (autoInterval) clearTimeout(autoInterval);
        }
    }

    function updateAutoButton() {
        const btn = document.getElementById('hh-btn-auto');
        if (!btn) return;
        if (STATE.isRunning) {
            btn.textContent = 'Стоп';
            btn.classList.remove('hh-btn-secondary');
            btn.classList.add('hh-btn-warn');
        } else {
            btn.textContent = 'Авто';
            btn.classList.remove('hh-btn-warn');
            btn.classList.add('hh-btn-secondary');
        }
    }

    // Запускает авто-режим после сбора вакансий, если он был активен
    function resumeAutoMode() {
        if (STATE.isRunning) {
            log('Авто-режим активен. Продолжаю через 2 секунды...', 'success');
            autoInterval = setTimeout(() => {
                if (STATE.isRunning) executeNextStep();
            }, 2000);
        } else {
            log('Вакансии собраны. Нажмите Next для начала отклика.', 'info');
        }
    }

    // ============================================================
    //  АУТЛАЙН (вакансии с вопросами)
    // ============================================================
    function clearOutlineLinks() {
        if (STATE.outlineLinks.length === 0) {
            log('Аутлайн уже пуст', 'info');
            return;
        }

        if (confirm('Очистить список аутлайна (' + STATE.outlineLinks.length + ' вакансий)?')) {
            STATE.outlineLinks = [];
            // Также очищаем skippedVacancyUrls, чтобы эти вакансии снова обрабатывались
            STATE.skippedVacancyUrls = [];
            saveState();
            updateStats();
            log('Список аутлайна очищен', 'success');
            setStepDesc('Аутлайн очищен. Вакансии снова будут обрабатываться.');
        }
    }

    // ============================================================
    //  ПОКАЗ СПИСКА АУТЛАЙНА
    // ============================================================
    function showOutlineLinks() {
        if (STATE.outlineLinks.length === 0) {
            log('Аутлайн пуст — нет вакансий для ручной обработки', 'info');
            setStepDesc('Аутлайн пуст.');
            return;
        }

        log(`=== АУТЛАЙН (${STATE.outlineLinks.length} вакансий) ===`, 'warn');
        STATE.outlineLinks.forEach((item, idx) => {
            log(`${idx + 1}. ${item.title}\n   ${item.link}`, 'warn');
        });

        // Показываем в модальном окне
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:100000;display:flex;align-items:center;justify-content:center;';
        const modal = document.createElement('div');
        modal.style.cssText = 'background:#1a1a2e;border:2px solid #e94560;border-radius:12px;padding:24px;max-width:600px;width:90%;max-height:80vh;overflow-y:auto;color:#eee;font-family:sans-serif;';
        let html = `<h2 style="color:#e94560;margin-top:0">Аутлайн (${STATE.outlineLinks.length})</h2><p>Вакансии, требующие ручной обработки:</p>`;
        STATE.outlineLinks.forEach((item, idx) => {
            html += `<div style="margin:8px 0;padding:8px;background:#16213e;border-radius:6px;">
                <strong>${idx + 1}. ${item.title}</strong><br>
                <a href="${item.link}" target="_blank" style="color:#58a6ff;word-break:break-all;">${item.link}</a>
            </div>`;
        });
        html += `<br><button id="hh-outline-close" style="padding:8px 24px;background:#e94560;color:white;border:none;border-radius:6px;cursor:pointer;font-size:14px;">Закрыть</button>`;
        modal.innerHTML = html;
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        document.getElementById('hh-outline-close').onclick = () => overlay.remove();
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    }

    // ============================================================
    //  ЗАПУСК И ИНИЦИАЛИЗАЦИЯ
    // ============================================================
    function init() {
        // Проверяем, что мы на hh.ru
        if (!location.hostname.includes('hh.ru')) return;

        // Восстанавливаем состояние после редиректа
        const savedState = GM_getValue('hh_autoapply_state', null);
        if (savedState) {
            STATE.outlineLinks = savedState.outlineLinks || [];
            STATE.appliedCount = savedState.appliedCount || 0;
            STATE.skippedCount = savedState.skippedCount || 0;
            STATE.skippedVacancyUrls = savedState.skippedVacancyUrls || [];
            STATE.returnedFromOutline = savedState.returnedFromOutline || false;
            STATE.isRunning = savedState.isRunning || false;
            STATE.retryDelay = savedState.retryDelay || 0;
        }

        // Ждём загрузки страницы
        const checkReady = setInterval(() => {
            if (document.readyState === 'complete' || document.readyState === 'interactive') {
                clearInterval(checkReady);
                createUI();
                log('Скрипт загружен. Тип страницы: ' + detectPageType(), 'success');
                log('Дневной лимит: ' + getDailyCount() + '/' + CONFIG.dailyLimit + ' откликов', 'info');

                // Если мы на странице отклика после редиректа
                if (detectPageType() === 'response') {
                    log('Обнаружена страница отклика (возможно после редиректа)', 'step');
                    handleResponsePageRedirect();
                    return;
                }

                // Если вернулись со страницы вопросов (outline) — ждём 5 сек и собираем вакансии
                if (STATE.returnedFromOutline) {
                    log('Вернулись со страницы вопросов. Через 5 сек автоматически соберу вакансии...', 'step');
                    STATE.returnedFromOutline = false;
                    saveState();
                    
                    setTimeout(() => {
                        log('Автоматически выполняю "Собрать вакансии"...', 'info');
                        // Ждём пока страница станет страницей поиска и появятся карточки
                        const waitForSearch = setInterval(() => {
                            const pageType = detectPageType();
                            const hasCards = !!document.querySelector(SELECTORS.vacancyCard);
                            log(`Жду поиск: pageType=${pageType}, cards=${hasCards}`, 'info');
                            if (pageType === 'search' && hasCards) {
                                clearInterval(waitForSearch);
                                collectVacancies();
                                resumeAutoMode();
                            }
                        }, 1000);
                        // Если через 20 сек всё ещё не страница поиска — пробуем собрать в любом случае
                        setTimeout(() => {
                            clearInterval(waitForSearch);
                            if (detectPageType() === 'search') {
                                collectVacancies();
                            } else {
                                log('Страница не загрузилась как поиск. Перезагружаю...', 'warn');
                                window.location.href = CONFIG.searchRedirectUrl;
                            }
                        }, 20000);
                    }, 5000);
                    return;
                }
                
                // Если был retryDelay (не нашли вакансий) — ждём 5 сек и собираем
                if (detectPageType() === 'search' && STATE.retryDelay > 0) {
                    log('Ожидаю 5 сек перед сбором вакансий...', 'step');
                    
                    setTimeout(() => {
                        log('Автоматически выполняю "Собрать вакансии"...', 'info');
                        const collected = collectVacancies();
                        if (!collected) return;
                        resumeAutoMode();
                    }, 5000);
                }
            }
        }, 500);
    }

    // Обработка при загрузке на странице отклика (редирект из модалки)
    async function handleResponsePageRedirect() {
        const rtype = detectResponseType();
        log(`Тип отклика на странице: ${rtype}`, 'info');
        setStepDesc(`Страница отклика. Тип: ${rtype}. Нажмите Next для обработки.`);

        document.getElementById('hh-btn-next').disabled = false;

        // Если аутлайн — автоматически сохраняем и перенаправляем
        if (rtype === 'outline') {
            // Проверяем, не откликнулись ли уже на эту вакансию
            if (isAlreadyRespondedOnPage()) {
                log('Уже откликнулись на эту вакансию — пропускаем (не заносим в аутлайн)', 'info');
                updateStats();
                log('Перенаправляю на поиск...', 'info');
                try {
                    window.location.href = CONFIG.searchRedirectUrl;
                } catch (e) {}
                return;
            }

            log('Вопросы работодателя — автоматически сохраняю в аутлайн и перенаправляю на поиск', 'warn');
            const title = extractVacancyTitleFromPage();
            addToOutline(title, window.location.href);
            STATE.returnedFromOutline = true;
            updateStats();
            
            // Сохраняем состояние и перенаправляем
            try {
                saveState();
                log('Перенаправляю на поиск...', 'info');
                window.location.href = CONFIG.searchRedirectUrl;
            } catch (e) {
                log('Ошибка при сохранении и перенаправлении: ' + e.message, 'error');
                setStepDesc('Сохранено. Перейдите к поиску вакансий вручную.');
            }
            return;
        }
    }

    // Запуск
    init();
})();
