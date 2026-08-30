/* ============================================================
   ui-select.js — поиск и клавиатура в списках выбора.

   Родной <select> остаётся в разметке и остаётся источником правды:
   весь код страницы по-прежнему читает и пишет .value, ловит change
   и перерисовывает options через innerHTML — трогать его не нужно.
   Сверху рисуется кнопка со строкой поиска: 60 операторов глазами
   больше не пролистываем.

   Подключается ДО основного скрипта страницы.
   ============================================================ */
(function () {
  'use strict';

  var MIN_FOR_SEARCH = 8;     // короткие списки строкой поиска не захламляем
  var openOne = null;         // открытый список всегда один

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  }

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

  function enhance(sel) {
    if (!sel || sel.multiple || sel.dataset.uisel || sel.hasAttribute('data-uisel-skip')) return;
    sel.dataset.uisel = 'on';

    var wrap = document.createElement('div');
    wrap.className = 'uisel';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add('uisel-native');

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'uisel-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<span class="uisel-val"></span><i class="fas fa-chevron-down uisel-caret"></i>';
    wrap.appendChild(btn);
    dressLikeNative(btn, sel);

    var panel = document.createElement('div');
    panel.className = 'uisel-panel';
    panel.hidden = true;
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
      var txt = o ? o.textContent.trim() : '';
      btn.querySelector('.uisel-val').textContent = txt || '—';
      btn.classList.toggle('uisel-placeholder', !sel.value);
      btn.disabled = sel.disabled;
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
      el.addEventListener('click', function () {
        if (o.disabled) return;
        pick(o);
      });
      list.appendChild(el);
      items.push({ el: el, opt: o, group: group, hay: norm(o.textContent + ' ' + (group ? group.textContent : '')) });
    }

    function pick(o) {
      var before = sel.value;
      sel.selectedIndex = o.index;
      label();
      close();
      // change бросаем сами: код страницы висит именно на нём
      if (sel.value !== before) sel.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // ---------- поиск ----------

    function filter() {
      var q = norm(search.value);
      var shown = 0;
      var seenGroups = [];
      items.forEach(function (it) {
        var ok = !q || it.hay.indexOf(q) !== -1;
        it.el.hidden = !ok;
        if (ok) { shown++; if (it.group && seenGroups.indexOf(it.group) === -1) seenGroups.push(it.group); }
      });
      Array.prototype.forEach.call(list.querySelectorAll('.uisel-group'), function (g) {
        g.hidden = seenGroups.indexOf(g) === -1;      // пустые группы не показываем
      });
      empty.hidden = shown > 0;
      setActive(items.findIndex(function (it) { return !it.el.hidden; }));
    }

    function setActive(i) {
      items.forEach(function (it) { it.el.classList.remove('uisel-active'); });
      active = i;
      if (i >= 0 && items[i]) {
        items[i].el.classList.add('uisel-active');
        var el = items[i].el, box = list;
        if (el.offsetTop < box.scrollTop) box.scrollTop = el.offsetTop;
        else if (el.offsetTop + el.offsetHeight > box.scrollTop + box.clientHeight) {
          box.scrollTop = el.offsetTop + el.offsetHeight - box.clientHeight;
        }
      }
    }

    function step(dir) {
      var vis = items.map(function (it, i) { return it.el.hidden ? -1 : i; }).filter(function (i) { return i >= 0; });
      if (!vis.length) return;
      var at = vis.indexOf(active);
      setActive(vis[(at + dir + vis.length) % vis.length]);
    }

    // ---------- открыть/закрыть ----------

    function place() {
      var r = btn.getBoundingClientRect();
      panel.style.width = r.width + 'px';
      panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - r.width - 8)) + 'px';
      var below = window.innerHeight - r.bottom - 10;
      var above = r.top - 10;
      var h = Math.min(320, Math.max(below, above));
      panel.style.maxHeight = h + 'px';
      if (below >= Math.min(320, h) || below >= above) {
        panel.style.top = (r.bottom + 6) + 'px';
        panel.style.bottom = 'auto';
      } else {
        panel.style.top = 'auto';
        panel.style.bottom = (window.innerHeight - r.top + 6) + 'px';
      }
    }

    function open() {
      if (sel.disabled) return;
      if (openOne && openOne !== close) openOne();
      openOne = close;
      build();
      search.value = '';
      var many = items.length >= MIN_FOR_SEARCH;
      panel.querySelector('.uisel-search').hidden = !many;
      panel.hidden = false;
      wrap.dataset.open = '1';
      btn.setAttribute('aria-expanded', 'true');
      place();
      filter();
      var cur = items.findIndex(function (it) { return it.opt.selected; });
      if (cur >= 0) setActive(cur);
      if (many) search.focus(); else panel.focus();
    }

    function close() {
      panel.hidden = true;
      delete wrap.dataset.open;
      btn.setAttribute('aria-expanded', 'false');
      if (openOne === close) openOne = null;
    }

    // ---------- события ----------

    btn.addEventListener('click', function () { panel.hidden ? open() : close(); });
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });

    search.addEventListener('input', filter);
    panel.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); if (active >= 0 && !items[active].el.hidden) pick(items[active].opt); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); btn.focus(); }
      else if (e.key === 'Tab') { close(); }
    });
    panel.tabIndex = -1;

    document.addEventListener('mousedown', function (e) {
      if (panel.hidden) return;
      if (!panel.contains(e.target) && !wrap.contains(e.target)) close();
    });
    window.addEventListener('resize', function () { if (!panel.hidden) place(); });
    window.addEventListener('scroll', function () { if (!panel.hidden) place(); }, true);

    // ---------- синхронизация с родным select ----------

    sel.addEventListener('change', label);
    new MutationObserver(function () { build(); }).observe(sel, { childList: true });

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

  // Селекты появляются и после загрузки (модальные окна, отчёты)
  function watch() {
    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        Array.prototype.forEach.call(m.addedNodes, function (n) {
          if (n.nodeType !== 1) return;
          if (n.tagName === 'SELECT') enhance(n);
          else enhanceAll(n);
        });
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  window.UiSelect = { enhance: enhance, enhanceAll: enhanceAll };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { enhanceAll(document); watch(); });
  } else { enhanceAll(document); watch(); }
})();
