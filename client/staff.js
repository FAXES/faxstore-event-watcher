/*! FaxStore Event Watcher staff page - Weblutions */
(function () {
    'use strict';
    const form = document.getElementById('ewForm');
    if (!form) return;
    let data = {};
    try { data = JSON.parse(document.getElementById('ewData').textContent); } catch (e) {}

    // sendToast() writes the message as HTML, so it's escaped here
    function toast(msg, color) {
        const text = String(msg).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
        if (typeof window.sendNotification === 'function') window.sendNotification({msg: text, color: color});
        else if (typeof window.sendToast === 'function') window.sendToast({msg: text, color: color});
        else alert(msg);
    }

    // Tabs
    const tabInput = form.querySelector('[name="tab"]');
    const buttons = form.querySelectorAll('[data-tab-btn]');
    function showTab(name) {
        if (!form.querySelector(`[data-tab="${name}"]`)) name = buttons[0].getAttribute('data-tab-btn');
        buttons.forEach(b => {
            const on = b.getAttribute('data-tab-btn') === name;
            b.classList.toggle('ew-tab-active', on);
            b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        form.querySelectorAll('[data-tab]').forEach(p => { p.hidden = p.getAttribute('data-tab') !== name; });
        tabInput.value = name;
        history.replaceState(null, '', '#' + name);
    }
    buttons.forEach(b => b.addEventListener('click', () => showTab(b.getAttribute('data-tab-btn'))));
    showTab(location.hash.slice(1) || data.tab);

    // Unsaved changes
    let dirty = false;
    const saveState = document.getElementById('ewSaveState'), savebar = document.getElementById('ewSavebar');
    function setDirty(on) {
        dirty = on;
        saveState.textContent = on ? 'You have unsaved changes' : 'All changes saved';
        savebar.classList.toggle('ew-savebar-dirty', on);
    }
    form.addEventListener('input', () => setDirty(true));
    form.addEventListener('change', () => setDirty(true));
    form.addEventListener('submit', () => { dirty = false; });
    window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

    form.addEventListener('click', e => {
        // Product overrides
        const add = e.target.closest('[data-add-product]');
        if (add) {
            const name = add.getAttribute('data-add-product');
            const list = form.querySelector(`[data-products="${name}"]`);
            list.insertAdjacentHTML('beforeend', document.getElementById('ewProductRow').innerHTML.replace(/__EVENT__/g, name));
            const row = list.lastElementChild;
            row.querySelector('input[type="color"]').value = form.querySelector(`[name="${name}.embedColor"]`).value;
            row.querySelector('select').focus();
            setDirty(true);
            return;
        }
        const remove = e.target.closest('[data-remove-product]');
        if (remove) {
            remove.closest('.ew-product').remove();
            setDirty(true);
            return;
        }

        // Test using what's on the page, saved or not
        const test = e.target.closest('[data-test]');
        if (!test) return;
        const name = test.getAttribute('data-test');
        const field = key => form.querySelector(`[name="${name}.${key}"]:not([type="hidden"])`);
        const body = {
            event: name,
            discordChannel: field('discordChannel') ? field('discordChannel').value : '',
            embedColor: field('embedColor') ? field('embedColor').value : '',
            pushover: field('pushover').checked
        };
        test.disabled = true;
        fetch('/backend/event-watcher/test', {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})
            .then(r => r.json())
            .then(res => {
                if (res.sent.length) toast(`Test sent to ${res.sent.join(' and ')}. ${res.errors.join(' ')}`, res.errors.length ? 'orange' : 'green');
                else toast(res.errors.join(' '), 'red');
            })
            .catch(() => toast('The test couldn\'t be sent.', 'red'))
            .finally(() => { test.disabled = false; });
    });
})();
