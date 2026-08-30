/* ============================================================
   ui-select.js — поиск и клавиатура в списках выбора.

   Родной <select> остаётся в разметке и остаётся источником правды:
   код страницы читает .value, ловит change и перерисовывает options
   через innerHTML — трогать его не нужно.

   Открытая панель на всю страницу одна, и закрывает её один общий
   обработчик. Раньше каждый список слушал документ сам, и панель
   могла пережить клик, который её должен был закрыть.
   ============================================================ */
(function () {
  'use strict';

  var MIN_FOR_SEARCH = 8;      // короткие списки строкой поиска не захламляем
  var current = null;          // { close, wrap, panel, btn }
  var closedAt = 0;            // чтобы клик по кнопке не открыл панель заново

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  }

  function closeCurrent() { if (current) current.close(); }

  // ---------- один сторож на всю страницу ----------

  document.addEventListener('pointerdown', function (e) {
    if (!current) return;
    if (current.panel.contains(e.target) || current.wrap.contains(e.target)) return;
    current.close();
  }, true);

  // Пока панель открыта, стрелки и Enter принадлежат ей — независимо от того,
  // где сейчас фокус. Раньше слушал сам список, и если фокус успевал уехать
  // из строки поиска, Enter не выбирал ничего.
  document.addEventListener('keydown', function (e) {
    if (!current) return;
    if (e.key === 'Escape') { e.preventDefault(); var b = current.btn; current.close(); b.focus(); return; }
    current.onKey(e);
  }, true);

  // Прокрутка страницы: панель едет за полем. Прокрутка внутри самой
  // панели пересчёт не трогает, иначе список дёргался бы под пальцем.
  window.addEventListener('scroll', function (e) {
    if (!current) return;
    if (e.target && e.target.nodeType === 1 && current.panel.contains(e.target)) return;
    current.reposition(true);
  }, true);

  window.addEventListener('resize', function () { if (current) current.reposition(true); });
  window.addEventListener('blur', closeCurrent);
  document.addEventListener('visibilitychange', function () { if (document.hidden) closeCurrent(); });

  // Кнопка должна выглядеть ровно как поле, которое она заменяет.
  // На странице три разных вида селектов, поэтому берём их живые стили.
  var COPY = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'borderStyle', 'borderColor', 'borderRadius', 'backgroundColor', 'minHeight'];

  function dressLikeNative(btn, sel) {
    var cs = window.getComputedStyle(sel);
    COPY.forEach(function (p) { btn.style[p] = cs[p]; });
    btn.style.paddingRight = (parseFloat(cs.paddingRight) + 16) + 'px';   // место под галочку
  }

  var seq = 0;

  function enhance(sel) {
    if (!sel || sel.multiple || sel.dataset.uisel || sel.hasAttribute('data-uisel-skip')) return;
    sel.dataset.uisel = 'on';
    var uid = 'uisel' + (++seq);

    var wrap = document.createElement('div');
    wrap.className = 'uisel';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add('uisel-native');
    sel.setAttribute('tabindex', '-1');       // фокус живёт на кнопке

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'uisel-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', uid);
    btn.innerHTML = '<span class="uisel-val"></span><i class="fas fa-chevron-down uisel-caret"></i>';
    wrap.appendChild(btn);
    dressLikeNative(btn, sel);

    var panel = document.createElement('div');
    panel.className = 'uisel-panel';
    panel.id = uid;
    panel.hidden = true;
    panel.tabIndex = -1;
    panel.innerHTML =
      '<div class="uisel-search"><i class="fas fa-magnifying-glass"></i>' +
      '<input type="text" placeholder="Поиск…" autocomplete="off" spellcheck="false"></div>' +
      '<div class="uisel-list" role="listbox"></div>' +
      '<div class="uisel-empty" hidden>Ничего не найдено</div>';
    document.body.appendChild(panel);

    var search = panel.querySelector('input');
    var list = panel.querySelector('.uisel-list');
    var empty = panel.querySelector('.uisel-empty');
    var items = [];
    var active = -1;

    // ---------- отрисовка ----------

    function label() {
      var o = sel.options[sel.selectedIndex];
      btn.querySelector('.uisel-val').textContent = (o ? o.textContent.trim() : '') || '—';
      btn.classList.toggle('uisel-placeholder', !sel.value);
      btn.disabled = sel.disabled;
      if (sel.disabled && current && current.btn === btn) close();
    }

    function build() {
      list.innerHTML = '';
      items = [];
      Array.prototype.forEach.call(sel.children, function (node) {
        if (node.tagName === 'OPTGROUP') {
          var head = document.createElement('div');
          head.className = 'uisel-group';
          head.textContent = node.label;
          list.appendChild(head);
          Array.prototype.forEach.call(node.children, function (o) { addOption(o, head); });
        } else if (node.tagName === 'OPTION') {
          addOption(node, null);
        }
      });
      label();
    }

    function addOption(o, group) {
      var el = document.createElement('div');
      el.className = 'uisel-item' + (group ? ' uisel-item-in-group' : '');
      el.setAttribute('role', 'option');
      el.textContent = o.textContent.trim() || '—';
      if (o.disabled) el.classList.add('uisel-disabled');
      // на pointerup, а не на click: до click успевал вклиниться blur и панель мигала
      el.addEventListener('pointerup', function (e) { e.preventDefault(); if (!o.disabled) pick(o); });
      list.appendChild(el);
      items.push({ el: el, opt: o, group: group, hay: norm(o.textContent + ' ' + (group ? group.textContent : '')) });
    }

    function pick(o) {
      var before = sel.value;
      sel.selectedIndex = o.index;
      label();
      close();
      btn.focus();
      // change бросаем сами: код страницы висит именно на нём
      if (sel.value !== before) sel.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // ---------- поиск ----------

    function filter() {
      var q = norm(search.value);
      var shown = 0, seen = [];
      items.forEach(function (it) {
        var ok = !q || it.hay.indexOf(q) !== -1;
        it.el.hidden = !ok;
        it.el.classList.remove('uisel-active');
        if (ok) { shown++; if (it.group && seen.indexOf(it.group) === -1) seen.push(it.group); }
      });
      Array.prototype.forEach.call(list.querySelectorAll('.uisel-group'), function (g) {
        g.hidden = seen.indexOf(g) === -1;      // пустые группы не показываем
      });
      empty.hidden = shown > 0;
      active = -1;
      for (var i = 0; i < items.length; i++) if (!items[i].el.hidden) { setActive(i); break; }
    }

    function setActive(i) {
      if (active >= 0 && items[active]) items[active].el.classList.remove('uisel-active');
      active = i;
      if (i < 0 || !items[i]) { list.removeAttribute('aria-activedescendant'); return; }
      var el = items[i].el;
      el.classList.add('uisel-active');
      if (el.offsetTop < list.scrollTop) list.scrollTop = el.offsetTop;
      else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight) {
        list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight;
      }
    }

    function step(dir) {
      var vis = [];
      items.forEach(function (it, i) { if (!it.el.hidden && !it.opt.disabled) vis.push(i); });
      if (!vis.length) return;
      var at = vis.indexOf(active);
      setActive(vis[at < 0 ? (dir > 0 ? 0 : vis.length - 1) : (at + dir + vis.length) % vis.length]);
    }

    // ---------- положение ----------

    // fromScroll: закрываемся только когда поле УЕХАЛО из окна при прокрутке.
    // При открытии оно может быть за краем просто потому, что до него ещё
    // не долистали, — тогда не закрываем, а подводим к нему.
    function reposition(fromScroll) {
      var r = btn.getBoundingClientRect();
      if (fromScroll && (r.bottom < 0 || r.top > window.innerHeight)) { close(); return; }
      panel.style.width = r.width + 'px';
      panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - r.width - 8)) + 'px';
      var below = window.innerHeight - r.bottom - 12;
      var above = r.top - 12;
      var down = below >= 240 || below >= above;
      panel.style.maxHeight = Math.min(340, Math.max(160, down ? below : above)) + 'px';
      if (down) { panel.style.top = (r.bottom + 6) + 'px'; panel.style.bottom = 'auto'; }
      else { panel.style.top = 'auto'; panel.style.bottom = (window.innerHeight - r.top + 6) + 'px'; }
    }

    // ---------- открыть/закрыть ----------

    function open() {
      if (sel.disabled) return;
      closeCurrent();                      // открытая панель на странице одна
      build();
      search.value = '';
      var many = items.length >= MIN_FOR_SEARCH;
      panel.querySelector('.uisel-search').hidden = !many;
      panel.hidden = false;
      wrap.dataset.open = '1';
      btn.setAttribute('aria-expanded', 'true');
      current = { close: close, reposition: reposition, onKey: onKey, wrap: wrap, panel: panel, btn: btn };
      var box = btn.getBoundingClientRect();
      if (box.top < 8 || box.bottom > window.innerHeight - 8) btn.scrollIntoView({ block: 'center' });
      reposition(false);
      filter();
      for (var i = 0; i < items.length; i++) if (items[i].opt.selected) { setActive(i); break; }
      // preventScroll: иначе фокус прокручивает страницу и панель уезжает
      (many ? search : panel).focus({ preventScroll: true });
    }

    function close() {
      if (panel.hidden) return;
      panel.hidden = true;
      delete wrap.dataset.open;
      btn.setAttribute('aria-expanded', 'false');
      if (current && current.btn === btn) current = null;
      closedAt = Date.now();
    }

    // ---------- события поля ----------

    btn.addEventListener('click', function () {
      // клик снаружи уже закрыл панель — этот же клик не должен открыть её снова
      if (panel.hidden && Date.now() - closedAt > 250) open();
      else close();
    });

    btn.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault(); open();
      } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        open();                                     // начал печатать — открываем и ищем
        search.value = e.key; filter();
      }
    });

    search.addEventListener('input', filter);

    function onKey(e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
      else if (e.key === 'Home') { e.preventDefault(); step(1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (active >= 0 && items[active] && !items[active].el.hidden) pick(items[active].opt);
      } else if (e.key === 'Tab') { close(); }
      else if (!panel.querySelector('.uisel-search').hidden && document.activeElement !== search
               && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        // фокус уехал, а человек продолжает печатать — возвращаем в поиск
        search.focus({ preventScroll: true });
      }
    }

    // ---------- синхронизация с родным select ----------

    sel.addEventListener('change', label);
    new MutationObserver(function () { build(); if (!panel.hidden) filter(); })
      .observe(sel, { childList: true, attributes: true, attributeFilter: ['disabled'] });

    // Страница местами присваивает .value напрямую, без события.
    // Подменяем свойство у этого экземпляра, чтобы подпись не отставала.
    ['value', 'selectedIndex'].forEach(function (prop) {
      var d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
      if (!d || !d.set) return;
      Object.defineProperty(sel, prop, {
        configurable: true,
        get: function () { return d.get.call(this); },
        set: function (v) { d.set.call(this, v); label(); }
      });
    });

    build();
  }

  function enhanceAll(root) {
    var scope = root && root.querySelectorAll ? root : document;
    Array.prototype.forEach.call(scope.querySelectorAll('select'), enhance);
  }

  // Списки появляются и после загрузки — модальные окна, отчёты
  function watch() {
    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        Array.prototype.forEach.call(m.addedNodes, function (n) {
          if (n.nodeType !== 1) return;
          if (n.tagName === 'SELECT') enhance(n);
          else if (n.querySelector && n.querySelector('select')) enhanceAll(n);
        });
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  window.UiSelect = { enhance: enhance, enhanceAll: enhanceAll, closeAll: closeCurrent };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { enhanceAll(document); watch(); });
  } else { enhanceAll(document); watch(); }
})();
