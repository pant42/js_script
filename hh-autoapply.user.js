// ==UserScript==
// @name         HH.ru AutoApply
// @namespace    http://tampermonkey.net/
// @version      0.3.0
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
    //  ИДЕНТИФИКАЦИЯ ТЕКУЩЕЙ СЕССИИ (ПРОГОНА)
    // ============================================================
    let currentSessionId = sessionStorage.getItem('hh_autoapply_session_id');
    if (!currentSessionId) {
        currentSessionId = Date.now().toString();
        sessionStorage.setItem('hh_autoapply_session_id', currentSessionId);
    }

    // ============================================================
    //  КОНФИГУРАЦИЯ
    // ============================================================
    const savedConfig = GM_getValue('hh_autoapply_config', {});
    const CONFIG = {
        // Шаблон сопроводительного письма.
        coverLetterTemplate: `Здравствуйте.
Меня заинтересовала ваша вакансия.
У меня более 6 лет опыта в тестировании веб- и backend-приложений. Работал с функциональным, регрессионным и API-тестированием, анализом требований, локализацией дефектов и сопровождением релизов.
Использую в работе SQL, Postman, REST API, Jira, Git. Также участвовал во внедрении автотестов на Playwright и автоматизации отдельных QA процессов.
Основной фокус в работе- поиск критичных сценариев и снижение рисков до релиза, а не только формальное прохождение тест-кейсов. Есть опыт взаимодействия с разработчиками, аналитиками и product командой при проработке требований и проверке новых фич.
Буду рад обсудить, как мой опыт может быть полезен вашей команде.
С уважением,
Александр Пантин
Telegram: @alxptn
Email: pantin_42@inbox.ru`,
        // Задержка перед кликом (мс)
        clickDelay: 300,
        // URL поиска вакансий для возврата при редиректе на страницу отклика (questions)
        searchRedirectUrl: savedConfig.searchRedirectUrl || "https://tver.hh.ru/search/vacancy?area=113&ored_clusters=true&text=QA+Engineer+%28Manual+%2B+Automation%29&items_on_page=100&search_session_id=c9efa11b-53d2-4327-bba5-2cfb1c5d521c",
        // Дневной лимит откликов
        dailyLimit: savedConfig.dailyLimit || 150,
        // Не останавливаться при капче: закрыть её, пропустить вакансию и продолжить (на свой риск)
        ignoreCaptcha: !!savedConfig.ignoreCaptcha,
    };

    const CAPTCHA_IGNORE_WARNING =
        'ВНИМАНИЕ!\n\n' +
        'Работа без остановки с игнорированием капчи возможна, но за корректную работу скрипта, ' +
        'сохранность аккаунта и корректную обработку откликов никто не отвечает.\n\n' +
        'При капче скрипт закроет её окно, пропустит вакансию (она попадёт в «Непонятное») и продолжит.\n\n' +
        'Включить?';

    function saveConfig() {
        GM_setValue('hh_autoapply_config', {
            searchRedirectUrl: CONFIG.searchRedirectUrl,
            dailyLimit: CONFIG.dailyLimit,
            ignoreCaptcha: CONFIG.ignoreCaptcha,
        });
    }

    // ============================================================
    //  ИМЕНОВАННЫЕ ЗАДЕРЖКИ (мс)
    // ============================================================
    const DELAYS = {
        short: 100,
        click: 300,
        small: 500,
        wait: 1000,
        animation: 1500,
        step: 2000,
        retryFirst: 3000,
        retryNext: 7000,
        pause: 10000,
        longWait: 20000,
    };

    // ============================================================
    //  СЕЛЕКТОРЫ hh.ru (вычислены из анализа HTML-страниц)
    // ============================================================
    const SELECTORS = {
        // --- Страница поиска вакансий ---
        vacancyCard: '[data-qa="vacancy-serp__vacancy"]',
        vacancyTitle: '[data-qa="serp-item__title"]',
        companyName: '[data-qa="vacancy-serp__vacancy-employer"]',
        vacancyTitleLink: 'a[data-qa="serp-item__title"]',
        applyButton: '[data-qa="vacancy-serp__vacancy_response"]',

        // --- Модалка отклика (popup) ---
        responseModal: '[data-qa="vacancy-response-popup"]',
        responseModalTitle: '[data-qa="title"]',
        responseModalClose: '[data-qa="response-popup-close"]',
        // Основное поле в popup
        coverLetterInput: '[data-qa="vacancy-response-popup-form-letter-input"]',
        // Кнопка "Добавить сопроводительное" в окне с предупреждением
        addCoverLetterBtn: '[data-qa="add-cover-letter"]',
        // Альтернативные селекторы для inline-формы, появляющейся после клика "Приложить письмо"
        coverLetterInputAlt: 'form[id^="cover-letter-"] textarea[name="text"], [data-qa="textarea-native-wrapper"] textarea, textarea[name="text"]',
        // Кнопки отправки: popup и inline-форма
        submitButton: '[data-qa="vacancy-response-submit-popup"], [data-qa="vacancy-response-letter-submit"]',
        generateCoverLetterBtn: '[data-qa="generate-cover-letter"]',
        coverLetterToggle: '[data-qa="vacancy-response-letter-toggle"], [data-qa="vacancy-response-letter-toggle-text"]',

        // --- Модалка предупреждения о другой стране ---
        relocationConfirmBtn: '[data-qa="relocation-warning-confirm"]',

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

        // --- Маркер отклика на карточке поиска ---
        respondedMarker: '[data-qa="vacancy-serp__vacancy_responded"]',
        // --- Модалка предупреждения об отказе ---
        responseRejectWarning: '[data-qa="response-reject-warning"]',
        // --- Капча ---
        captchaPicture: '[data-qa="account-captcha-picture"]',
        captchaInput: '[data-qa="account-captcha-input"]',
        captchaError: '[data-qa="account-captcha-error"]',
        captchaImageSrc: 'img[src*="/captcha/picture"]',
        // --- Заголовок/описание на странице отклика ---
        titleDescription: '[data-qa="title-description"]',

        // --- Страница отклика: извлечение названия вакансии и компании (ХРУПКО) ---
        responseCredsTitle: '[data-qa="vacancy-credentials"] [data-qa="cell-text-content"]',
        responseMainTitle: 'h1[data-qa="title"]',
        responseSidebarColumn: '.magritte-grid-column_m-4___-vMK7_3-0-3',
        responseCompanyAvatar: '[aria-label][class*="magritte-avatar"]',

        // --- Страница вакансии: кнопки отклика ---
        vacancyApplyTop: '[data-qa="vacancy-response-link-top"]',
        vacancyApplyBottom: '[data-qa="vacancy-response-link-bottom"]',
        anyResponseButton: 'button[data-qa*="response"]',

        // --- Отказы (чаты): бейдж непрочитанных ---
        chatUnreadBadge: '[data-qa="chatik-info-badges"]',
        // Карточка чата (скелетоны загрузки имеют data-qa="chatik-skeleton-chat-…" и сюда не попадают)
        chatCell: 'a[data-qa^="chatik-open-chat-"]',
        chatCellTitle: '[data-qa="chat-cell-title"]',
        chatCellSubtitle: '[data-qa="chat-cell-subtitle"]',
        // Текст последнего сообщения (у блока нет data-qa, только хешированный класс)
        chatLastMessage: '[class*="last-message-color"], [class^="last-message--"]',
        chatOnlyUnreadCheckbox: 'input[data-qa="chatik-checkbox-only-unread"]',
    };

    // ============================================================
    //  СОСТОЯНИЕ
    // ============================================================
    const STATE = {
        stepIndex: 0,
        steps: [],
        vacancies: [], // Не сохраняется между полными перезагрузками, только для сессии
        currentVacancyIndex: 0, // Сбрасывается при перезагрузке
        outlineLinks: [],     // вакансии, требующие ручной обработки
        unclearOutlineLinks: [], // Вакансии, где произошла непонятная ошибка
        // URL вакансий, которые требуют ответов/аутлайн и должны быть пропущены
        skippedVacancyUrls: [],
        isRunning: false,
        returnedFromOutline: false,  // флаг: вернулись ли с страницы вопросов
        retryDelay: 0,              // 0 - первый сбор, 3000 - второй, 7000 - третий и далее
        emptyPageRetries: 0,        // счетчик пустых страниц подряд
        emptyPageRestarts: 0,       // счетчик 10-секундных перезапусков,
        appliedCount: 0, // Счетчик откликов
        skippedCount: 0, // Счетчик пропущенных
    };

    const REJECT_STATE = {
        // ID чатов (строки списка виртуальные и переиспользуются — DOM-узлы запоминать нельзя)
        processedIds: new Set(),
        // Чаты, которые не трогаем (приглашения/вопросы/непонятное) — чтобы не логировать повторно
        keptIds: new Set(),
        isRunning: false
    };
    let autoRejectInterval = null;

    function saveState() {
        GM_setValue('hh_autoapply_state', {
            outlineLinks: STATE.outlineLinks,
            unclearOutlineLinks: STATE.unclearOutlineLinks,
            skippedVacancyUrls: STATE.skippedVacancyUrls,
            returnedFromOutline: STATE.returnedFromOutline,
            isRunning: STATE.isRunning,
            retryDelay: STATE.retryDelay,
            emptyPageRetries: STATE.emptyPageRetries,
            emptyPageRestarts: STATE.emptyPageRestarts,
            vacancies: STATE.vacancies.map(v => ({ title: v.title, link: v.link, company: v.company, })),
            currentVacancyIndex: STATE.currentVacancyIndex,
            // Сохраняем счетчики
            appliedCount: STATE.appliedCount,
            skippedCount: STATE.skippedCount,
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

    // Пробует селекторы по порядку (fallback-цепочка), возвращает { el, selector } или null.
    function firstMatch(selectors, parent = document) {
        for (const s of selectors) {
            const el = parent.querySelector(s);
            if (el) return { el, selector: s };
        }
        return null;
    }

    function isAlreadyResponded(card) {
        if (!card) return false;
        // Ищем явный маркер отклика
        if (card.querySelector(SELECTORS.respondedMarker)) return true;
        // Или текстовый маркер внутри карточки
        try {
            // Очищаем от неразрывных пробелов (&nbsp; -> \u00A0)
            const txt = (card.textContent || '').replace(/\u00A0/g, ' ').trim();
            if (txt.includes('Вы откликнулись')) return true;
        } catch (e) {}
        return false;
    }

    // Быстрая проверка на появление окна "отклик в другую страну"
    async function checkAndHandleRelocationWarning() {
        for (let i = 0; i < 5; i++) {
            await wait(400);
            const relocationBtn = qs(SELECTORS.relocationConfirmBtn);
            if (relocationBtn) {
                log('Обнаружено окно "отклик в другую страну". Подтверждаю...', 'warn');
                relocationBtn.click();
                await wait(DELAYS.wait); // ждем реакцию после клика
                return true;
            }
            if (qs(SELECTORS.responseModal)) return false; // если уже появилась стандартная модалка
        }
        return false;
    }

    function getCoverLetterField() {
        return qs(SELECTORS.coverLetterInput) || qs(SELECTORS.coverLetterInputAlt);
    }

    function getPageText() {
        return (document.body.textContent || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ');
    }

    function redirectSearch() {
        try { window.location.href = CONFIG.searchRedirectUrl; } catch (e) { log('Ошибка перенаправления: ' + e.message, 'error'); }
    }

    // Заполняет textarea письмом и обновляет визуальный клон magritte
    function fillTextarea(textarea) {
        const letterText = CONFIG.coverLetterTemplate;
        textarea.focus();
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
        ).set;
        // Очистка ОБЯЗАТЕЛЬНА: стираем старое содержимое, иначе текст задублируется
        nativeInputValueSetter.call(textarea, '');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        // Вставляем шаблон
        nativeInputValueSetter.call(textarea, letterText);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
        textarea.dispatchEvent(new Event('blur', { bubbles: true }));
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
        const toggle = qs(SELECTORS.coverLetterToggle) || qs(SELECTORS.addCoverLetterBtn);
        if (toggle) {
            log('Нажимаю кнопку "Приложить письмо"...', 'step');
            const clickTarget = toggle.closest('button, [role="button"], label') || toggle;
            clickTarget.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
            await wait(DELAYS.short);
            clickTarget.click();
            // Ждём появления и завершения анимации textarea (выезжает сверху)
            await wait(DELAYS.animation);
            let textarea = getCoverLetterField();
            if (textarea) return textarea;
            log('После клика поле письма не найдено, пробую ещё раз...', 'warn');
            clickTarget.click();
            await wait(DELAYS.animation);
            textarea = getCoverLetterField();
            if (textarea) return textarea;
        } else {
            log('Кнопка "Приложить письмо" не найдена', 'warn');
        }
        return getCoverLetterField();
    }

    // ============================================================
    //  ЕДИНЫЙ ПАЙПЛАЙН ОТКЛИКА
    //  После клика "Откликнуться" определяем исход:
    //    1) аутлайн (вопросы работодателя)  -> сценарий 3
    //    2) модалка отклика                 -> сценарий 2
    //    3) поле/кнопка письма на странице  -> сценарий 1
    //  В остальных случаях: приложить письмо -> "Отправить"
    // ============================================================
    const OUTLINE_MARKER_FULL = 'Для отклика необходимо ответить на несколько вопросов';
    const OUTLINE_MARKER_SHORT = 'ответить на несколько вопросов';

    function normText(value) {
        return (value || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
    }

    // Сценарий 3: на странице вопросы работодателя (аутлайн)
    function isOutlineDetected() {
        const modal = qs(SELECTORS.responseModal);
        if (modal && normText(modal.textContent).includes(OUTLINE_MARKER_SHORT)) return true;
        if ((qs(SELECTORS.employerAskingForTest) || qs(SELECTORS.taskBody)) && !modal) return true;
        const titleDesc = qs(SELECTORS.titleDescription);
        if (titleDesc && normText(titleDesc.textContent).includes(OUTLINE_MARKER_SHORT)) return true;
        if (detectPageType() === 'response' && normText(getPageText()).includes(OUTLINE_MARKER_SHORT)) return true;
        if (normText(document.body.textContent).includes(OUTLINE_MARKER_FULL)) return true;
        return false;
    }

    // Есть ли куда приложить сопроводительное письмо (поле или кнопка "Приложить письмо")
    function hasLetterPlace() {
        return !!(getCoverLetterField() || qs(SELECTORS.coverLetterToggle) || qs(SELECTORS.addCoverLetterBtn));
    }

    // Элемент реально отображается (hh держит закрытые модалки в DOM)
    function isVisible(el) {
        return !!el && document.documentElement.contains(el) && el.getClientRects().length > 0;
    }

    function visibleDialogs() {
        return qsa('[role="dialog"]').filter(isVisible);
    }

    const CAPTCHA_TEXT_RE = /пройдите капчу|подтвердите, что вы не робот|подтвердить, что вы не робот/i;
    const CAPTCHA_SELECTORS = ['captchaPicture', 'captchaInput', 'captchaError', 'captchaImageSrc'];

    // Капча: модал «Пройдите капчу» или полностраничный редирект на /captcha
    function isCaptchaDetected() {
        if (CAPTCHA_SELECTORS.some(key => qsa(SELECTORS[key]).some(isVisible))) return true;
        if (/\/captcha/i.test(window.location.href)) return true;
        // innerText не включает скрытые элементы — закрытая капча не даёт ложных срабатываний
        return CAPTCHA_TEXT_RE.test(normText(document.body.innerText));
    }

    function getCaptchaDialog() {
        return visibleDialogs().find(d =>
            CAPTCHA_SELECTORS.some(key => qs(SELECTORS[key], d)) || CAPTCHA_TEXT_RE.test(normText(d.textContent))
        ) || null;
    }

    // Клик, который понимают React-кнопки magritte (полная последовательность событий)
    function realClick(el) {
        const target = (el.closest && el.closest('button, [role="button"], a')) || el;
        const opts = { bubbles: true, cancelable: true, view: window };
        try {
            target.dispatchEvent(new PointerEvent('pointerdown', opts));
            target.dispatchEvent(new MouseEvent('mousedown', opts));
            target.dispatchEvent(new PointerEvent('pointerup', opts));
            target.dispatchEvent(new MouseEvent('mouseup', opts));
        } catch (e) { /* не критично */ }
        target.click();
    }

    function pressEscape(target) {
        const opts = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
        target.dispatchEvent(new KeyboardEvent('keydown', opts));
        target.dispatchEvent(new KeyboardEvent('keyup', opts));
    }

    // Закрывает модальное окно: кнопка с текстом → крестик в шапке → Escape
    async function closeDialog(dialog, buttonText) {
        if (!dialog) return true;
        const candidates = [];
        if (buttonText) {
            const footer = qs('[data-qa="modal-footer"]', dialog) || dialog;
            const byText = findButtonByText(footer, buttonText, false);
            if (byText) candidates.push(byText);
        }
        const headerBtn = qs('[data-qa="modal-header"] button', dialog);
        if (headerBtn) candidates.push(headerBtn);
        const qaClose = qs(SELECTORS.responseModalClose, dialog);
        if (qaClose) candidates.push(qaClose);

        for (const btn of candidates) {
            try { btn.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' }); } catch (e) { /* не критично */ }
            realClick(btn);
            await wait(DELAYS.small);
            if (!isVisible(dialog)) return true;
        }
        pressEscape(dialog);
        pressEscape(document);
        await wait(DELAYS.small);
        return !isVisible(dialog);
    }

    // Кнопка/span с точным текстом (в т.ч. magritte-label)
    function findButtonByText(root, text, excludeApply) {
        const isApply = (el) => excludeApply && el.matches(SELECTORS.applyButton);
        const nodes = qsa('button, [role="button"], a', root);
        let el = nodes.find(node => !isApply(node) && normText(node.textContent) === text);
        if (el) return el;
        const labels = qsa('span', root).filter(span =>
            !span.children.length &&
            normText(span.textContent) === text &&
            !(excludeApply && span.closest(SELECTORS.applyButton))
        );
        if (labels.length) return labels[0].closest('button, [role="button"]') || labels[0];
        return nodes.find(node => !isApply(node) && normText(node.textContent).includes(text)) || null;
    }

    // Кнопка отправки: "Отправить" (любой вариант кнопки) или "Откликнуться"
    async function findSubmitButton(scopeEl, timeoutMs = 4000) {
        const start = Date.now();
        do {
            const modal = qs(SELECTORS.responseModal);
            const scopes = [];
            if (modal) scopes.push(modal);
            if (scopeEl && scopeEl !== modal) scopes.push(scopeEl);
            scopes.push(document.body);

            for (const scope of scopes) {
                const byQa = qs(SELECTORS.submitButton, scope);
                if (byQa) return byQa;
            }
            for (const scope of scopes) {
                const bySend = findButtonByText(scope, 'Отправить', false);
                if (bySend) return bySend;
            }
            for (const scope of scopes) {
                const byApply = findButtonByText(scope, 'Откликнуться', true);
                if (byApply) return byApply;
            }
            if (Date.now() - start >= timeoutMs) break;
            await wait(200);
        } while (true);
        return null;
    }

    // Какой исход появился после клика "Откликнуться"
    function detectApplyOutcome(vacancy) {
        if (isCaptchaDetected()) return 'captcha';
        if (isOutlineDetected()) return 'outline';
        if (qs(SELECTORS.responseModal)) return 'modal';
        if (detectPageType() === 'response') return isAlreadyRespondedOnPage() ? 'responded' : 'response';
        if (hasLetterPlace()) return 'letter';
        if (vacancy && vacancy.card && isAlreadyResponded(vacancy.card)) return 'responded';
        return null;
    }

    // Сколько ждать редирект на вопросы при «зарегистрированном» отклике (гибрид сценариев 1↔3)
    const HYBRID_GRACE_MS = 2500;

    // Ждём исхода клика (два одинаковых результата подряд = подтверждён)
    async function waitForApplyOutcome(vacancy, timeoutMs = 8000) {
        const start = Date.now();
        let previous = null;
        while (Date.now() - start < timeoutMs) {
            const outcome = detectApplyOutcome(vacancy);
            if (outcome === 'captcha') return 'captcha';
            if (outcome === 'outline') return 'outline';
            if (outcome && outcome === previous) {
                if (outcome === 'responded') {
                    // «Отклик зарегистрирован», но может последовать переадресация
                    // на вопросы работодателя — ждём её, чтобы не засчитать дважды
                    // (сначала как применённую, затем как вакансию в аутлайне).
                    const graceEnd = Date.now() + HYBRID_GRACE_MS;
                    while (Date.now() < graceEnd) {
                        await wait(DELAYS.short);
                        if (isOutlineDetected()) return 'outline';
                        if (detectPageType() === 'response') {
                            // На странице отклика ждём рендер: если появятся вопросы —
                            // это аутлайн, иначе отклик успешен.
                            while (Date.now() < graceEnd) {
                                await wait(DELAYS.short);
                                const current = detectApplyOutcome(vacancy);
                                if (current === 'outline') return 'outline';
                                if (current && current !== 'none') return current;
                            }
                        }
                    }
                }
                return outcome;
            }
            previous = outcome;
            await wait(300);
        }
        return 'none';
    }

    // Единое действие: приложить письмо -> нажать "Отправить" -> подтвердить
    async function attachLetterAndSubmit(vacancy) {
        if (isCaptchaDetected()) return 'captcha';
        if (isOutlineDetected()) {
            await handleOutlineOutcome(vacancy);
            return 'outline';
        }

        // 1. Ищем, куда приложить сопроводительное письмо
        let textarea = getCoverLetterField();
        if (!textarea) textarea = await ensureCoverLetterFieldVisible();
        if (!textarea) {
            // Поле могло появиться с задержкой
            for (let i = 0; i < 8 && !textarea; i++) {
                await wait(250);
                textarea = getCoverLetterField();
            }
        }

        if (textarea) {
            fillTextarea(textarea);
            log('Сопроводительное письмо вставлено', 'success');
            await wait(DELAYS.small);
        } else {
            log('Поле для сопроводительного письма не найдено — отправляю без письма', 'warn');
        }

        // Вопросы могли проявиться, пока заполняли письмо
        if (isCaptchaDetected()) return 'captcha';
        if (isOutlineDetected()) {
            await handleOutlineOutcome(vacancy);
            return 'outline';
        }

        // 2. Ищем кнопку "Отправить"
        const submitBtn = await findSubmitButton(vacancy ? vacancy.card : null, 4000);
        if (!submitBtn) {
            log('Кнопка "Отправить" не найдена', 'warn');
            return 'failed';
        }
        const realBtn = submitBtn.closest ? (submitBtn.closest('button') || submitBtn) : submitBtn;
        if (submitBtn.disabled || realBtn.disabled) {
            log('Кнопка "Отправить" неактивна. Возможно нужно выбрать резюме.', 'warn');
            setStepDesc('Кнопка "Отправить" неактивна. Выберите резюме вручную, затем нажмите Next.');
            return 'disabled';
        }

        // 3. Жмём "Отправить"
        if (isCaptchaDetected()) return 'captcha';
        const startPageType = detectPageType();
        const hadModal = !!qs(SELECTORS.responseModal);
        try {
            submitBtn.scrollIntoView({ block: 'center', inline: 'center' });
            await wait(DELAYS.short);
            submitBtn.click();
            log('Нажата кнопка "Отправить"', 'step');
        } catch (e) {
            log('Ошибка клика по "Отправить": ' + e.message, 'error');
            return 'failed';
        }

        // 4. Ждём результат
        return await waitForSubmitResult(vacancy, startPageType, hadModal, 8000);
    }

    // Ждём результат после нажатия "Отправить"
    async function waitForSubmitResult(vacancy, startPageType, hadModal, timeoutMs) {
        const start = Date.now();
        let closedStreak = 0;
        while (Date.now() - start < timeoutMs) {
            // Капча — останавливаемся (нельзя взаимодействовать с формой)
            if (isCaptchaDetected()) return 'captcha';
            // Вопросы работодателя -> аутлайн
            if (isOutlineDetected()) {
                await handleOutlineOutcome(vacancy);
                return 'outline';
            }
            // Ушли на другую страницу (например, страницу отклика)
            if (detectPageType() !== startPageType) return 'pending_response';
            // Отклик подтверждён
            if (isAlreadyRespondedOnPage()) return 'success';
            if (vacancy && vacancy.card && isAlreadyResponded(vacancy.card)) return 'success';
            // Форма закрылась — отклик отправлен
            const formOpen = qs(SELECTORS.responseModal) || getCoverLetterField();
            if (!formOpen && (hadModal || startPageType !== 'search')) {
                closedStreak++;
                if (closedStreak >= 2) return 'success';
            } else {
                closedStreak = 0;
            }
            await wait(300);
        }
        return 'unclear';
    }

    // Сценарий 3 (аутлайн): сохраняем вакансию для ручной обработки
    async function handleOutlineOutcome(vacancy) {
        const creds = extractVacancyTitleFromPage();
        const title = (vacancy && vacancy.title) || creds.title;
        const company = (vacancy && vacancy.company) || creds.company;
        const link = (vacancy && vacancy.link) || window.location.href;

        log(`Вопросы работодателя (аутлайн): "${title}"`, 'warn');
        setStepDesc(`Аутлайн: "${title}" — вопросы работодателя.`);
        await collectAndStoreQuestions();
        addToOutline(title, link, company);
        saveState();
        updateStats();

        if (detectPageType() === 'search') {
            const closeBtn = qs(SELECTORS.responseModalClose);
            if (closeBtn) closeBtn.click();
            finishVacancy(vacancy, `Аутлайн сохранён: "${title}". Нажмите Next для следующей.`);
            return;
        }

        STATE.returnedFromOutline = true;
        saveState();
        redirectSearch();
    }

    // Переход к следующей вакансии
    function finishVacancy(vacancy, message) {
        STATE.currentVacancyIndex++;
        saveState();
        updateStats();
        setStepDesc(message || `Обработано ${STATE.currentVacancyIndex}/${STATE.vacancies.length}. Нажмите Next для следующей.`);
    }

    // Капча: по настройке либо стоп, либо закрыть и пропустить вакансию
    function handleCaptcha(vacancy) {
        return CONFIG.ignoreCaptcha ? handleCaptchaIgnore(vacancy) : handleCaptchaStop(vacancy);
    }

    // Режим «не останавливаться»: закрываем капчу, вакансию — в «Непонятное», работаем дальше
    async function handleCaptchaIgnore(vacancy) {
        const title = (vacancy && vacancy.title) || 'вакансия';
        log(`Капча при отклике: "${title}". Игнорирую (настройка), вакансия → "Непонятное".`, 'warn');
        await dismissCaptcha();
        // Окно отклика под капчей тоже закрываем, чтобы не мешало следующей вакансии
        const responseModal = qs(SELECTORS.responseModal);
        if (isVisible(responseModal)) await closeDialog(responseModal.closest('[role="dialog"]') || responseModal, 'Закрыть');
        if (vacancy) addToUnclearOutline(title, vacancy.link || window.location.href, vacancy.company);
        STATE.skippedCount++;
        saveState();
        finishVacancy(vacancy, `Капча проигнорирована: "${title}" — в "Непонятное".`);
        return 'skipped';
    }

    // Закрыть окно капчи; на полностраничной капче — вернуться на поиск
    async function dismissCaptcha() {
        const dialog = getCaptchaDialog();
        if (dialog) {
            const closed = await closeDialog(dialog, null);
            log(closed ? 'Окно капчи закрыто' : 'Окно капчи закрыть не удалось', closed ? 'step' : 'warn');
            return closed;
        }
        if (/\/captcha/i.test(window.location.href)) {
            log('Страница капчи — возвращаюсь на поиск', 'warn');
            STATE.returnedFromOutline = !!STATE.isRunning;
            saveState();
            redirectSearch();
        }
        return false;
    }

    // Единый пайплайн: разбираем исход клика и доводим отклик до конца
    async function runUnifiedApply(vacancy, outcome, depth = 0) {
        log(`Исход отклика: ${outcome}`, 'info');

        if (outcome === 'captcha') return handleCaptcha(vacancy);

        if (outcome === 'outline') {
            await handleOutlineOutcome(vacancy);
            return 'outline';
        }

        if (outcome === 'responded') {
            log('Отклик уже отправлен', 'success');
            if (registerSuccessfulApply(vacancy.title)) return 'stopped';
            finishVacancy(vacancy, `Отклик уже отправлен: "${vacancy.title}". Нажмите Next для следующей.`);
            return 'success';
        }

        if (outcome === 'none') {
            log('После клика не появилось ни модалки, ни поля письма, ни вопросов. Пропускаю.', 'warn');
            STATE.skippedCount++;
            finishVacancy(vacancy, `Пропущено: "${vacancy.title}". Нажмите Next для следующей.`);
            return 'skipped';
        }

        // 'modal' | 'letter' | 'response' → приложить письмо и "Отправить"
        const result = await attachLetterAndSubmit(vacancy);

        if (result === 'disabled') return 'disabled';
        if (result === 'captcha') return handleCaptcha(vacancy);
        if (result === 'outline') return 'outline';

        if (result === 'success') {
            if (registerSuccessfulApply(vacancy.title)) return 'stopped';
            finishVacancy(vacancy, `Отклик отправлен: "${vacancy.title}". Нажмите Next для следующей.`);
            return 'success';
        }

        if (result === 'pending_response' && depth < 2) {
            const creds = extractVacancyTitleFromPage();
            const nextVacancy = {
                title: (vacancy && vacancy.title) || creds.title,
                company: (vacancy && vacancy.company) || creds.company,
                link: (vacancy && vacancy.link) || window.location.href,
                card: null,
            };
            return runUnifiedApply(nextVacancy, 'response', depth + 1);
        }

        if (result === 'unclear') {
            log('Не удалось подтвердить отклик. Добавляю в "Непонятное".', 'warn');
            addToUnclearOutline(vacancy.title, vacancy.link || window.location.href, vacancy.company);
            saveState();
            STATE.skippedCount++;
            finishVacancy(vacancy, `Отклик не подтверждён: "${vacancy.title}" — в "Непонятное".`);
            return 'unclear';
        }

        // 'failed'
        STATE.skippedCount++;
        finishVacancy(vacancy, `Не удалось отправить отклик: "${vacancy.title}".`);
        return 'failed';
    }

    // Определяем тип текущей страницы
    function detectPageType() {
        const url = location.href;
        if (url.includes('/search/vacancy')) return 'search';
        if (url.includes('/applicant/vacancy_response')) return 'response';
        if (url.includes('/vacancy/')) return 'vacancy';
        return 'unknown';
    }

    // ============================================================
    //  UI ПАНЕЛЬ (стили и шаблоны)
    // ============================================================
    const PANEL_CSS = `
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
        #hh-autoapply-panel.minimized { max-height: 48px; }
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
        .hh-stats { display: flex; gap: 12px; margin: 8px 0; flex-wrap: wrap; }
        .hh-stat { background: #16213e; padding: 6px 12px; border-radius: 6px; text-align: center; }
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
        .hh-input-group { margin: 8px 0; display: flex; flex-direction: column; gap: 4px; }
        .hh-input-group label { font-size: 11px; color: #888; text-transform: uppercase; font-weight: bold; }
        .hh-input { background: #0d1117; border: 1px solid #444; color: #eee; padding: 6px 8px; border-radius: 4px; font-size: 12px; width: 100%; box-sizing: border-box; }
        .hh-input:focus { border-color: #e94560; outline: none; }
        .hh-check { display: flex; align-items: center; gap: 6px; margin: 8px 0 2px; font-size: 12px; color: #ccc; cursor: pointer; }
        .hh-check-note { font-size: 11px; color: #f85149; margin-bottom: 6px; }
    `;

    function statBlock(id, value, label, bordered) {
        const border = bordered ? ' style="border:1px solid #e94560;"' : '';
        return `
            <div class="hh-stat"${border}>
                <div class="hh-stat-val" id="${id}">${value}</div>
                <div class="hh-stat-label">${label}</div>
            </div>
        `;
    }

    function inputGroup(id, label, value, type = 'text') {
        return `
            <div class="hh-input-group">
                <label for="${id}">${label}</label>
                <input type="${type}" id="${id}" class="hh-input" value="${value}" />
            </div>
        `;
    }

    function panelHTML(dailyLimit) {
        return `
            <div id="hh-autoapply-header">
                <span>HH AutoApply</span>
                <div>
                    <button id="hh-btn-minimize" title="Свернуть">_</button>
                </div>
            </div>
            <div id="hh-autoapply-body">
                <div class="hh-stats">
                    ${statBlock('hh-stat-applied', '0', 'Отклики')}
                    ${statBlock('hh-stat-outline', '0', 'Аутлайн')}
                    ${statBlock('hh-stat-unclear', '0', 'Непонятное')}
                    ${statBlock('hh-stat-questions', '0', 'Вопросы')}
                    ${statBlock('hh-stat-total', '0', 'Всего')}
                    ${statBlock('hh-stat-daily', '0', `Обработано / ${dailyLimit}`, true)}
                </div>
                ${inputGroup('hh-input-url', 'URL для поиска (редирект)', CONFIG.searchRedirectUrl)}
                ${inputGroup('hh-input-limit', 'Дневной лимит обработки', CONFIG.dailyLimit, 'number')}
                <label class="hh-check">
                    <input type="checkbox" id="hh-input-ignore-captcha" ${CONFIG.ignoreCaptcha ? 'checked' : ''} />
                    Не останавливаться при капче
                </label>
                <div class="hh-check-note" id="hh-ignore-captcha-note" style="display:${CONFIG.ignoreCaptcha ? 'block' : 'none'};">
                    ⚠ Капча игнорируется — работа на свой риск
                </div>
                <div class="hh-step-info" id="hh-current-step">
                    <div class="step-label">Текущий шаг</div>
                    <div class="hh-step-desc" id="hh-step-desc">Нажмите "Собрать вакансии" для начала</div>
                </div>
                <div class="hh-btn-row">
                    <button class="hh-btn hh-btn-primary" id="hh-btn-collect">Собрать вакансии</button>
                    <button class="hh-btn hh-btn-success" id="hh-btn-next" disabled>Next →</button>
                    <button class="hh-btn hh-btn-secondary" id="hh-btn-auto">Авто</button>
                    <button class="hh-btn hh-btn-warn" id="hh-btn-show-outline">Аутлайн</button>
                    <button class="hh-btn hh-btn-warn" id="hh-btn-show-unclear" style="background:#d29922;">Непонятное</button>
                    <button class="hh-btn" id="hh-btn-clear-outline" style="background:#555;color:white;">Очистить</button>
                    <button class="hh-btn" id="hh-btn-download-questions" style="background:#3fb950;">Скачать вопросы</button>
                </div>
                <hr style="border-color:#444;margin:12px 0;">
                <div style="font-size:11px;color:#888;text-transform:uppercase;font-weight:bold;margin-bottom:8px;">Обработка автоотказов</div>
                <div class="hh-btn-row">
                    <button class="hh-btn hh-btn-success" id="hh-btn-reject-next" style="flex:1;">Next Отказ →</button>
                    <button class="hh-btn hh-btn-secondary" id="hh-btn-reject-auto">Авто-отказ</button>
                </div>
                <div id="hh-autoapply-log"></div>
            </div>
        `;
    }

    function createUI() {
        GM_addStyle(PANEL_CSS);

        const panel = document.createElement('div');
        panel.id = 'hh-autoapply-panel';
        panel.innerHTML = panelHTML(CONFIG.dailyLimit);
        document.body.appendChild(panel);

        bindButtons(panel);
        initDragDrop(panel, 'hh-autoapply-header', 'hh_panel_pos');
        updateAutoButton();
        updateAutoRejectButton();

        log('Панель загружена. Страница: ' + detectPageType());
    }

    function bindButtons(panel) {
        const bind = (id, fn) => {
            const el = document.getElementById(id);
            if (el) el.onclick = fn;
        };

        const minimizeBtn = document.getElementById('hh-btn-minimize');
        if (minimizeBtn) minimizeBtn.onclick = () => panel.classList.toggle('minimized');

        bind('hh-btn-collect', collectVacancies);
        bind('hh-btn-next', executeNextStep);
        bind('hh-btn-auto', toggleAutoMode);
        bind('hh-btn-show-outline', showOutlineLinks);
        bind('hh-btn-show-unclear', showUnclearOutlineLinks);
        bind('hh-btn-clear-outline', clearOutlineLinks);
        bind('hh-btn-download-questions', downloadCollectedQuestions);
        bind('hh-btn-reject-next', executeRejectNext);
        bind('hh-btn-reject-auto', toggleAutoRejectMode);

        const inputUrl = document.getElementById('hh-input-url');
        if (inputUrl) {
            inputUrl.addEventListener('change', (e) => {
                CONFIG.searchRedirectUrl = e.target.value.trim();
                saveConfig();
                log('URL для поиска обновлен', 'success');
            });
        }

        const inputLimit = document.getElementById('hh-input-limit');
        if (inputLimit) {
            inputLimit.addEventListener('change', (e) => {
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val) && val > 0) {
                    CONFIG.dailyLimit = val;
                    saveConfig();
                    updateStats();
                    log('Дневной лимит обработки обновлен: ' + val, 'success');
                }
            });
        }

        const inputIgnoreCaptcha = document.getElementById('hh-input-ignore-captcha');
        if (inputIgnoreCaptcha) {
            inputIgnoreCaptcha.addEventListener('change', (e) => {
                if (e.target.checked && !window.confirm(CAPTCHA_IGNORE_WARNING)) {
                    e.target.checked = false;
                    return;
                }
                CONFIG.ignoreCaptcha = e.target.checked;
                saveConfig();
                const note = document.getElementById('hh-ignore-captcha-note');
                if (note) note.style.display = CONFIG.ignoreCaptcha ? 'block' : 'none';
                log(CONFIG.ignoreCaptcha
                    ? 'Капча игнорируется: скрипт не будет останавливаться (на свой риск)'
                    : 'При капче скрипт будет останавливаться', CONFIG.ignoreCaptcha ? 'warn' : 'success');
            });
        }
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
            panel.style.right = 'auto';
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

    async function updateStats() {
        const el = (id) => document.getElementById(id);
        if (el('hh-stat-applied')) el('hh-stat-applied').textContent = STATE.appliedCount;
        if (el('hh-stat-skipped')) el('hh-stat-skipped').textContent = STATE.skippedCount;
        if (el('hh-stat-daily')) {
            const daily = getDailyCount();
            const remaining = getRemainingDailyCount();
            if (el('hh-stat-daily-label')) {
                el('hh-stat-daily-label').textContent = `Дневной лимит / ${CONFIG.dailyLimit}`;
            }
            el('hh-stat-daily').textContent = `${daily} / ${CONFIG.dailyLimit}`;
            // Если лимит исчерпан — подсвечиваем красным
            if (daily >= CONFIG.dailyLimit) {
                el('hh-stat-daily').style.color = '#f85149';
            } else {
                el('hh-stat-daily').style.color = '#e94560';
            }
        }
        if (el('hh-stat-outline')) el('hh-stat-outline').textContent = STATE.outlineLinks.length;
        const questionsData = await GM_getValue('hh_autoapply_collected_questions', []);
        if (el('hh-stat-questions')) el('hh-stat-questions').textContent = questionsData.length;
        if (el('hh-stat-total')) el('hh-stat-total').textContent = STATE.vacancies.length || '-';

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
            const applyBtn = qs(SELECTORS.applyButton, card);

            // Если кнопки отклика нет (уже откликнулись, отказ, приглашение и т.д.) - пропускаем
            if (!applyBtn) {
                log(`Пропускаю вакансию без кнопки "Откликнуться" (карточка #${idx + 1})`, 'info');
                return;
            }

            if (isAlreadyResponded(card)) {
                log(`Пропускаю уже откликавшуюся вакансию (карточка #${idx + 1})`, 'info');
                return;
            }
            const titleEl = qs(SELECTORS.vacancyTitleLink, card) || qs(SELECTORS.vacancyTitle, card);
            const title = titleEl ? titleEl.textContent.trim() : `Вакансия #${idx + 1}`;
            const companyEl = qs(SELECTORS.companyName, card);
            const company = companyEl ? companyEl.textContent.replace(/\s+/g, ' ').trim() : 'Неизвестная компания';
            const link = titleEl ? titleEl.href : '';
            if (isVacancySkipped(link)) {
                log(`Пропускаю запомненную аутлайн-вакансию: ${link}`, 'info');
                return;
            }
            
            STATE.vacancies.push({
                index: idx,
                title: title,
                link: link,
                applyBtn: applyBtn,
                card: card,
            });
            STATE.vacancies[STATE.vacancies.length - 1].company = company;
        });

        updateStats();
        saveState(); // Сохраняем состояние после сбора

        // Если вакансий не найдено — переходим по URL и ждём
        if (STATE.vacancies.length === 0) {
            STATE.emptyPageRetries = (STATE.emptyPageRetries || 0) + 1;
            
            if (STATE.emptyPageRetries >= 3) {
                if (STATE.emptyPageRestarts >= 1) {
                    log('Снова нет вакансий после паузы. Окончательная остановка авто-режима.', 'error');
                    setStepDesc('Нет вакансий. Авто-режим полностью остановлен.');
                    STATE.isRunning = false;
                    STATE.retryDelay = 0;
                    STATE.emptyPageRetries = 0;
                    STATE.emptyPageRestarts = 0;
                    saveState();
                    updateAutoButton();
                    return false;
                } else {
                    log('Нет вакансий 3 раза подряд. Отключаю авто-режим, пауза 10 секунд...', 'warn');
                    setStepDesc('Нет вакансий. Пауза 10 сек перед перезапуском...');
                    STATE.isRunning = false;
                    STATE.retryDelay = 0;
                    STATE.emptyPageRestarts = 1;
                    STATE.emptyPageRetries = 0;
                    saveState();
                    updateAutoButton();
                    
                    emptyPageTimeout = setTimeout(() => {
                        log('Возобновляю авто-режим после паузы...', 'info');
                        STATE.isRunning = true;
                        saveState();
                        updateAutoButton();
                        redirectSearch();
                    }, 10000);
                    return false;
                }
            }

            const delay = STATE.retryDelay || 3000;
            log(`Вакансии не найдены (попытка ${STATE.emptyPageRetries}/3). Перехожу по URL и жду ${delay/1000} сек...`, 'warn');
            setStepDesc(`Вакансии не найдены. Перезагрузка (попытка ${STATE.emptyPageRetries}/3)...`);
            // Увеличиваем задержку для следующего раза: 0→3сек, 3→7сек, 7→7сек
            STATE.retryDelay = STATE.retryDelay === 0 ? 3000 : 7000;
            saveState();
            redirectSearch();
            return false;
        }
        
        // Сброс счетчиков при успешном сборе
        STATE.retryDelay = 0;
        STATE.emptyPageRetries = 0;
        STATE.emptyPageRestarts = 0;

        log(`Найдено ${STATE.vacancies.length} вакансий на странице`, 'success');
        setStepDesc(`Найдено ${STATE.vacancies.length} вакансий. Нажмите Next для отклика на первую.`);
        document.getElementById('hh-btn-next').disabled = false;
        return true;
    }

    // Проверка дневного лимита
    function checkDailyLimitAndStop() {
        if (isDailyLimitReached()) {
            log('Достигнут дневной лимит обработки вакансий! (' + CONFIG.dailyLimit + ')', 'error');
            setStepDesc('⚠ Достигнут дневной лимит (' + CONFIG.dailyLimit + ' обработок)! Скрипт остановлен до завтра.');
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

    // Регистрирует успешный отклик и проверяет лимит
    function registerSuccessfulApply(title) {
        incrementDailyCount();
        STATE.appliedCount++;
        log(`Отклик зарегистрирован: "${title}"`, 'success');
        updateStats();
        saveState();
        return checkDailyLimitAndStop();
    }

    // СТОП при капче: скрипт замирает, пользователь решает капчу вручную
    function handleCaptchaStop(vacancy) {
        const title = (vacancy && vacancy.title) || 'вакансия';
        console.error('[HH-AUTOAPPLY] Капча при отклике! Пройдите капчу вручную, затем запустите скрипт снова. ' +
            '(Можно включить "Не останавливаться при капче" в настройках панели — на свой риск.)');
        log(`Капча при отклике: "${title}". Скрипт остановлен.`, 'error');
        setStepDesc(`КАПЧА при отклике: "${title}".\nПройдите её вручную и запустите скрипт снова.`);
        const nextBtn = document.getElementById('hh-btn-next');
        if (nextBtn) nextBtn.disabled = true;
        if (autoInterval) {
            clearTimeout(autoInterval);
            autoInterval = null;
        }
        if (emptyPageTimeout) {
            clearTimeout(emptyPageTimeout);
            emptyPageTimeout = null;
        }
        STATE.isRunning = false;
        saveState();
        updateAutoButton();
        updateStats();
        return 'stopped';
    }

    // Выполнить следующий шаг
    async function executeNextStep() {
        // Проверяем дневной лимит перед каждым шагом
        if (checkDailyLimitAndStop()) return;
        // Капча до начала шага: стоп, либо (по настройке) закрываем и продолжаем
        if (isCaptchaDetected()) {
            if (!CONFIG.ignoreCaptcha) {
                handleCaptchaStop();
                return;
            }
            log('Капча на странице — игнорирую (настройка), пробую закрыть', 'warn');
            await dismissCaptcha();
            if (/\/captcha/i.test(window.location.href)) return; // ушли на поиск
        }
        saveState(); // Сохраняем состояние в начале каждого шага

            if (STATE.currentVacancyIndex >= STATE.vacancies.length) {
            log('Все вакансии обработаны!', 'success');
            setStepDesc('Готово! Все вакансии обработаны.');
            document.getElementById('hh-btn-next').disabled = true;
            
            // Если включён авто-режим — перезапрашиваем страницу для новых вакансий
            if (STATE.isRunning) {
                if (detectPageType() === 'search') {
                    log('Авто-режим: все вакансии обработаны. Перезапрашиваю страницу...', 'success');
                    setTimeout(() => {
                        try {
                            window.location.reload();
                        } catch (e) {
                            redirectSearch();
                        }
                    }, 3000);
                }
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
            scheduleNextStep(2000);
        }
    }

    // Шаг на странице поиска: клик "Откликнуться" → единый пайплайн
    async function handleSearchPageStep(vacancy) {
        log(`Шаг: Обработка "${vacancy.title}"`, 'step');
        setStepDesc(`Отклик на: "${vacancy.title}"\nНажимаю кнопку отклика...`);

        if (!vacancy.applyBtn) {
            log('Кнопка отклика не найдена, пропускаю вакансию', 'warn');
            STATE.skippedCount++;
            finishVacancy(vacancy, `Пропущено (нет кнопки): "${vacancy.title}".`);
            return;
        }

        // Кликаем "Откликнуться"
        log('Кликаю кнопку отклика...', 'step');
        vacancy.applyBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await wait(CONFIG.clickDelay);
        vacancy.applyBtn.click();

        // Окно "отклик в другую страну"
        await checkAndHandleRelocationWarning();
        await wait(DELAYS.animation);

        // Определяем исход: аутлайн → модалка → поле письма
        const outcome = await waitForApplyOutcome(vacancy, 8000);
        await runUnifiedApply(vacancy, outcome);
    }

    // Добавляет вакансию в аутлайн с проверкой на дубликат по URL
    function addToOutline(title, url, company = 'Неизвестно') {
        // Проверяем, нет ли уже такой ссылки в аутлайне
        const exists = STATE.outlineLinks.some(item => item.link === url);
        if (exists) {
            log(`Вакансия уже в аутлайне: "${title}"`, 'info');
            return false;
        }
        STATE.outlineLinks.push({ title: title, link: url, company: company, sessionId: currentSessionId });
        incrementDailyCount();
        // Также запоминаем URL, чтобы пропускать при сборе
        if (url && !STATE.skippedVacancyUrls.includes(url)) {
            STATE.skippedVacancyUrls.push(url);
        }
        log(`Добавлено в аутлайн: "${title}"`, 'warn');
        return true;
    }

    // Добавляет вакансию в список "Непонятное" и в основной "Аутлайн"
    function addToUnclearOutline(title, url, company = 'Неизвестно') {
        // Проверяем, нет ли уже такой ссылки в списке
        const exists = STATE.unclearOutlineLinks.some(item => item.link === url);
        if (!exists) {
            STATE.unclearOutlineLinks.push({ title: title, link: url, company: company, sessionId: currentSessionId });
            log(`Добавлено в "Непонятное": "${title}"`, 'warn');
        }
        // Также добавляем в основной аутлайн, чтобы вакансия была пропущена при следующем сборе
        addToOutline(title, url, company);
        return true;
    }

    // Проверяет, должна ли вакансия быть пропущена (по точному URL или по ID вакансии)
    function isVacancySkipped(link) {
        if (!link) return false;
        if (STATE.skippedVacancyUrls.includes(link)) return true;
        const idMatch = link.match(/\/vacancy\/(\d+)/);
        if (idMatch) {
            const id = idMatch[1];
            return STATE.skippedVacancyUrls.some(u => {
                const m = u.match(/\/vacancy\/(\d+)/) || u.match(/vacancyId=(\d+)/);
                return m && m[1] === id;
            });
        }
        return false;
    }

    // Проверяет, есть ли на странице отклика отметка "Вы откликнулись"
    function isAlreadyRespondedOnPage() {
        // Ищем блок data-qa="already-responded-text" или текст "Вы откликнулись"
        if (qs(SELECTORS.alreadyRespondedText)) return true;
        // Также проверим по тексту (на случай если селектор изменится)
        try {
            const pageText = getPageText();
            if (pageText.includes('Вы откликнулись')) return true;
        } catch (e) {}
        return false;
    }

    // Пытается извлечь название вакансии из текста страницы
    function extractVacancyTitleFromPage() {
        let title = 'Неизвестная вакансия';
        let company = 'Неизвестная компания';

        // На странице отклика (response page)
        if (detectPageType() === 'response') {
            // Заголовок вакансии: сначала стабильный блок credentials, затем общий заголовок страницы
            const matched = firstMatch([SELECTORS.responseCredsTitle, SELECTORS.responseMainTitle]);
            if (matched) {
                const candidate = matched.el.textContent.trim();
                if (candidate === 'Отклик на вакансию' && matched.selector === SELECTORS.responseMainTitle) {
                    log('Заголовок — служебный "Отклик на вакансию", название не извлечено', 'warn');
                } else {
                    title = candidate;
                }
            }

            // Название компании: aria-label аватара, затем текстовый элемент (ХРУПКИЕ селекторы)
            const sidebarColumn = qs(SELECTORS.responseSidebarColumn);
            if (sidebarColumn) {
                const companyAvatar = sidebarColumn.querySelector(SELECTORS.responseCompanyAvatar);
                if (companyAvatar && companyAvatar.getAttribute('aria-label')) {
                    const ariaLabel = companyAvatar.getAttribute('aria-label').trim();
                    if (ariaLabel) company = ariaLabel;
                } else {
                    // Если аватара нет, ищем текстовый элемент компании, который не является заголовком вакансии
                    const companyTextEl = sidebarColumn.querySelector('[data-qa="cell-text-content"]');
                    if (companyTextEl) {
                        let potentialCompany = companyTextEl.textContent.replace(/\s+/g, ' ').trim();
                        if (potentialCompany.startsWith('Другое ')) { // Удаляем префикс "Другое"
                            potentialCompany = potentialCompany.substring('Другое '.length).trim();
                        }
                        if (potentialCompany !== title) { // Убедимся, что это не название вакансии
                            company = potentialCompany;
                        }
                    }
                }
            }
        } else { // Для других типов страниц (например, поиска)
            const titleEl = qs(SELECTORS.vacancyTitleLink) || qs(SELECTORS.vacancyTitle);
            if (titleEl) title = titleEl.textContent.trim();
            const companyEl = qs(SELECTORS.companyName);
            if (companyEl) company = companyEl.textContent.replace(/\s+/g, ' ').trim();
        }

        // Финальный запасной вариант для заголовка из title страницы
        if ((title === 'Неизвестная вакансия' || !title) && document.title) {
            title = document.title.replace(/— hh\.ru$/, '').replace(/— HH\.RU$/i, '').trim();
        }

        return { title, company };
    }

    // Функция для сбора информации о вопросах и сохранения в хранилище
    async function collectAndStoreQuestions() {
        log('Сбор данных со страницы с вопросами для последующего анализа...', 'step');
    
        const { title, company } = extractVacancyTitleFromPage();
        const url = window.location.href;
    
        const collectedData = {
            vacancyTitle: title, // Используем извлеченный заголовок
            companyName: company, // Используем извлеченную компанию
            // Сохраняем полный URL для точной идентификации опросника.
            vacancyUrl: url,
            answers: [] // Изменено с questions на answers для совместимости
        };
    
        const questionBlocks = qsa(SELECTORS.taskBody);
        if (questionBlocks.length === 0) {
            log('Не найдено блоков с вопросами на странице.', 'warn');
            return;
        }
    
        for (const block of questionBlocks) {
            const questionTextEl = qs(SELECTORS.taskQuestion, block);
            const question = {
                question: questionTextEl ? questionTextEl.innerText.trim() : 'Текст вопроса не найден'
            };
    
            const radioButtons = qsa('input[type="radio"]', block);
            const checkboxes = qsa('input[type="checkbox"]', block);
            const textField = qs('textarea', block) || qs('input[type="text"]', block);
    
            if (radioButtons.length > 0) {
                question.type = 'radio';
                // Логика сбора вариантов для radio-кнопок (аналогично checkbox)
                question.options = qsa('[data-qa="cell-text-content"]', block).map(label => label.textContent.trim());
            } else if (checkboxes.length > 0) {
                question.type = 'checkbox';
                // --- НОВОЕ: Сбор вариантов ответа для чекбоксов ---
                question.options = qsa('[data-qa="cell-text-content"]', block).map(label => label.textContent.trim());
            } else if (textField) {
                question.type = textField.tagName.toLowerCase(); // 'textarea' или 'input'
            }

            question.answer = ""; // Добавляем пустое поле для ответа
    
            collectedData.answers.push(question); // Добавляем в массив answers
        }
    
        // Сохранение в хранилище
        const allQuestions = await GM_getValue('hh_autoapply_collected_questions', []);

        // --- НОВАЯ ПРОВЕРКА НА ДУБЛИКАТЫ ---
        const isDuplicate = allQuestions.some(item => item.vacancyUrl === collectedData.vacancyUrl);
        if (isDuplicate) {
            log(`Вопросы для этой вакансии (URL) уже сохранены. Пропускаю дубликат.`, 'info');
            return;
        }

        if (collectedData.answers.length > 0) {
            allQuestions.push(collectedData); // Сохраняем новую структуру
            await GM_setValue('hh_autoapply_collected_questions', allQuestions);
            log(`Данные о ${collectedData.answers.length} вопросах сохранены. Всего в хранилище: ${allQuestions.length}`, 'success');
            updateStats();
        } else {
            log('На странице не найдено вопросов для сохранения.', 'warn');
        }
    }

    // Функция для скачивания накопленных вопросов
    async function downloadCollectedQuestions() {
        const allQuestions = await GM_getValue('hh_autoapply_collected_questions', []);
        if (allQuestions.length === 0) {
            log('Нет накопленных данных о вопросах для скачивания.', 'warn');
            return;
        }

        const jsonString = JSON.stringify(allQuestions, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `collected_questions_${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        log(`Файл с ${allQuestions.length} наборами вопросов скачан.`, 'success');
        URL.revokeObjectURL(url); // Освобождаем память
    }

    // Шаг на странице отклика /applicant/vacancy_response
    async function handleResponsePageStep() {
        const creds = extractVacancyTitleFromPage();
        const vacancy = {
            title: creds.title,
            company: creds.company,
            link: window.location.href,
            card: null,
        };
        log(`Страница отклика: "${vacancy.title}"`, 'step');
        setStepDesc(`Страница отклика: "${vacancy.title}".`);

        const outcome = await waitForApplyOutcome(vacancy, 5000);
        const status = await runUnifiedApply(vacancy, outcome);

        // После обработки страницы отклика возвращаемся на поиск
        if (status !== 'disabled' && status !== 'stopped') {
            STATE.returnedFromOutline = !!STATE.isRunning;
            saveState();
            redirectSearch();
        }
    }

    // Шаг на странице вакансии /vacancy/ (если попали туда по ссылке)
    async function handleVacancyPageStep() {
        log('Страница вакансии — ищу кнопку отклика', 'step');

        const applyMatch = firstMatch([
            SELECTORS.vacancyApplyTop,
            SELECTORS.vacancyApplyBottom,
            SELECTORS.anyResponseButton,
        ]);
        const applyBtn = applyMatch ? applyMatch.el : null;

        if (!applyBtn) {
            log('Кнопка отклика не найдена на странице вакансии', 'warn');
            STATE.skippedCount++;
            saveState();
            updateStats();
            return;
        }

        const vacancy = {
            title: document.title,
            link: window.location.href,
            company: '',
            card: null,
            applyBtn: applyBtn,
        };

        applyBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await wait(DELAYS.small);
        applyBtn.click();
        log('Нажал кнопку отклика на странице вакансии', 'step');

        await checkAndHandleRelocationWarning();
        await wait(DELAYS.wait);

        const outcome = await waitForApplyOutcome(vacancy, 8000);
        await runUnifiedApply(vacancy, outcome);
    }

    // ============================================================
    //  АВТОМАТИЧЕСКИЙ РЕЖИМ (заглушка — будет реализован позже)
    // ============================================================
    let autoInterval = null;
    let emptyPageTimeout = null;

    function scheduleNextStep(delayMs = 2000) {
        if (!STATE.isRunning) return;
        log(`Ожидаю ${delayMs / 1000} сек перед следующим шагом...`, 'info');
        if (autoInterval) clearTimeout(autoInterval);
        autoInterval = setTimeout(() => {
            if (STATE.isRunning) executeNextStep();
        }, delayMs);
    }

    function toggleAutoMode() {
        if (emptyPageTimeout) {
            clearTimeout(emptyPageTimeout);
            emptyPageTimeout = null;
        }
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
    async function clearOutlineLinks() {
        const questionsData = await GM_getValue('hh_autoapply_collected_questions', []);

        if (STATE.outlineLinks.length === 0 && STATE.unclearOutlineLinks.length === 0 && questionsData.length === 0) {
            log('Все списки ("Аутлайн", "Непонятное", "Вопросы") уже пусты.', 'info');
            return;
        }
        const confirmMsg = `Вы уверены, что хотите очистить все списки?\n\n` +
                         `- Аутлайн: ${STATE.outlineLinks.length} шт.\n` +
                         `- Непонятное: ${STATE.unclearOutlineLinks.length} шт.\n` +
                         `- Собранные вопросы: ${questionsData.length} шт.`;
        if (confirm(confirmMsg)) {
            STATE.outlineLinks = [];
            STATE.unclearOutlineLinks = [];
            // Также очищаем skippedVacancyUrls, чтобы эти вакансии снова обрабатывались
            STATE.skippedVacancyUrls = [];
            GM_setValue('hh_autoapply_collected_questions', []);
            saveState();
            updateStats();
            log('Список аутлайна очищен', 'success');
            setStepDesc('Аутлайн очищен. Вакансии снова будут обрабатываться.');
        }
    }

    // ============================================================
    //  МОДАЛЬНЫЕ ОКНА (общая реализация)
    // ============================================================
    function showModal({ title, color, bodyBg, bodyHTML, closeId }) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:100000;display:flex;align-items:center;justify-content:center;';
        const modal = document.createElement('div');
        modal.style.cssText = `background:${bodyBg};border:2px solid ${color};border-radius:12px;padding:24px;max-width:600px;width:90%;max-height:80vh;overflow-y:auto;color:#eee;font-family:sans-serif;`;
        modal.innerHTML = `
            ${bodyHTML}
            <br><button id="${closeId}" style="padding:8px 24px;background:${color};color:white;border:none;border-radius:6px;cursor:pointer;font-size:14px;">Закрыть</button>
        `;
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        document.getElementById(closeId).onclick = () => overlay.remove();
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    }

    function listItemHTML(item, idx, borderColor, bg) {
        return `
            <div style="margin:8px 0;padding:8px;background:${bg};border-radius:6px;border-left:3px solid ${borderColor};">
                <strong>${idx}. ${item.title}</strong> <span style="color:#aaa;">(${item.company || '?'})</span><br>
                <a href="${item.link}" target="_blank" style="color:#58a6ff;word-break:break-all;">${item.link}</a>
            </div>
        `;
    }

    function listModalHTML(items, color, bg, newColor, oldColor) {
        const oldLinks = items.filter(item => item.sessionId !== currentSessionId);
        const newLinks = items.filter(item => item.sessionId === currentSessionId);
        let html = '';
        let globalIndex = 1;

        if (newLinks.length > 0) {
            html += `<h3 style="color:${newColor}; margin: 16px 0 8px 0;">Новые (текущий прогон)</h3>`;
            html += newLinks.map(item => listItemHTML(item, globalIndex++, newColor, bg)).join('');
        }
        if (oldLinks.length > 0) {
            if (newLinks.length > 0) html += `<hr style="border-color:#444; margin: 24px 0;">`;
            html += `<h3 style="color:${oldColor}; margin: 16px 0 8px 0;">Ранее добавленные</h3>`;
            html += oldLinks.map(item => listItemHTML(item, globalIndex++, oldColor, bg)).join('');
        }
        return html;
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

        showModal({
            title: 'Аутлайн',
            color: '#e94560',
            bodyBg: '#1a1a2e',
            closeId: 'hh-outline-close',
            bodyHTML: `
                <h2 style="color:#e94560;margin-top:0">Аутлайн (${STATE.outlineLinks.length})</h2>
                <p>Вакансии, требующие ручной обработки:</p>
                ${listModalHTML(STATE.outlineLinks, '#e94560', '#16213e', '#3fb950', '#888')}
            `,
        });
    }

    // ============================================================
    //  ПОКАЗ СПИСКА "НЕПОНЯТНОЕ"
    // ============================================================
    function showUnclearOutlineLinks() {
        if (STATE.unclearOutlineLinks.length === 0) {
            log('Список "Непонятное" пуст.', 'info');
            setStepDesc('Список "Непонятное" пуст.');
            return;
        }

        log(`=== НЕПОНЯТНОЕ (${STATE.unclearOutlineLinks.length} вакансий) ===`, 'error');
        STATE.unclearOutlineLinks.forEach((item, idx) => {
            log(`${idx + 1}. ${item.title}\n   ${item.link}`, 'error');
        });

        showModal({
            title: 'Непонятное',
            color: '#f85149',
            bodyBg: '#2e1a1a',
            closeId: 'hh-unclear-close',
            bodyHTML: `
                <h2 style="color:#f85149;margin-top:0">Непонятное (${STATE.unclearOutlineLinks.length})</h2>
                <p>Вакансии, где скрипт не смог определить результат:</p>
                ${listModalHTML(STATE.unclearOutlineLinks, '#f85149', '#221616', '#FF9800', '#888')}
            `,
        });
    }

    // ============================================================
    //  ОБРАБОТКА АВТООТКАЗОВ (ЧАТЫ)
    // ============================================================
    function toggleAutoRejectMode() {
        REJECT_STATE.isRunning = !REJECT_STATE.isRunning;
        updateAutoRejectButton();
        
        if (REJECT_STATE.isRunning) {
            log('Авто-режим отказов запущен', 'success');
            executeRejectNext();
        } else {
            log('Авто-режим отказов остановлен', 'warn');
            if (autoRejectInterval) {
                clearTimeout(autoRejectInterval);
                autoRejectInterval = null;
            }
        }
    }

    function updateAutoRejectButton() {
        const btn = document.getElementById('hh-btn-reject-auto');
        if (!btn) return;
        if (REJECT_STATE.isRunning) {
            btn.textContent = 'Стоп (Отказ)';
            btn.classList.remove('hh-btn-secondary');
            btn.classList.add('hh-btn-warn');
        } else {
            btn.textContent = 'Авто-отказ';
            btn.classList.remove('hh-btn-warn');
            btn.classList.add('hh-btn-secondary');
        }
    }

    // Слова-маркеры живого интереса: приглашение, просьба позвонить/написать, вопрос.
    // Такие чаты НИКОГДА не открываем — пусть остаются непрочитанными для пользователя.
    // Приоритет выше, чем у отказов: «Спасибо за отклик! Приглашаем на интервью» — это приглашение.
    const CHAT_INVITE_KEYWORDS = [
        // приглашение / встреча
        'приглаша', 'приглашени', 'собеседовани', 'интервью', 'встреч', 'следующий этап', 'следующему этапу',
        'созвон', 'созвонить', 'позвон', 'звонок', 'перезвон', 'видеозвон', 'zoom', 'зум', 'телемост',
        // просьба связаться / написать
        'свяжитесь', 'напишите', 'ответьте', 'пришлите', 'отправьте', 'оставьте', 'укажите', 'сообщите',
        'telegram', 'телеграм', 'whatsapp', 'ватсап', 'вотсап', 'номер телефона', 'ваш номер', 'ваш телефон',
        // вопросы / дальнейшие шаги
        'удобно', 'удобное время', 'когда вам', 'актуальн', 'расскажите', 'уточнить', 'уточните',
        'готовы ли', 'интересно ли', 'интересна ли', 'зарплатные ожидания', 'ожидания по',
        'тестовое', 'тестового', 'анкет', 'заполните', 'пройдите', 'опрос', 'forms.gle', 'google.com/forms', 'forms.yandex',
        'заинтересовало ваше', 'заинтересовал ваш', 'нас заинтересова', 'хотели бы обсудить', 'давайте обсудим',
        'хотим предложить', 'хотели бы предложить', 'готовы предложить вам', 'оффер',
    ];

    // Однозначный отказ (с отрицанием) — проверяется РАНЬШЕ приглашений:
    // «не готовы пригласить вас на следующий этап» содержит и «приглас», и «следующий этап»
    const CHAT_HARD_REJECT_KEYWORDS = [
        'вынуждены отказать', 'не готовы пригласить', 'не можем пригласить', 'не сможем пригласить',
        'не готовы продолжить', 'не сможем предложить', 'не готовы предложить вам', 'не готовы рассмотреть',
        'не соответствует', 'кандидатура не', 'сделали выбор в пользу', 'отдали предпочтение',
        'остановились на другом', 'выбрали другого', 'закрыли эту позицию', 'закрыли вакансию', 'вакансия закрыта',
        'приостановили поиск', 'поиск приостановлен', 'поставлена на паузу', 'неактуальн', 'не актуальн',
        'потеряла актуальность',
        // Автоответы с условным «напишет/позвонит» — иначе их поймали бы слова-приглашения
        'ответы отправлены', 'ответы на вопросы отправлены', 'если ваш отклик его заинтересует',
        'если ваш отклик заинтересует', 'если отклик заинтересует', 'если ваше резюме заинтересует',
        'если ваша кандидатура заинтересует', 'он напишет в этом же чате',
    ];

    // Отказы и автоотписки «приняли, ждите» — такие чаты открываем (помечаем прочитанными)
    const CHAT_REJECT_KEYWORDS = [
        // --- Прямые отказы ---
        'отказ', 'к сожалению', 'не подходит',
        'желаем удачи', 'успехов в поиске', 'дальнейших профессиональных успехов', 'удачи в поиске',
        // --- Кадровый резерв ---
        'сохраним ваше резюме', 'в кадровый резерв', 'в нашей базе', 'будем иметь вас в виду',
        'вернемся к вам, если', 'если появится подходящая',
        // --- Автоотписки «приняли, ждите» ---
        'спасибо за отклик', 'благодарим за отклик', 'благодарим вас за отклик', 'спасибо за ваш отклик',
        'спасибо за проявленный интерес', 'благодарим за интерес', 'спасибо за интерес',
        'успешно зарегистрирован', 'отклик получен', 'получили ваш отклик', 'получили ваше резюме',
        'отклик зарегистрирован', 'направлен в', 'передали ваше резюме', 'передано руководителю',
        'передали руководителю', 'внимательно ознакомились', 'ознакомимся', 'рассмотрим ваше резюме',
        'рассмотрим вашу кандидатуру', 'рассмотрим ваш отклик', 'в ближайшее время', 'свяжемся с вами',
        'обязательно свяжемся', 'если ваша кандидатура', 'если ваше резюме', 'если оно заинтересует',
        'если навыки', 'если ваш опыт', 'если опыт', 'подойдут для позиции', 'подойдет для позиции',
        'в случае заинтересованности', 'в случае положительного',
    ];

    function normChatText(value) {
        return (value || '').replace(/ /g, ' ').replace(/ё/gi, 'е').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    /**
     * 'invite' — приглашение/вопрос/просьба связаться (не трогаем),
     * 'reject' — отказ или автоотписка (открываем),
     * 'unknown' — непонятно (не трогаем, безопасный вариант).
     */
    function classifyChatMessage(text) {
        const t = normChatText(text);
        if (!t) return 'unknown';
        if (CHAT_HARD_REJECT_KEYWORDS.some(k => t.includes(k))) return 'reject';
        if (CHAT_INVITE_KEYWORDS.some(k => t.includes(k))) return 'invite';
        // Вопрос от работодателя («Вы ответили на опросник…?») — ждёт ответа, не трогаем
        if (t.includes('?')) return 'invite';
        if (CHAT_REJECT_KEYWORDS.some(k => t.includes(k))) return 'reject';
        // Вопрос работодателя без явных маркеров — скорее живой человек, не трогаем
        return 'unknown';
    }

    /**
     * Классификация карточки чата целиком:
     *  - 'own'    — последнее сообщение наше (у него галочки «доставлено/прочитано»),
     *  - системный статус hh по цвету: красный «Отказ» → 'reject', зелёный «Собеседование»/«Отклик» → 'invite',
     *  - иначе — по тексту сообщения работодателя.
     */
    function classifyChatCell(cell, message) {
        if (qs('[data-qa^="status-icon-"]', cell)) return 'own';
        const msgEl = qs(SELECTORS.chatLastMessage, cell);
        const cls = msgEl ? String(msgEl.className) : '';
        if (cls.includes('last-message-color_red')) return 'reject';
        if (cls.includes('last-message-color_green')) return 'invite';
        return classifyChatMessage(message);
    }

    function getChatId(cell) {
        const m = (cell.getAttribute('data-qa') || '').match(/chatik-open-chat-(\d+)/) || (cell.getAttribute('href') || '').match(/\/chat\/(\d+)/);
        return m ? m[1] : null;
    }

    // Только текст последнего сообщения — без названия вакансии и компании
    function getChatLastMessage(cell) {
        const el = qs(SELECTORS.chatLastMessage, cell);
        if (el) return el.textContent || '';
        let text = cell.textContent || '';
        [SELECTORS.chatCellTitle, SELECTORS.chatCellSubtitle].forEach(sel => {
            const part = qs(sel, cell);
            if (part) text = text.replace(part.textContent, ' ');
        });
        return text;
    }

    // Включает фильтр «Только непрочитанные»
    async function ensureOnlyUnreadFilter() {
        const cb = qs(SELECTORS.chatOnlyUnreadCheckbox);
        if (cb) {
            if (!cb.checked) {
                log('Включаю фильтр "Только непрочитанные"...', 'info');
                (cb.closest('label') || cb).click();
                await wait(DELAYS.animation); // ждём перезагрузку списка
            }
            return;
        }
        // Запасной вариант, если data-qa поменяется
        const label = qsa('label').find(l => normChatText(l.textContent).includes('только непрочитанные'));
        const fallbackCb = label && qsa('input[type="checkbox"]', label).pop();
        if (fallbackCb && !fallbackCb.checked) {
            log('Включаю фильтр "Только непрочитанные"...', 'info');
            label.click();
            await wait(DELAYS.animation);
        }
    }

    // Ближайший прокручиваемый предок списка чатов
    function getChatScrollContainer() {
        let el = qs(SELECTORS.chatCell);
        while (el && el !== document.body) {
            const style = getComputedStyle(el);
            if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight) return el;
            el = el.parentElement;
        }
        return null;
    }

    // Ищет среди отрисованных строк непрочитанный чат с отказом/автоотпиской
    function findRejectChatOnScreen() {
        for (const cell of qsa(SELECTORS.chatCell)) {
            const id = getChatId(cell);
            if (!id || REJECT_STATE.processedIds.has(id) || REJECT_STATE.keptIds.has(id)) continue;
            if (!qs(SELECTORS.chatUnreadBadge, cell)) continue; // прочитан — пропускаем

            const message = getChatLastMessage(cell);
            const kind = classifyChatCell(cell, message);
            const company = normText((qs(SELECTORS.chatCellSubtitle, cell) || {}).textContent) || '?';
            const preview = normText(message).slice(0, 80);

            if (kind === 'reject') return { cell, id, company, preview };

            REJECT_STATE.keptIds.add(id);
            if (kind === 'own') continue; // последнее сообщение наше — молча пропускаем
            if (kind === 'invite') {
                log(`📩 ${company}: похоже на приглашение/вопрос — НЕ трогаю: «${preview}…»`, 'success');
            } else {
                log(`❔ ${company}: непонятное сообщение — оставляю непрочитанным: «${preview}…»`, 'warn');
            }
        }
        return null;
    }

    async function executeRejectNext() {
        if (!location.pathname.includes('/chat') && !location.pathname.includes('/applicant/negotiations')) {
            log('Для работы с отказами перейдите на страницу чатов (/chat или /applicant/negotiations)', 'error');
            if (REJECT_STATE.isRunning) toggleAutoRejectMode();
            return;
        }

        // Дадим странице немного времени на полную прорисовку
        await wait(DELAYS.small);
        await ensureOnlyUnreadFilter();

        log('Ищу непрочитанные отказы и автоотписки...', 'info');

        // Список виртуальный: если на экране нечего обрабатывать — прокручиваем дальше
        let target = findRejectChatOnScreen();
        const scroller = target ? null : getChatScrollContainer();
        for (let i = 0; !target && scroller && i < 20; i++) {
            const before = scroller.scrollTop;
            scroller.scrollTop += Math.max(200, scroller.clientHeight * 0.8);
            await wait(DELAYS.wait); // подгрузка строк
            target = findRejectChatOnScreen();
            if (!target && scroller.scrollTop === before) break; // дошли до конца
        }

        if (!target) {
            log('Непрочитанных отказов/автоотписок больше нет.', 'success');
            if (REJECT_STATE.isRunning) toggleAutoRejectMode();
            return;
        }

        REJECT_STATE.processedIds.add(target.id);
        log(`Отказ/автоотписка от ${target.company}: «${target.preview}…» — открываю`, 'step');

        target.cell.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await wait(DELAYS.click);
        try {
            target.cell.click();
        } catch (e) {
            log('Не удалось кликнуть по сообщению: ' + e.message, 'error');
        }

        await wait(DELAYS.step);

        if (REJECT_STATE.isRunning) {
            autoRejectInterval = setTimeout(() => {
                if (REJECT_STATE.isRunning) executeRejectNext();
            }, 100);
        } else {
            log('Готово. Можно нажимать "Next Отказ" для следующего.', 'success');
        }
    }

    // ============================================================
    //  ЗАПУСК И ИНИЦИАЛИЗАЦИЯ
    // ============================================================
    async function init() {
        // Проверяем, что мы на hh.ru
        if (!location.hostname.includes('hh.ru')) return;

        // Восстанавливаем состояние после редиректа
        const savedState = GM_getValue('hh_autoapply_state', null);
        if (savedState) {
            STATE.skippedVacancyUrls = savedState.skippedVacancyUrls || [];
            STATE.returnedFromOutline = savedState.returnedFromOutline || false;
            STATE.isRunning = savedState.isRunning || false;
            STATE.retryDelay = savedState.retryDelay || 0;
            STATE.emptyPageRetries = savedState.emptyPageRetries || 0;
            STATE.emptyPageRestarts = savedState.emptyPageRestarts || 0;
            // Восстанавливаем аутлайн и вакансии
            STATE.outlineLinks = savedState.outlineLinks || [];
            STATE.unclearOutlineLinks = savedState.unclearOutlineLinks || [];
            // Восстанавливаем счетчики
            STATE.appliedCount = savedState.appliedCount || 0;
            STATE.skippedCount = savedState.skippedCount || 0;
            if (savedState.vacancies && savedState.vacancies.length > 0) {
                STATE.vacancies = savedState.vacancies;
                STATE.currentVacancyIndex = savedState.currentVacancyIndex || 0;
                log(`Восстановлено ${STATE.vacancies.length} вакансий из предыдущей сессии.`, 'success');
            }
        }

        // Создаем UI
        createUI();
        await updateStats(); // Обновляем статистику сразу после создания UI
        log('Скрипт загружен. Тип страницы: ' + detectPageType(), 'success');
        log(`Дневной лимит обработок: ${getDailyCount()}/${CONFIG.dailyLimit}`, 'info');

        // Если есть восстановленные вакансии, активируем кнопку Next
        if (STATE.vacancies.length > 0 && STATE.currentVacancyIndex < STATE.vacancies.length) {
            document.getElementById('hh-btn-next').disabled = false;
            // Убедимся, что DOM-элементы для текущей вакансии существуют, если нет - пересобираем
            if (detectPageType() === 'search' && (!STATE.vacancies[STATE.currentVacancyIndex].card || !STATE.vacancies[STATE.currentVacancyIndex].applyBtn)) {
                log('DOM-элементы не найдены, пересобираю вакансии на странице...', 'info');
                collectVacancies();
            }
            setStepDesc(`Готов к работе. ${STATE.currentVacancyIndex + 1}/${STATE.vacancies.length}: "${STATE.vacancies[STATE.currentVacancyIndex].title}"`);
        } else {
            setStepDesc('Нажмите "Собрать вакансии" для начала');
        }

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
                        saveState(); // Сохраняем состояние после сбора
                        resumeAutoMode();
                    }
                }, 1000);
                // Если через 20 сек всё ещё не страница поиска — пробуем собрать в любом случае
                setTimeout(() => {
                    clearInterval(waitForSearch);
                    if (detectPageType() === 'search') {
                        collectVacancies();
                        saveState(); // Сохраняем состояние после сбора
                    } else {
                        log('Страница не загрузилась как поиск. Перезагружаю...', 'warn');
                        redirectSearch();
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
                saveState(); // Сохраняем состояние после сбора
                if (!collected) return;
                resumeAutoMode();
            }, 5000);
        return;
    }

    // Если мы перезагрузили страницу (или перешли на новую) и авто-режим активен
    if (detectPageType() === 'search' && STATE.isRunning) {
        log('Авто-режим активен. Жду прогрузки карточек вакансий...', 'step');
        let attempts = 0;
        const waitCards = setInterval(() => {
            attempts++;
            if (document.querySelector(SELECTORS.vacancyCard)) {
                clearInterval(waitCards);
                collectVacancies();
                saveState(); // Сохраняем состояние после сбора
                resumeAutoMode();
            } else if (attempts >= 20) { // Ждем до 10 секунд (20 * 500ms)
                clearInterval(waitCards);
                collectVacancies(); // Вызовет логику retryDelay, если ничего не найдет
                saveState(); // Сохраняем состояние после сбора
            }
        }, 500);
        }
    }

    // Обработка при загрузке на странице отклика (редирект из модалки или от клика на карточке)
    async function handleResponsePageRedirect() {
        const creds = extractVacancyTitleFromPage();
        const vacancy = {
            title: creds.title,
            company: creds.company,
            link: window.location.href,
            card: null,
        };
        log(`Страница отклика: "${vacancy.title}"`, 'info');

        document.getElementById('hh-btn-next').disabled = false;

        // Не в авто-режиме страницу не трогаем: на ней может работать респондер или сам пользователь
        if (!STATE.isRunning) {
            setStepDesc(`Страница отклика: "${vacancy.title}". Нажмите Next для обработки.`);
            return;
        }

        // Сценарий 3: вопросы работодателя — автоматически в аутлайн
        if (isOutlineDetected()) {
            await handleOutlineOutcome(vacancy);
            return;
        }

        // В авто-режиме обрабатываем сразу (письмо → "Отправить")
        const outcome = await waitForApplyOutcome(vacancy, 5000);
        const status = await runUnifiedApply(vacancy, outcome === 'none' ? 'response' : outcome);
        if (status !== 'disabled' && status !== 'stopped') {
            STATE.returnedFromOutline = true;
            saveState();
            redirectSearch();
        }
    }

    // Запуск
    // Ждём полной загрузки страницы перед запуском
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        init();
    } else {
        window.addEventListener('DOMContentLoaded', init);
    }
})();
