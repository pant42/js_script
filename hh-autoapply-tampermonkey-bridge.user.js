// ==UserScript==
// @name         HH.ru AutoApply - Bridge (Tampermonkey)
// @namespace    http://tampermonkey.net/
// @version      0.2.1
// @description  Загрузчик: подключает локальный файл hh-autoapply.user.js через @require file:/// или локальный HTTP-сервер
// @author       You
// @match        https://*.hh.ru/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// @run-at       document-idle
// @require      file:///C:/hh-autoapply/hh-autoapply.user.js
// ==/UserScript==
// ============================================================
//  ИНСТРУКЦИЯ ПО УСТАНОВКЕ
// ============================================================
//
// === СПОСОБ 1: @require file:/// (рекомендуется) ===
//
// 1. Создайте папку на диске, например:
//    Windows: C:\hh-autoapply\
//    Linux:   /home/user/hh-autoapply/
//    Mac:     /Users/user/hh-autoapply/
//
// 2. Скопируйте файл hh-autoapply.user.js в эту папку
//
// 3. В строке @require выше замените путь на ваш реальный:
//    Windows: @require file:///C:/hh-autoapply/hh-autoapply.user.js
//    Linux:   @require file:///home/user/hh-autoapply/hh-autoapply.user.js
//    Mac:     @require file:///Users/user/hh-autoapply/hh-autoapply.user.js
//
//    ВАЖНО: На Windows используйте прямые слеши (file:///C:/...),
//    а не обратные (НЕ file:///C:\...)
//
// 4. В Tampermonkey → Настройки → Общие →
//    "Разрешить доступ к файлам по URL" — ВКЛЮЧИТЬ
//    (иначе @require file:// не сработает)
//
// 5. Создайте новый скрипт в Tampermonkey, вставьте содержимое
//    ЭТОГО файла, сохраните.
//
// 6. Зайдите на hh.ru — панель автоотклика появится справа внизу
//
//
// === СПОСОБ 2: Локальный HTTP-сервер (если file:// не работает) ===
//
// 1. Положите hh-autoapply.user.js в папку проекта
//
// 2. Запустите в этой папке простой HTTP-сервер:
//    Python:   python3 -m http.server 8080
//    Node.js:  npx serve -l 8080
//    PHP:      php -S localhost:8080
//
// 3. В этом файле закомментируйте строку @require и
//    раскомментируйте блок GM_xmlhttpRequest ниже
//
// 4. Файл будет загружаться с http://localhost:8080/hh-autoapply.user.js
//
//
// === СПОСОБ 3: Встроить код напрямую ===
//
// Просто скопируйте ВСЁ содержимое hh-autoapply.user.js
// и вставьте ВМЕСТО этого файла в Tampermonkey
// (удалив строку @require)
//
// ============================================================
// ─── Проверка: загрузился ли скрипт через @require? ───
(function () {
'use strict';

// Ждём появления панели от основного скрипта (он может создаваться с задержкой)
let panelCheckCount = 0;
const panelCheckInterval = setInterval(() => {
    panelCheckCount++;
    if (document.getElementById('hh-autoapply-panel')) {
        clearInterval(panelCheckInterval);
        console.log('[HH-Bridge] Основной скрипт загружен через @require. Всё ок!');
        return;
    }
    // Ждём до 3 секунд (6 попыток по 500мс)
    if (panelCheckCount >= 6) {
        clearInterval(panelCheckInterval);
        // Панель не появилась — пробуем загрузить через HTTP
        console.log('[HH-Bridge] @require не сработал. Пробуем загрузить через localhost...');
        tryLoadFromHttp();
    }
}, 500);

function tryLoadFromHttp() {
    // ─── Настройка HTTP-загрузки (Способ 2) ───
    const LOCAL_SERVER_URL = 'http://localhost:8080/hh-autoapply.user.js';
    
    GM_xmlhttpRequest({
        method: 'GET',
        url: LOCAL_SERVER_URL,
        onload: function (response) {
            if (response.status === 200) {
                try {
                    // Выполняем загруженный скрипт
                    eval(response.responseText);
                    console.log('[HH-Bridge] Скрипт загружен из локального HTTP-сервера!');
                    
                    // После загрузки через eval, ждём появления панели
                    setTimeout(() => {
                        if (!document.getElementById('hh-autoapply-panel')) {
                            showManualHint();
                        }
                    }, 2000);
                } catch (err) {
                    console.error('[HH-Bridge] Ошибка выполнения скрипта:', err);
                    showManualHint();
                }
            } else {
                console.log('[HH-Bridge] HTTP-сервер вернул статус:', response.status);
                showManualHint();
            }
        },
        onerror: function () {
            // Просто логируем, но НЕ показываем подсказку — это нормально,
            // если сервер не запущен, а @require уже сработал (но панель ещё не создалась)
            console.log('[HH-Bridge] localhost:8080 недоступен (это нормально, если @require сработал)');
            // Всё равно показываем подсказку, только если прошло достаточно времени
            // и панель так и не появилась
            setTimeout(() => {
                if (!document.getElementById('hh-autoapply-panel')) {
                    showManualHint();
                }
            }, 3000);
        }
    });
}

// Подсказка если ничего не сработало
function showManualHint() {
    // Проверяем ещё раз — вдруг панель уже появилась
    if (document.getElementById('hh-autoapply-panel')) return;
    
    const hint = document.createElement('div');
    hint.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#1a1a2e;border:2px solid #e94560;border-radius:12px;padding:16px;z-index:99999;color:#eee;font-family:sans-serif;font-size:13px;max-width:400px;';
    hint.innerHTML = `
<h3 style="color:#e94560;margin:0 0 8px">HH AutoApply: Ошибка загрузки</h3>
<p>Не удалось загрузить локальный скрипт. Проверьте:</p>
<ol style="margin:4px 0;padding-left:20px;line-height:1.6">
<li>Файл <code style="color:#58a6ff">hh-autoapply.user.js</code> существует по пути из @require</li>
<li>Tampermonkey → Настройки → "Доступ к файлам" включён</li>
<li>ИЛИ запустите HTTP-сервер:<br><code style="color:#58a6ff">python3 -m http.server 8080</code></li>
</ol>
<button onclick="this.parentElement.remove()" style="margin-top:8px;padding:6px 16px;background:#e94560;color:white;border:none;border-radius:6px;cursor:pointer">Понятно</button>
`;
    document.body.appendChild(hint);
}
})();
