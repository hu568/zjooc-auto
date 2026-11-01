// ==UserScript==
// @name         ZJOOC 在浙学 自动刷课助手
// @namespace    https://github.com/local/zjooc-auto
// @version      1.1.2
// @description  在浙学(zjooc.cn)自动刷课：自动播放 / 倍速 / 静音 / 自动下一节 / 图文自动完成 / 弹题自动作答 / 悬浮控制面板
// @author       local
// @match        *://www.zjooc.cn/*
// @match        *://zjooc.cn/*
// @grant        none
// @run-at       document-idle
// @license      MIT
// @noframes
// ==/UserScript==

/*
 * 说明（实现依据）
 * ------------------------------------------------------------------
 * 站点：https://www.zjooc.cn/  学习页路由
 *   /ucenter/student/course/study/:courseId/plan/detail/:chapterId
 *
 * 学习页由 Vue2 + Element-UI 实现（源码见 web/views/ucenter/student/plan/plan-detail.vue
 * 与 plan-detailvideo.vue），其关键结构：
 *   - 左侧 .base-asider：el-menu，一级 = 章(el-submenu)，二级 = 节(el-menu-item)
 *   - 右侧 .plan-detailvideo：el-tabs，每个 tab = 节下面的一个学习单元(chapter)
 *   - 学习页根元素 .plan-detail 上挂有 Vue 实例（__vue__），暴露 list(章节目录)、
 *     thisData([章,节,单元])、detailData(当前节)、initPlan()、fowardDetail()、tabClick()、
 *     finishText() 等方法；因此优先用这些接口驱动，失败再退回 DOM 点击。
 *
 * 单元类型 resourceType：1=视频 2=音频 3=PDF 4=图文；learnStatus 2=已完成 1=未开始
 *
 * 进度上报：站点每 20s 调用 /learningmonitor/api/learning/monitor/videoPlaying
 *   上报 playTime 与 percent(=time/duration*100，>=95 记 100)，故倍速可加速完成。
 *
 * 视频弹题：播放到 timePoint 时站点暂停视频并弹出"答题"对话框，题目数据里自带
 *   rightAnswer，本脚本据此自动作答并恢复播放。
 * ------------------------------------------------------------------
 */

(function () {
  'use strict';

  var VERSION = '1.1.2';
  if (window.__ZJOOC_AUTO__ && window.__ZJOOC_AUTO__.version === VERSION) return;

  // ============================================================
  // 0. 配置与持久化
  // ============================================================
  var STORAGE_KEY = 'zjooc_auto_settings_v1';

  var DEFAULTS = {
    autoStart: true,   // 打开学习页后自动开始
    rate: 2,           // 倍速
    mute: true,        // 静音
    autoNext: true,    // 自动切换下一节
    skipDone: true,    // 跳过已完成
    autoAnswer: true,  // 弹题自动作答
    background: true,  // 后台播放（伪造可见性 / 定期模拟鼠标活动）
    docWait: 8         // 图文/PDF 等待秒数
  };

  var cfg = loadSettings();
  function loadSettings() {
    var out = {};
    for (var k in DEFAULTS) out[k] = DEFAULTS[k];
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        for (var key in DEFAULTS) {
          if (saved && typeof saved[key] !== 'undefined') out[key] = saved[key];
        }
      }
    } catch (e) { /* ignore */ }
    return out;
  }
  function saveSettings() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
  }

  // ============================================================
  // 1. 日志
  // ============================================================
  var logLines = [];
  function log(msg, level) {
    var line = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + msg;
    logLines.push(line);
    if (logLines.length > 60) logLines.shift();
    try {
      if (level === 'error') console.warn('[ZJOOC]', msg);
      else console.log('[ZJOOC]', msg);
    } catch (e) { /* ignore */ }
    renderLog();
  }

  // ============================================================
  // 2. 站点适配层
  // ============================================================
  var STUDY_PATH = /\/ucenter\/student\/course\/study\/([^/]+)\/plan\/detail\/([^/?#]+)/;

  var Site = {
    isStudyPage: function () {
      return STUDY_PATH.test(location.pathname || location.href);
    },
    /** 学习页根 Vue 实例（含章节目录 list） */
    getStudyVM: function () {
      var el = document.querySelector('.plan-detail');
      var vm = el && el.__vue__;
      return (vm && Array.isArray(vm.list)) ? vm : null;
    },
    /** 右侧播放区 Vue 实例（planDetailvideo） */
    getPlayerVM: function () {
      var el = document.querySelector('.plan-detailvideo');
      return (el && el.__vue__) || null;
    },
    currentId: function () {
      var m = (location.pathname || '').match(/\/plan\/detail\/([^/?#]+)/);
      return m ? m[1] : '';
    },
    courseId: function () {
      var m = (location.pathname || '').match(/\/course\/study\/([^/?#]+)\//);
      return m ? m[1] : '';
    },
    /** 扁平化章节目录：[{chapter, section, leaf}] */
    flatten: function (vm) {
      var out = [];
      var chapters = (vm && vm.list) || [];
      for (var i = 0; i < chapters.length; i++) {
        var chapter = chapters[i];
        var sections = chapter.children || [];
        for (var j = 0; j < sections.length; j++) {
          var section = sections[j];
          var leaves = section.children || [];
          for (var k = 0; k < leaves.length; k++) {
            out.push({ chapter: chapter, section: section, leaf: leaves[k] });
          }
        }
      }
      return out;
    },
    /** 当前学习单元 {chapter, section, leaf} */
    currentItem: function (vm) {
      if (!vm) return null;
      var id = Site.currentId();
      var cur = vm.thisData && vm.thisData[2];
      if (cur && cur.id) {
        var list = Site.flatten(vm);
        for (var i = 0; i < list.length; i++) if (list[i].leaf.id === cur.id) return list[i];
      }
      var all = Site.flatten(vm);
      for (var n = 0; n < all.length; n++) if (String(all[n].leaf.id) === String(id)) return all[n];
      return null;
    },
    /** 当前视频元素（只取播放区里的，避免误伤；同源 iframe 也找） */
    video: function () {
      var v = document.querySelector('.plan-detailvideo .contain-video video') ||
              document.querySelector('.plan-detailvideo video') ||
              document.querySelector('video');
      if (v) return v;
      var frames = document.querySelectorAll('.plan-detailvideo iframe, iframe');
      for (var i = 0; i < frames.length; i++) {
        try {
          var doc = frames[i].contentDocument;
          var inner = doc && doc.querySelector('video');
          if (inner) return inner;
        } catch (e) { /* 跨域，忽略 */ }
      }
      return null;
    },
    /** tab 上是否已标记完成 */
    tabCompleted: function () {
      var el = document.querySelector('.plan-detailvideo .el-tabs__nav .el-tabs__item.is-active i.complete');
      return !!el;
    },
    /** 点击播放区中央的暂停层（CKPlayer 的大的暂停按钮） */
    clickCenter: function () {
      var layer = document.querySelector('.plan-detailvideo [class*="pausecenter"]') ||
                  document.querySelector('[class*="pausecenter"]');
      if (layer) { try { layer.click(); return true; } catch (e) { /* ignore */ } }
      return false;
    }
  };

  // ============================================================
  // 3. 媒体控制
  // ============================================================
  function applyMedia(video, tryPlay) {
    if (!video) return;
    try {
      if (cfg.mute && !video.muted) video.muted = true;
      if (!cfg.mute && video.muted) video.muted = false;
    } catch (e) { /* ignore */ }
    try {
      var rate = Number(cfg.rate) || 1;
      if (Math.abs((video.playbackRate || 1) - rate) > 0.01) video.playbackRate = rate;
    } catch (e) { /* ignore */ }
    if (tryPlay) tryPlayVideo(video);
  }

  function tryPlayVideo(video) {
    if (!video || video.ended) return;
    if (!video.paused) return;
    var p;
    try { p = video.play(); } catch (e) { p = null; }
    if (p && typeof p.catch === 'function') {
      p.catch(function () {
        Site.clickCenter();
        setTimeout(function () {
          try { video.play(); } catch (e) { /* ignore */ }
        }, 700);
      });
    }
  }

  // ============================================================
  // 4. 弹题（视频中弹出的"答题"对话框）
  // ============================================================
  function findQuizDialog() {
    var list = document.querySelectorAll('.el-dialog__wrapper');
    for (var i = 0; i < list.length; i++) {
      var w = list[i];
      if (!w || w.style.display === 'none') continue;
      var title = w.querySelector('.el-dialog__title');
      if (!title) continue;
      if (title.textContent.replace(/\s+/g, '') !== '答题') continue;
      var visible = true;
      try { visible = getComputedStyle(w).display !== 'none'; } catch (e) { /* ignore */ }
      if (visible) return w;
    }
    return null;
  }

  function findQuizVM(el) {
    var vm = el && el.__vue__;
    var depth = 0;
    while (vm && depth++ < 8) {
      if (vm.doTaskContent && typeof vm.handleSubmit === 'function') return vm;
      vm = vm.$parent;
    }
    return null;
  }

  /** 返回 true 表示"当前有弹题，已处理/正在处理"，主循环应让路 */
  function handleQuiz() {
    var dialog = findQuizDialog();
    if (!dialog) { S.quizKey = ''; return false; }
    if (!cfg.autoAnswer) { setStatus('检测到弹题（自动答题已关闭）'); return true; }

    var vm = findQuizVM(dialog);
    var content = (vm && vm.doTaskContent) || null;
    var playerVM = Site.getPlayerVM();
    if (!content && playerVM && playerVM.doTaskContent) content = playerVM.doTaskContent;

    if (!content) { setStatus('检测到弹题，但读取不到题目数据'); return true; }

    var key = String(content.name || '') + '::' + String(content.rightAnswer || '');
    if (S.quizKey !== key) { S.quizKey = key; S.quizTries = 0; }
    if (S.quizTries >= 4) { setStatus('弹题自动作答失败，请手动作答'); return true; }

    var right = content.rightAnswer;
    if (right === null || typeof right === 'undefined' || right === '') {
      // 没有答案时：点第一个选项再确定，尽量不卡住
      var opt = dialog.querySelector('.el-radio, .el-checkbox');
      if (opt) { try { opt.click(); } catch (e) { /* ignore */ } }
      var btn0 = dialog.querySelector('.dialog-footer .el-button, .el-dialog__footer .el-button');
      if (btn0) { S.quizTries++; try { btn0.click(); } catch (e) { /* ignore */ } }
      setStatus('弹题缺少答案，已尝试默认选项');
      return true;
    }

    try {
      if (vm) {
        if (Number(content.type) === 2) {
          vm.$set(content, 'answer', String(right).split(',').map(function (s) { return String(s).trim(); }).filter(Boolean));
        } else {
          vm.$set(content, 'answer', String(right));
        }
        vm.handleSubmit();
      } else {
        // 兜底：直接改 props 对象（父子共享同一引用），再点确定
        content.answer = Number(content.type) === 2
          ? String(right).split(',').map(function (s) { return String(s).trim(); }).filter(Boolean)
          : String(right);
        var btn = dialog.querySelector('.dialog-footer .el-button, .el-dialog__footer .el-button');
        if (btn) btn.click();
      }
      S.quizTries++;
      log('弹题已自动作答：' + (content.name || ''));
      setStatus('弹题自动作答中…');
    } catch (e) {
      log('自动答题失败：' + (e && e.message), 'error');
    }
    return true;
  }

  // ============================================================
  // 5. 导航
  // ============================================================
  /** 面包屑文本（无 Vue 时的兜底展示） */
  function breadcrumbText() {
    var lis = document.querySelectorAll('.plan-detail > .el-header > ul > li');
    var arr = [];
    for (var i = 0; i < lis.length; i++) {
      var t = (lis[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (t) arr.push(t);
    }
    return arr.join(' > ');
  }

  /** 当前学习单元；Vue 不可用时用路由 + DOM 推断一个伪对象 */
  function currentInfo(vm) {
    var item = Site.currentItem(vm);
    if (item) return item;
    var id = Site.currentId();
    if (!id) return null;
    var type = Site.video() ? 1 : 4;
    return {
      chapter: null,
      section: null,
      leaf: { id: id, name: breadcrumbText() || ('章节 ' + id), resourceType: type, learnStatus: 0 }
    };
  }

  function nameOf(item) {
    if (!item) return '';
    var leaf = item.leaf || {};
    var section = item.section || {};
    var chapter = item.chapter || {};
    return [chapter.name, section.name, leaf.name].filter(Boolean).join(' > ');
  }

  function isDone(item) {
    if (!item || !item.leaf) return true;
    if (S.doneIds[item.leaf.id]) return true;
    if (cfg.skipDone && Number(item.leaf.learnStatus) === 2) return true;
    return false;
  }

  /** 用站点 Vue 接口跳转到目标单元，失败返回 false */
  function gotoViaVue(vm, from, target) {
    if (!vm || !target || !target.leaf) return false;
    var sameSection = from && from.section && target.section === from.section;
    var targetId = target.leaf.id;

    if (sameSection && typeof vm.tabClick === 'function') {
      try {
        vm.tabClick({ name: targetId });
        return true;
      } catch (e) { log('tabClick 跳转失败：' + (e && e.message), 'error'); }
    }

    if (typeof vm.fowardDetail === 'function') {
      try {
        vm.fowardDetail(target.section);
        return true;
      } catch (e) { log('fowardDetail 跳转失败：' + (e && e.message), 'error'); }
    }

    if (typeof vm.$router === 'object' && vm.$router && typeof vm.$router.push === 'function') {
      try {
        vm.$router.push('/ucenter/student/course/study/' + Site.courseId() + '/plan/detail/' + targetId);
        if (typeof vm.initPlan === 'function') vm.initPlan(targetId);
        return true;
      } catch (e) { log('router 跳转失败：' + (e && e.message), 'error'); }
    }
    return false;
  }

  /** DOM 兜底：点下一个 tab / 下一节 / 下一章 */
  function gotoViaDom() {
    // 1) 同一节内的下一个 tab
    var nav = document.querySelector('.plan-detailvideo .el-tabs__nav');
    if (nav) {
      var tabs = [].slice.call(nav.querySelectorAll('.el-tabs__item'));
      var active = nav.querySelector('.el-tabs__item.is-active');
      if (active) {
        var idx = tabs.indexOf(active);
        for (var i = idx + 1; i < tabs.length; i++) {
          var t = tabs[i];
          if (cfg.skipDone && t.querySelector('i.complete')) continue;
          try { t.click(); return true; } catch (e) { /* ignore */ }
        }
      }
    }
    // 2) 同章下一节
    var activeItem = document.querySelector('.base-asider .el-submenu.is-active .el-menu-item.is-active');
    if (activeItem) {
      var nx = activeItem.nextElementSibling;
      while (nx && nx.className && String(nx.className).indexOf('el-menu-item') === -1) nx = nx.nextElementSibling;
      if (nx) { try { nx.click(); return true; } catch (e) { /* ignore */ } }
    }
    // 3) 下一章第一节
    var activeSub = document.querySelector('.base-asider .el-submenu.is-active');
    if (activeSub) {
      var ns = activeSub.nextElementSibling;
      while (ns && ns.className && String(ns.className).indexOf('el-submenu') === -1) ns = ns.nextElementSibling;
      if (ns) {
        var first = ns.querySelector('.el-menu-item');
        if (first) { try { first.click(); return true; } catch (e) { /* ignore */ } }
      }
    }
    return false;
  }

  // ============================================================
  // 6. 状态机
  // ============================================================
  var S = {
    running: false,
    phase: 'IDLE',        // IDLE | PLAY | DOC | NAV | DONE | FINISHED
    leafId: '',
    targetId: '',
    navAt: 0,
    navCorrected: false,
    docAt: 0,
    docClicked: false,
    lastTime: -1,
    lastTimeAt: 0,
    tailAt: 0,
    waitVideoAt: 0,
    pausedAt: 0,
    doneIds: {},
    quizKey: '',
    quizTries: 0,
    status: '待开始'
  };

  function setPhase(p) {
    S.phase = p;
    if (p !== 'NAV') { S.targetId = ''; S.navCorrected = false; }
  }

  function setStatus(t) {
    S.status = t;
    renderStatus();
  }

  function onLeafChanged(curId) {
    S.leafId = curId;
    S.docClicked = false;
    S.docAt = 0;
    S.lastTime = -1;
    S.lastTimeAt = Date.now();
    S.tailAt = 0;
    S.waitVideoAt = 0;
    S.pausedAt = 0;
    if (S.phase !== 'NAV') setPhase('IDLE');
    renderCourse();
  }

  function tick() {
    if (!S.running) return;
    try {
      if (!Site.isStudyPage()) { setStatus('请进入课程学习页（章节学习）'); return; }
      var vm = Site.getStudyVM();
      if (!vm && !document.querySelector('.plan-detail')) {
        // 学习页还没渲染出来
        setStatus('等待学习页数据…');
        return;
      }

      if (handleQuiz()) return;

      var curId = Site.currentId();
      if (!curId) { setStatus('等待路由…'); return; }
      if (curId !== S.leafId) onLeafChanged(curId);

      switch (S.phase) {
        case 'NAV':    return stepNav(vm, curId);
        case 'PLAY':   return stepPlay(vm, curId);
        case 'DOC':    return stepDoc(vm, curId);
        case 'DONE':   return stepNext(vm);
        case 'FINISHED': return;
        case 'STUCK':    return;
        default:       return stepIdle(vm, curId);
      }
    } catch (e) {
      log('主循环异常：' + ((e && e.message) || e), 'error');
    }
  }

  function stepIdle(vm, curId) {
    var item = currentInfo(vm);
    if (!item) { setStatus('未找到当前章节信息…'); return; }

    if (S.doneIds[item.leaf.id]) {
      log('本单元本次已学过，继续下一节：' + nameOf(item));
      setPhase('DONE');
      return;
    }
    if (cfg.skipDone && Number(item.leaf.learnStatus) === 2) {
      log('跳过已完成：' + nameOf(item));
      setPhase('DONE');
      return;
    }
    // 站点 tab 上已带完成标记（Vue 数据拿不到时的兜底）
    if (cfg.skipDone && Site.tabCompleted()) {
      log('跳过已完成（tab 标记）：' + nameOf(item));
      setPhase('DONE');
      return;
    }

    renderCourse();

    var type = Number(item.leaf.resourceType);
    if (!type) type = Site.video() ? 1 : 4;
    if (type === 1) {
      var video = Site.video();
      if (!video) {
        var t0 = Date.now();
        if (!S.waitVideoAt) S.waitVideoAt = t0;
        if (t0 - S.waitVideoAt > 25000) {
          setPhase('STUCK');
          setStatus('未找到视频播放器，已暂停（请手动处理或点"下一节"）');
          log('未找到视频元素，可能为第三方播放器/iframe，已停止本页自动化', 'error');
          return;
        }
        setStatus('等待视频加载…');
        return;
      }
      S.waitVideoAt = 0;
      applyMedia(video, true);
      S.lastTime = Math.floor(video.currentTime || 0);
      S.lastTimeAt = Date.now();
      setPhase('PLAY');
      setStatus('播放中 · ' + cfg.rate + 'x');
      log('开始学习：' + nameOf(item));
      return;
    }

    // 音频 / PDF / 图文
    S.docAt = Date.now();
    S.docClicked = false;
    setPhase('DOC');
    setStatus('图文/音视频资料章节，准备完成…');
    log('进入非视频章节：' + nameOf(item) + '（类型 ' + type + '）');
  }

  function stepPlay(vm, curId) {
    var video = Site.video();
    if (!video) {
      setStatus('视频元素消失，重新检测…');
      setPhase('IDLE');
      return;
    }
    applyMedia(video, true);

    if (video.ended) { finishCurrent(vm, '播放结束'); return; }

    var now0 = Date.now();
    var dur = video.duration;
    var durOk = isFinite(dur) && dur > 0;

    // 兜底：视频自己停住了（站点暂停在片尾 / duration 不可用），且已接近末尾
    if (video.paused && video.currentTime > 0) {
      if (!S.pausedAt) S.pausedAt = now0;
      else if (now0 - S.pausedAt > 20000) {
        if (durOk && video.currentTime >= dur * 0.97) { finishCurrent(vm, '站点暂停在片尾'); return; }
        if (!durOk && Site.tabCompleted()) { finishCurrent(vm, '已标记完成'); return; }
        S.pausedAt = 0;
      }
    } else {
      S.pausedAt = 0;
    }

    if (durOk && video.currentTime >= dur - 1) {
      // 到片尾但还没触发 ended：等站点把 100% 上报完（最多 20s）
      if (!S.tailAt) S.tailAt = now0;
      if (now0 - S.tailAt > 20000) { finishCurrent(vm, '片尾未触发结束事件'); return; }
      setStatus('片尾等待上报 100%…');
      return;
    }
    S.tailAt = 0;

    if (Site.tabCompleted()) { finishCurrent(vm, '站点已标记完成'); return; }

    // 播放停滞检测
    var now = Date.now();
    var t = Math.floor(video.currentTime || 0);
    if (t !== S.lastTime) {
      S.lastTime = t;
      S.lastTimeAt = now;
    } else if (now - S.lastTimeAt > 15000) {
      log('检测到播放停滞，尝试恢复…');
      try { video.play(); } catch (e) { /* ignore */ }
      if (video.paused) Site.clickCenter();
      S.lastTimeAt = now;
    }

    var pct = dur > 0 ? Math.floor((video.currentTime / dur) * 100) : 0;
    setStatus('播放中 ' + cfg.rate + 'x · ' + (isFinite(pct) ? pct : 0) + '%' +
      (video.paused ? '（已暂停，尝试恢复）' : ''));
    renderCourse();
  }

  function stepDoc(vm, curId) {
    if (Site.video()) { setPhase('IDLE'); return; }
    var elapsed = Date.now() - S.docAt;

    if (!S.docClicked) {
      S.docClicked = true;
      var ok = false;
      if (vm && typeof vm.finishText === 'function') {
        try { vm.finishText(); ok = true; } catch (e) { /* ignore */ }
      }
      if (!ok) {
        var btn = document.querySelector('.plan-detailvideo .contain-bottom .el-button');
        if (btn && !btn.disabled) { try { btn.click(); ok = true; } catch (e) { /* ignore */ } }
      }
      log(ok ? '已点击"完成学习"' : '未找到"完成学习"按钮，等待后跳过');
    }

    var waitMs = Math.max(2, Number(cfg.docWait) || 8) * 1000;
    if (elapsed >= waitMs) { finishCurrent(vm, '资料章节完成'); return; }
    setStatus('资料章节等待 ' + Math.ceil((waitMs - elapsed) / 1000) + 's');
  }

  function finishCurrent(vm, reason) {
    var item = currentInfo(vm);
    var id = item && item.leaf && item.leaf.id;
    if (id) S.doneIds[id] = true;
    log('完成：' + (item ? nameOf(item) : S.leafId) + '（' + reason + '）');
    setStatus('已完成，准备下一节…');
    setPhase('DONE');
  }

  function stepNext(vm) {
    if (!cfg.autoNext) { setStatus('已暂停自动跳转（请手动切换）'); setPhase('IDLE'); return; }

    // 没有 Vue 实例时只能靠 DOM 顺序点击
    if (!vm) {
      if (gotoViaDom()) {
        setPhase('NAV');
        S.targetId = '';
        S.navAt = Date.now();
        S.navCorrected = false;
        setStatus('跳转中…');
        return;
      }
      finishAll();
      return;
    }

    var list = Site.flatten(vm);
    var curId = Site.currentId();
    var idx = -1;
    for (var i = 0; i < list.length; i++) { if (String(list[i].leaf.id) === String(curId)) { idx = i; break; } }
    if (idx < 0) {
      log('目录里找不到当前章节（list=' + list.length + ' 项，route=' + curId + '），改用页面点击', 'error');
      if (gotoViaDom()) {
        setPhase('NAV');
        S.targetId = '';
        S.navAt = Date.now();
        S.navCorrected = false;
        S.docClicked = false;
        setStatus('跳转中…');
      } else {
        log('页面点击也找不到可跳转的下一节，停止', 'error');
        finishAll();
      }
      return;
    }

    var target = null;
    for (var j = idx + 1; j < list.length; j++) {
      if (!isDone(list[j])) { target = list[j]; break; }
    }

    if (!target) { finishAll(); return; }

    var from = list[idx];
    log('跳转 → ' + nameOf(target));
    var ok = gotoViaVue(vm, from, target);
    if (!ok) {
      log('站点接口跳转不可用，改用页面点击');
      ok = gotoViaDom();
    }
    if (!ok) {
      log('已无更多可跳转的章节', 'error');
      finishAll();
      return;
    }
    setPhase('NAV');
    S.targetId = target.leaf.id;
    S.navAt = Date.now();
    S.navCorrected = false;
    S.docClicked = false;
    setStatus('跳转中…');
  }

  function stepNav(vm, curId) {
    var elapsed = Date.now() - S.navAt;

    if (!S.targetId) {
      // DOM 模式：只能等页面自己切过去
      if (elapsed > 2500) { setStatus('已切换，准备开始…'); setPhase('IDLE'); }
      else setStatus('跳转中…');
      return;
    }

    if (String(curId) === String(S.targetId)) {
      setStatus('已切换，准备开始…');
      setPhase('IDLE');
      return;
    }

    // 跨章跳转站点会落在该节第一个单元，这里再纠正到目标 tab
    if (!S.navCorrected && S.targetId && elapsed > 3500 && vm && typeof vm.tabClick === 'function') {
      S.navCorrected = true;
      try { vm.tabClick({ name: S.targetId }); } catch (e) { /* ignore */ }
      S.navAt = Date.now();
      return;
    }

    if (elapsed > 6000) {
      if (!S.navCorrected) {
        S.navCorrected = true;
        if (!gotoViaDom()) { log('跳转超时，等待人工处理', 'error'); }
        S.navAt = Date.now();
        return;
      }
      setStatus('跳转超时，回到检测');
      setPhase('IDLE');
      return;
    }
    setStatus('跳转中…');
  }

  function finishAll() {
    setPhase('FINISHED');
    S.running = false;
    setStatus('🎉 全部章节已完成');
    log('全部章节已完成 🎉', 'error');
    try { alert('ZJOOC 自动刷课：本次课程全部章节已完成！'); } catch (e) { /* ignore */ }
    renderControls();
  }

  // ============================================================
  // 6.5 诊断快照（卡住时点面板「诊断」一键复制）
  // ============================================================
  function diagnose() {
    var vm = null, pv = null, list = [];
    try { vm = Site.getStudyVM(); } catch (e) { /* ignore */ }
    try { pv = Site.getPlayerVM(); } catch (e) { /* ignore */ }
    try { list = vm ? Site.flatten(vm) : []; } catch (e) { list = []; }
    var item = null;
    try { item = vm ? Site.currentItem(vm) : null; } catch (e) { /* ignore */ }
    var v = Site.video();
    var tabs = document.querySelectorAll('.plan-detailvideo .el-tabs__nav .el-tabs__item');
    var activeTab = document.querySelector('.plan-detailvideo .el-tabs__nav .el-tabs__item.is-active');
    var leaf = item && item.leaf ? item.leaf : null;
    var curId = Site.currentId();
    var curIndex = -1;
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].leaf.id) === String(curId)) { curIndex = i; break; }
    }
    return {
      version: VERSION,
      url: location.pathname,
      time: new Date().toLocaleString('zh-CN'),
      running: S.running,
      phase: S.phase,
      status: S.status,
      leafId: S.leafId,
      targetId: S.targetId,
      navAt: S.navAt,
      navCorrected: S.navCorrected,
      doneIds: Object.keys(S.doneIds),
      hasStudyVM: !!vm,
      hasPlayerVM: !!pv,
      listLen: list.length,
      curIndex: curIndex,
      routeId: curId,
      thisData: (vm && vm.thisData) ? vm.thisData.map(function (x) { return x && (x.name || x.id); }) : null,
      leaf: leaf ? { id: leaf.id, name: leaf.name, resourceType: leaf.resourceType, learnStatus: leaf.learnStatus } : null,
      video: v ? {
        paused: v.paused, ended: v.ended, currentTime: v.currentTime, duration: v.duration,
        rate: v.playbackRate, muted: v.muted, readyState: v.readyState
      } : null,
      tabs: tabs.length,
      activeTabText: activeTab ? (activeTab.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) : null,
      activeTabComplete: !!(activeTab && activeTab.querySelector('i.complete')),
      logs: logLines.slice(-40)
    };
  }

  function copyDiagnose() {
    var data;
    try { data = diagnose(); } catch (e) { data = { error: String(e) }; }
    var text = '===== ZJOOC 诊断 =====\n' + JSON.stringify(data, null, 2);
    try { console.log(text); } catch (e) { /* ignore */ }
    var done = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        done = true;
      }
    } catch (e) { /* ignore */ }
    if (!done) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        done = true;
      } catch (e) { /* ignore */ }
    }
    setStatus(done ? '诊断信息已复制到剪贴板' : '诊断信息已打印到控制台');
    return data;
  }

  // ============================================================
  // 7. 防检测 / 后台播放
  // ============================================================
  var antiDetectInstalled = false;
  function installAntiDetect() {
    if (antiDetectInstalled) return;
    antiDetectInstalled = true;
    try {
      Object.defineProperty(document, 'hidden', { configurable: true, get: function () { return false; } });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: function () { return 'visible'; } });
      Object.defineProperty(document, 'webkitHidden', { configurable: true, get: function () { return false; } });
    } catch (e) { /* ignore */ }

    try {
      document.addEventListener('visibilitychange', function (ev) { ev.stopImmediatePropagation(); }, true);
    } catch (e) { /* ignore */ }

    setInterval(function () {
      if (!cfg.background) return;
      try {
        var ev = new MouseEvent('mousemove', { bubbles: true, clientX: 100 + Math.random() * 200, clientY: 100 + Math.random() * 200 });
        document.body.dispatchEvent(ev);
        document.documentElement.dispatchEvent(ev);
      } catch (e) { /* ignore */ }
    }, 30000);
  }

  // ============================================================
  // 8. 控制面板（Shadow DOM，避免站点样式干扰）
  // ============================================================
  var ui = { host: null, shadow: null, status: null, course: null, logBox: null,
             btnToggle: null, selRate: null, cbMute: null, cbNext: null, cbSkip: null,
             cbAnswer: null, cbBg: null };

  var PANEL_CSS = ''
    + ':host{all:initial}'
    + '.wrap{position:fixed;right:16px;bottom:16px;z-index:2147483000;font:12px/1.6 "Microsoft YaHei",system-ui,sans-serif;color:#e6edf3;width:266px;'
    + 'background:#1f2430;border:1px solid #3a4152;border-radius:10px;box-shadow:0 8px 26px rgba(0,0,0,.45);overflow:hidden;user-select:none}'
    + '.hd{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:linear-gradient(90deg,#2d6cdf,#3f8cff);cursor:move}'
    + '.hd .t{font-weight:700;font-size:12px;letter-spacing:.3px}'
    + '.hd .v{opacity:.75;margin-left:6px;font-weight:400}'
    + '.hd .c{cursor:pointer;padding:0 4px;font-size:14px;opacity:.9}'
    + '.bd{padding:10px}'
    + '.st{padding:6px 8px;background:#12161f;border:1px solid #2d3444;border-radius:6px;margin-bottom:8px}'
    + '.st b{color:#5cc8ff;font-weight:600}'
    + '.row{display:flex;align-items:center;justify-content:space-between;margin:5px 0}'
    + '.row label{cursor:pointer;display:flex;align-items:center;gap:6px}'
    + 'select,button{font:inherit;color:#e6edf3}'
    + 'select{background:#12161f;border:1px solid #39415a;border-radius:5px;padding:2px 4px}'
    + 'button{background:#2d6cdf;border:0;border-radius:5px;padding:5px 12px;cursor:pointer}'
    + 'button:hover{background:#3f8cff}'
    + 'button.ghost{background:#2a3040;border:1px solid #3a4152}'
    + 'button.ghost:hover{background:#353d52}'
    + '.btns{display:flex;gap:6px;margin:8px 0 6px}'
    + '.btns button{flex:1}'
    + '.log{margin-top:8px;background:#0d1117;border:1px solid #2d3444;border-radius:6px;padding:6px;height:96px;overflow:auto;font-family:Consolas,monospace;font-size:11px;color:#9fb0c5;white-space:pre-wrap;word-break:break-all}'
    + '.log div{opacity:.9}'
    + '.log div.err{color:#ff9e9e}'
    + '.mini{opacity:.6;font-size:11px}'
    + '.collapsed .bd{display:none}';

  function buildPanel() {
    if (ui.host) return;

    var host = document.createElement('div');
    host.id = 'zjooc-auto-host';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483000;';
    var shadow = host.attachShadow({ mode: 'open' });

    var html = ''
      + '<style>' + PANEL_CSS + '</style>'
      + '<div class="wrap" id="wrap">'
      + '  <div class="hd" id="hd">'
      + '    <div><span class="t">ZJOOC 刷课助手</span><span class="v">v' + VERSION + '</span></div>'
      + '    <div class="c" id="collapse">—</div>'
      + '  </div>'
      + '  <div class="bd">'
      + '    <div class="st"><b id="status">待开始</b><div id="course" class="mini"></div></div>'
      + '    <div class="row"><span>倍速</span><select id="rate">'
      + '      <option value="1">1x</option><option value="1.25">1.25x</option>'
      + '      <option value="1.5">1.5x</option><option value="2">2x</option>'
      + '      <option value="3">3x</option><option value="4">4x</option>'
      + '    </select></div>'
      + '    <div class="row"><label><input type="checkbox" id="mute"> 静音</label>'
      + '      <label><input type="checkbox" id="next"> 自动切换</label></div>'
      + '    <div class="row"><label><input type="checkbox" id="skip"> 跳过已完成</label>'
      + '      <label><input type="checkbox" id="answer"> 自动答题</label></div>'
      + '    <div class="row"><label><input type="checkbox" id="bg"> 后台播放</label></div>'
      + '    <div class="btns">'
      + '      <button id="toggle">开始</button>'
      + '      <button id="skipNow" class="ghost">下一节</button>'
      + '      <button id="diag" class="ghost">诊断</button>'
      + '    </div>'
      + '    <div class="log" id="log"></div>'
      + '  </div>'
      + '</div>';

    shadow.innerHTML = html;
    document.documentElement.appendChild(host);

    ui.host = host;
    ui.shadow = shadow;
    ui.status = shadow.getElementById('status');
    ui.course = shadow.getElementById('course');
    ui.logBox = shadow.getElementById('log');
    ui.btnToggle = shadow.getElementById('toggle');
    ui.selRate = shadow.getElementById('rate');
    ui.cbMute = shadow.getElementById('mute');
    ui.cbNext = shadow.getElementById('next');
    ui.cbSkip = shadow.getElementById('skip');
    ui.cbAnswer = shadow.getElementById('answer');
    ui.cbBg = shadow.getElementById('bg');

    // 初始值
    ui.selRate.value = String(cfg.rate);
    ui.cbMute.checked = !!cfg.mute;
    ui.cbNext.checked = !!cfg.autoNext;
    ui.cbSkip.checked = !!cfg.skipDone;
    ui.cbAnswer.checked = !!cfg.autoAnswer;
    ui.cbBg.checked = !!cfg.background;

    ui.selRate.addEventListener('change', function () {
      cfg.rate = Number(ui.selRate.value) || 1;
      saveSettings();
      var v = Site.video();
      if (v) applyMedia(v, false);
      setStatus('倍速已设为 ' + cfg.rate + 'x');
    });
    ui.cbMute.addEventListener('change', function () {
      cfg.mute = !!ui.cbMute.checked; saveSettings();
      var v = Site.video(); if (v) applyMedia(v, false);
    });
    ui.cbNext.addEventListener('change', function () { cfg.autoNext = !!ui.cbNext.checked; saveSettings(); });
    ui.cbSkip.addEventListener('change', function () { cfg.skipDone = !!ui.cbSkip.checked; saveSettings(); });
    ui.cbAnswer.addEventListener('change', function () { cfg.autoAnswer = !!ui.cbAnswer.checked; saveSettings(); });
    ui.cbBg.addEventListener('change', function () {
      cfg.background = !!ui.cbBg.checked; saveSettings();
      if (cfg.background) installAntiDetect();
    });

    ui.btnToggle.addEventListener('click', function () {
      if (S.running) stopRun(); else startRun();
    });
    shadow.getElementById('skipNow').addEventListener('click', function () {
      var vm = Site.getStudyVM();
      if (!S.running) { setStatus('请先点击开始'); return; }
      log('手动跳过当前章节');
      S.phase = 'DONE';
      stepNext(vm || Site.getStudyVM());
    });
    shadow.getElementById('diag').addEventListener('click', function () {
      copyDiagnose();
    });
    shadow.getElementById('collapse').addEventListener('click', function () {
      var wrap = shadow.getElementById('wrap');
      wrap.classList.toggle('collapsed');
      this.textContent = wrap.classList.contains('collapsed') ? '□' : '—';
    });

    // 拖动
    (function makeDraggable() {
      var hd = shadow.getElementById('hd');
      var wrap = shadow.getElementById('wrap');
      var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
      hd.addEventListener('mousedown', function (e) {
        if (e.target && e.target.id === 'collapse') return;
        dragging = true;
        var r = wrap.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
        wrap.style.left = r.left + 'px';
        wrap.style.top = r.top + 'px';
        wrap.style.right = 'auto';
        wrap.style.bottom = 'auto';
        e.preventDefault();
      });
      window.addEventListener('mousemove', function (e) {
        if (!dragging) return;
        wrap.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
        wrap.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
      });
      window.addEventListener('mouseup', function () { dragging = false; });
    })();

    renderControls();
    renderStatus();
    renderLog();
  }

  function renderControls() {
    if (!ui.btnToggle) return;
    ui.btnToggle.textContent = S.running ? '暂停' : '开始';
    ui.btnToggle.style.background = S.running ? '#c0392b' : '#2d6cdf';
  }

  function renderStatus() {
    if (!ui.status) return;
    ui.status.textContent = S.status;
  }

  function renderCourse() {
    if (!ui.course) return;
    try {
      var vm = Site.getStudyVM();
      if (!vm) {
        ui.course.textContent = breadcrumbText() || '未进入学习页';
        return;
      }
      var item = Site.currentItem(vm);
      var list = Site.flatten(vm);
      var done = 0;
      for (var i = 0; i < list.length; i++) {
        if (Number(list[i].leaf.learnStatus) === 2 || S.doneIds[list[i].leaf.id]) done++;
      }
      ui.course.textContent = (item ? nameOf(item) : '') + ' · 完成 ' + done + '/' + list.length;
    } catch (e) { /* ignore */ }
  }

  function renderLog() {
    if (!ui.logBox) return;
    var html = '';
    for (var i = 0; i < logLines.length; i++) {
      html += '<div>' + escapeHtml(logLines[i]) + '</div>';
    }
    ui.logBox.innerHTML = html;
    ui.logBox.scrollTop = ui.logBox.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ============================================================
  // 9. 启动 / 停止
  // ============================================================
  var timer = null;

  function startRun() {
    if (!Site.isStudyPage()) { setStatus('请先进入课程学习页'); return; }
    S.running = true;
    S.phase = 'IDLE';
    S.leafId = '';
    S.doneIds = {};
    setStatus('已启动，正在检测…');
    log('开始运行 v' + VERSION);
    renderControls();
    if (!timer) timer = setInterval(tick, 1000);
    tick();
  }

  function stopRun() {
    S.running = false;
    setPhase('IDLE');
    setStatus('已暂停');
    log('已暂停');
    renderControls();
  }

  function boot() {
    buildPanel();
    if (cfg.background) installAntiDetect();
    log('ZJOOC 刷课助手 v' + VERSION + ' 已加载');
    // 站点是 SPA，路由切换不会重新加载脚本，这里持续监听路径变化
    var lastPath = location.pathname;
    var wasStudy = Site.isStudyPage();
    setInterval(function () {
      if (location.pathname === lastPath) return;
      lastPath = location.pathname;
      var nowStudy = Site.isStudyPage();
      if (nowStudy) {
        setStatus('检测到页面切换…');
        renderCourse();
        if (!wasStudy && cfg.autoStart && !S.running) {
          log('进入学习页，自动开始');
          startRun();
        }
      }
      wasStudy = nowStudy;
    }, 800);

    if (cfg.autoStart) {
      setTimeout(function () {
        if (!S.running && Site.isStudyPage()) startRun();
      }, 3000);
    }
  }

  window.__ZJOOC_AUTO__ = {
    version: VERSION, start: startRun, stop: stopRun, state: S, config: cfg,
    diag: diagnose, copyDiag: copyDiagnose
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
