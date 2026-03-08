// ==UserScript==
// @name         雨课堂刷课助手
// @namespace    http://tampermonkey.net/
// @version      3.1.1
// @description  针对雨课堂视频进行自动播放，配置AI自动答题
// @author       风之子
// @license      GPL3
// @match        *://*.yuketang.cn/*
// @match        *://*.gdufemooc.cn/*
// @run-at       document-start
// @icon         http://yuketang.cn/favicon.ico
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      api.openai.com
// @connect      api.moonshot.cn
// @connect      api.deepseek.com
// @connect      dashscope.aliyuncs.com
// @connect      cdn.jsdelivr.net
// @connect      unpkg.com
// @require      https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
// @require      https://unpkg.com/tesseract.js@v2.1.0/dist/tesseract.min.js
// ==/UserScript==

(() => {
  'use strict';

  let panel; // UI 面板代理

  // ---- 脚本配置，用户可修改 ----
  const Config = {
    version: '3.1.1',     // 版本号
    playbackRate: 2,      // 视频播放倍速
    pptInterval: 3000,    // ppt翻页间隔
    storageKeys: {        // 使用者勿动
      progress: '[雨课堂脚本]刷课进度信息',
      ai: 'ykt_ai_conf',
      proClassCount: 'pro_lms_classCount',
      feature: 'ykt_feature_conf',
      runtime: 'ykt_runtime_state' // 当前标签页的续跑状态
    }
  };

  const Utils = {
    // 短暂睡眠，等待网页加载
    sleep: (ms = 1000) => new Promise(resolve => setTimeout(resolve, ms)),
    // 将一个 JSON 字符串解析为 JavaScript 对象
    safeJSONParse(value, fallback) {
      try {
        return JSON.parse(value);
      } catch (_) {
        return fallback;
      }
    },
    normalizeText(text = '') {
      return String(text).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    },
    hasValue(value) {
      return value !== null && typeof value !== 'undefined' && value !== '';
    },
    htmlToText(html = '') {
      const div = document.createElement('div');
      div.innerHTML = html;
      return this.normalizeText(div.textContent || div.innerText || '');
    },
    // 每隔一段时间检查某个条件是否满足（通过 checker 函数），如果满足就成功返回；如果超时仍未满足，就失败返回
    poll(checker, { interval = 1000, timeout = 20000 } = {}) {
      return new Promise(resolve => {
        const start = Date.now();
        const timer = setInterval(() => {
          if (checker()) {
            clearInterval(timer);
            resolve(true);
            return;
          }
          if (Date.now() - start > timeout) {
            clearInterval(timer);
            resolve(false);
          }
        }, interval);
      });
    },
    async waitForBody(timeout = 15000) {
      if (document.body) return document.body;
      await this.poll(() => Boolean(document.body), { interval: 50, timeout });
      return document.body || document.documentElement;
    },
    // 使用UI课程完成度来判别是否完成课程
    isProgressDone(text) {
      if (!text) return false;
      return text.includes('100%') || text.includes('99%') || text.includes('98%') || text.includes('已完成');
    },
    // 主要是规避firefox会创建多个iframe的问题
    inIframe() {
      return window.top !== window.self;
    },
    // 下滑到最底部，触发课程加载
    scrollToBottom(containerSelector) {
      const el = document.querySelector(containerSelector);
      if (el) el.scrollTop = el.scrollHeight;
    },
    getCourseKey() {
      const parts = location.pathname.split('/').filter(Boolean);
      if (parts[0] === 'pro' && parts[1] === 'lms') {
        return `${location.origin}/pro/lms/${parts[2] || ''}/${parts[3] || ''}`;
      }
      if (parts[0] === 'v2' && parts[1] === 'web') {
        return `${location.origin}/v2/web/${parts[2] || ''}/${parts[3] || ''}`;
      }
      return `${location.origin}${location.pathname}`;
    },
    getLeafVmCandidates(leafNode) {
      const ownVm = leafNode?.__vue__ || null;
      const list = [ownVm, ownVm?.$parent, ownVm?.$parent?.$parent].filter(Boolean);
      return list.filter((vm, index) => list.indexOf(vm) === index);
    },
    getLeafContext(leafNode) {
      const candidates = this.getLeafVmCandidates(leafNode);
      const vm = candidates.find(candidate => (candidate?.$options?.propsData?.leafData || candidate?.$props?.leafData || candidate?.goDetail))
        || candidates[0]
        || null;
      const propsData = vm?.$options?.propsData || {};
      const props = vm?.$props || {};
      const leafData = propsData.leafData || props.leafData || null;
      const pathParts = location.pathname.split('/').filter(Boolean);
      return {
        vm,
        leafData,
        sign: String(propsData.sign || props.sign || vm?.sign || pathParts[2] || ''),
        classroomId: String(propsData.classroom_id || props.classroom_id || vm?.classroom_id || pathParts[3] || '')
      };
    },
    buildProLmsLeafUrl(leafNode) {
      const { leafData, sign, classroomId } = this.getLeafContext(leafNode);
      if (!leafData?.id || !sign || !classroomId) return '';
      const routeMap = {
        0: 'video',
        6: 'homework'
      };
      const routeName = routeMap[Number(leafData.leaf_type)];
      if (!routeName) return '';
      return `${location.origin}/pro/lms/${sign}/${classroomId}/${routeName}/${leafData.id}`;
    },
    async getDDL() {
      const element = document.querySelector('video') || document.querySelector('audio');

      const fallback = 180_000;
      if (!element) return fallback;

      let duration = Number(element.duration);
      if (!Number.isFinite(duration) || duration <= 0) {
        await new Promise(resolve => element.addEventListener('loadedmetadata', resolve, { once: true }));
        duration = Number(element.duration);
      }

      const elementDurationMs = duration * 1000;               // 转为秒
      const timeout = Math.max(elementDurationMs * 3, 10_000); // 至少 10 秒（防极短视频）;
      return timeout;
    }
  };

  // ---- 存储工具 ----
  const Store = {
    getProgress(url) {
      const raw = localStorage.getItem(Config.storageKeys.progress);
      const all = Utils.safeJSONParse(raw, {}) || { url: { outside: 0, inside: 0 } };
      if (!all[url]) {
        all[url] = { outside: 0, inside: 0 };
        localStorage.setItem(Config.storageKeys.progress, JSON.stringify(all));
      }
      return { all, current: all[url] };
    },
    setProgress(url, outside, inside = 0) {
      const raw = localStorage.getItem(Config.storageKeys.progress);
      const all = Utils.safeJSONParse(raw, {});
      all[url] = { outside, inside };
      localStorage.setItem(Config.storageKeys.progress, JSON.stringify(all));
    },
    removeProgress(url) {
      const raw = localStorage.getItem(Config.storageKeys.progress);
      const all = Utils.safeJSONParse(raw, {});
      delete all[url];
      localStorage.setItem(Config.storageKeys.progress, JSON.stringify(all));
    },
    getAIConf() {
      const raw = localStorage.getItem(Config.storageKeys.ai);
      const saved = Utils.safeJSONParse(raw, {}) || {};
      const conf = {
        url: saved.url ?? "https://api.deepseek.com/chat/completions",
        key: saved.key ?? "sk-xxxxxxx",
        model: saved.model ?? "deepseek-chat",
      };
      localStorage.setItem(Config.storageKeys.ai, JSON.stringify(conf));
      return conf;
    },
    setAIConf(conf) {
      localStorage.setItem(Config.storageKeys.ai, JSON.stringify(conf));
    },
    getProClassCount() {
      const value = localStorage.getItem(Config.storageKeys.proClassCount);
      return value ? Number(value) : 1;
    },
    setProClassCount(count) {
      localStorage.setItem(Config.storageKeys.proClassCount, count);
    },
    getFeatureConf() {
      const raw = localStorage.getItem(Config.storageKeys.feature);
      const saved = Utils.safeJSONParse(raw, {}) || {};
      const conf = {
        autoAI: saved.autoAI ?? false,
        aiVision: saved.aiVision ?? true,
        autoComment: saved.autoComment ?? false,
      };
      localStorage.setItem(Config.storageKeys.feature, JSON.stringify(conf));
      return conf;
    },
    setFeatureConf(conf) {
      localStorage.setItem(Config.storageKeys.feature, JSON.stringify(conf));
    }
  };

  const Runtime = {
    getState() {
      return Utils.safeJSONParse(sessionStorage.getItem(Config.storageKeys.runtime), {}) || {};
    },
    start() {
      const state = {
        active: true,
        courseKey: Utils.getCourseKey(),
        updatedAt: Date.now()
      };
      sessionStorage.setItem(Config.storageKeys.runtime, JSON.stringify(state));
    },
    touch(extra = {}) {
      const current = this.getState();
      if (!current.active) return;
      const nextState = {
        ...current,
        ...extra,
        updatedAt: Date.now()
      };
      sessionStorage.setItem(Config.storageKeys.runtime, JSON.stringify(nextState));
    },
    markHandoff() {
      this.touch({
        handoffAt: Date.now(),
        handoffFrom: location.href
      });
    },
    stop() {
      sessionStorage.removeItem(Config.storageKeys.runtime);
    },
    shouldResume() {
      const current = this.getState();
      if (!current.active) return false;
      if (current.courseKey !== Utils.getCourseKey()) return false;
      return Date.now() - (current.updatedAt || 0) < 6 * 60 * 60 * 1000;
    },
    isWaitingOnSamePage() {
      const current = this.getState();
      if (!current.active || !current.handoffFrom || current.handoffFrom !== location.href) return false;
      return Date.now() - (current.handoffAt || 0) < 5000;
    }
  };

  // ---- UI 面板 ----
  function createPanelUI() {
    document.getElementById('ykt-helper-iframe')?.remove();
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.top = '40px';
    iframe.style.left = '40px';
    iframe.style.width = '520px';
    iframe.style.height = '340px';
    iframe.style.zIndex = '999999';
    iframe.style.border = '1px solid #a3a3a3';
    iframe.style.borderRadius = '10px';
    iframe.style.background = '#fff';
    iframe.style.overflow = 'hidden';
    iframe.style.boxShadow = '6px 4px 17px 2px #000000';
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('id', 'ykt-helper-iframe');
    iframe.setAttribute('allowtransparency', 'true');
    document.body.appendChild(iframe);

    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(`
                  <style>
              /* 全局重置 */
              html, body { overflow: hidden; margin: 0; padding: 0; font-family: "Segoe UI", "PingFang SC", Avenir, Helvetica, Arial, sans-serif; color: #4a4a4a; background: transparent; }

              /* 主容器 */
              .mini-basic {
                position: absolute;
                inset: 0;
                background: #3a7afe;
                color: white;
                height: 100%;
                width: 100%;
                min-height: 42px;
                min-width: 42px;
                border-radius: 10px;
                text-align: center;
                line-height: 1;
                z-index: 1000000;
                cursor: pointer;
                display: none;
                align-items: center;
                justify-content: center;
                font-weight: bold;
                box-shadow: 0 4px 12px rgba(0,0,0,0);
              }
              .mini-basic.show {
                display: flex;
              }

              /* 面板主容器 */
              .panel {
                width: 100%;
                height: 100%;
                background: white;
                border-radius: 10px;
                position: relative;
                overflow: hidden;
              }

              /* 标题栏 */
              .header {
                text-align: center;
                height: 40px;
                background: #f7f7f7;
                color: #000;
                font-size: 18px;
                line-height: 40px;
                border-radius: 10px 10px 0 0;
                border-bottom: 2px solid #eee;
                cursor: move;
                position: relative;
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 0 10px;
              }
              .tools ul {
                margin: 0;
                padding: 0;
                list-style: none;
                display: flex;
                gap: 5px;
              }
              .tools li {
                display: inline-block;
                cursor: pointer;
                font-size: 14px;
                padding: 0 5px;
              }

              /* 内容区 */
              .body {
                font-weight: normal;
                font-size: 13px;
                line-height: 22px;
                height: calc(100% - 85px);
                overflow-y: auto;
                padding: 6px 8px;
                box-sizing: border-box;
              }

              .info {
                margin: 0;
                padding: 0;
                list-style: none;
              }
              .info li {
                margin-bottom: 4px;
                color: #333;
              }

              /* 设置面板 */
              #settings {
                display: none;
                position: absolute;
                top: 40px;
                left: 0;
                width: 100%;
                height: calc(100% - 40px);
                background: white;
                z-index: 99;
                padding: 15px;
                box-sizing: border-box;
                overflow-y: auto;
              }

              /* 表单项 */
              .form-item {
                margin-bottom: 15px;
              }
              .form-item label {
                display: block;
                margin-bottom: 5px;
                font-size: 12px;
                color: #333;
              }
              .form-item input[type="text"],
              .form-item input[type="password"] {
                width: 100%;
                padding: 8px;
                border: 1px solid #ddd;
                border-radius: 4px;
                font-size: 12px;
                box-sizing: border-box;
              }

              /* 复选框标签优化：避免“启用”跑到右边 */
              .form-item .checkbox-label {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 12px;
                cursor: pointer;
              }
              .form-item .checkbox-label input[type="checkbox"] {
                margin: 0;
                width: auto;
              }

              /* 底部按钮栏 */
              .footer {
                position: absolute;
                bottom: 0;
                left: 0;
                width: 100%;
                background: #f7f7f7;
                color: #c5c5c5;
                font-size: 13px;
                line-height: 25px;
                border-radius: 0 0 10px 10px;
                border-bottom: 2px solid #eee;
                display: flex;
                justify-content: center;
                align-items: center;
                padding: 6px 0;
                gap: 10px;
              }
              .footer button {
                border: none;
                border-radius: 6px;
                color: white;
                cursor: pointer;
                padding: 6px 12px;
                font-size: 12px;
                transition: all 0.2s ease;
              }
              #btn-start {
                background-color: #1677ff;
              }
              #btn-start:hover {
                background-color: #f6ff00;
                color: black;
              }
              #btn-clear {
                background-color: #ff4d4f;
              }
              #btn-setting {
                background-color: #52c41a;
              }

              /* 设置页底部按钮 */
              .settings-footer {
                text-align: center;
                margin-top: 12px;
                display: flex;
                justify-content: center;
                gap: 10px;
              }
              .settings-footer button {
                padding: 6px 15px;
                font-size: 12px;
                border-radius: 6px;
                border: none;
                cursor: pointer;
              }
              #save_settings {
                background-color: #1677ff;
                color: white;
              }
              #close_settings {
                background-color: #999;
                color: white;
              }
            </style>

            <div class="mini-basic" id="mini-basic">展开</div>
            <div class="panel" id="panel">
              <div class="header" id="header">
                雨课堂刷课助手
                <div class='tools'>
                  <ul>
                    <li class='minimality' id="minimality">_</li>
                    <li class='question' id="question">?</li>
                  </ul>
                </div>
              </div>
              <div class="body">
                <ul class="info" id="info">
                  <li>⭐ 脚本支持：雨课堂所有版本</li>
                  <li>🤖 <strong>支持模型：</strong>文本模式支持 DeepSeek / Kimi / 通义 / OpenAI；截图模式需使用支持图像输入的 OpenAI 兼容接口</li>
                  <li>📢 <strong>使用必读：</strong>自动答题需先点击<span style="color:green">[AI配置]</span>开启并填入API Key</li>
                  <li>🚀 配置完成后，点击<span style="color:blue">[开始刷课]</span>即可启动视频与作业挂机</li>
                  <li>🤝 脚本还有很多不足，欢迎各位一起完善代码</li>
                  <hr>
                </ul>
              </div>
              <div id="settings">
                <div class="form-item">
                  <label>API URL:</label>
                  <input type="text" id="ai_url" placeholder="https://api.deepseek.com/chat/completions">
                </div>
                <div class="form-item">
                  <label>API KEY:</label>
                  <input type="password" id="ai_key" placeholder="sk-xxxxxxxx">
                </div>
                <div class="form-item">
                  <label>Model Name:</label>
                  <input type="text" id="ai_model" placeholder="deepseek-chat">
                </div>
                <div class="form-item">
                  <label class="checkbox-label">
                    <input type="checkbox" id="feature_auto_ai">
                    用 AI 自动作答（作业/题目）
                  </label>
                </div>
                <div class="form-item">
                  <label class="checkbox-label">
                    <input type="checkbox" id="feature_ai_vision">
                    优先截图发给支持图像输入的 AI
                  </label>
                </div>
                <div class="form-item">
                  <label class="checkbox-label">
                    <input type="checkbox" id="feature_auto_comment">
                    用批量区图文/讨论自动回复
                  </label>
                </div>
                <div class="settings-footer">
                  <button id="save_settings">保存并关闭</button>
                  <button id="close_settings">取消</button>
                </div>
              </div>
              <div class="footer">
                <button id="btn-setting">AI配置</button>
                <button id="btn-clear">清除缓存</button>
                <button id="btn-start">开始刷课</button>
              </div>
            </div>
    `);
    doc.close();

    const ui = {
      iframe,
      doc,
      panel: doc.getElementById('panel'),
      header: doc.getElementById('header'),
      info: doc.getElementById('info'),
      btnStart: doc.getElementById('btn-start'),
      btnClear: doc.getElementById('btn-clear'),
      btnSetting: doc.getElementById('btn-setting'),
      settings: doc.getElementById('settings'),
      saveSettings: doc.getElementById('save_settings'),
      closeSettings: doc.getElementById('close_settings'),
      aiUrlInput: doc.getElementById('ai_url'),
      aiKeyInput: doc.getElementById('ai_key'),
      aiModelInput: doc.getElementById('ai_model'),
      featureAutoAI: doc.getElementById('feature_auto_ai'),
      featureAIVision: doc.getElementById('feature_ai_vision'),
      featureAutoComment: doc.getElementById('feature_auto_comment'),
      minimality: doc.getElementById('minimality'),
      question: doc.getElementById('question'),
      miniBasic: doc.getElementById('mini-basic')
    };

    let isDragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;
    const hostWindow = window.parent || window;
    const onMove = e => {
      if (!isDragging) return;
      const deltaX = e.screenX - startX;
      const deltaY = e.screenY - startY;
      const maxLeft = Math.max(0, hostWindow.innerWidth - iframe.offsetWidth);
      const maxTop = Math.max(0, hostWindow.innerHeight - iframe.offsetHeight);
      iframe.style.left = Math.min(Math.max(0, startLeft + deltaX), maxLeft) + 'px';
      iframe.style.top = Math.min(Math.max(0, startTop + deltaY), maxTop) + 'px';
    };
    const stopDrag = () => {
      if (!isDragging) return;
      isDragging = false;
      iframe.style.transition = '';
      doc.body.style.userSelect = '';
    };
    ui.header.addEventListener('mousedown', e => {
      isDragging = true;
      startX = e.screenX;
      startY = e.screenY;
      startLeft = parseFloat(iframe.style.left) || 0;
      startTop = parseFloat(iframe.style.top) || 0;
      iframe.style.transition = 'none';
      doc.body.style.userSelect = 'none';
      e.preventDefault();
    });
    doc.addEventListener('mousemove', onMove);
    hostWindow.addEventListener('mousemove', onMove);
    doc.addEventListener('mouseup', stopDrag);
    hostWindow.addEventListener('mouseup', stopDrag);
    hostWindow.addEventListener('blur', stopDrag);

    const normalSize = { width: parseFloat(iframe.style.width), height: parseFloat(iframe.style.height) };
    const miniSize = 64;
    let isMinimized = false;
    const enterMini = () => {
      if (isMinimized) return;
      isMinimized = true;
      ui.panel.style.display = 'none';
      ui.miniBasic.classList.add('show');
      iframe.style.width = miniSize + 'px';
      iframe.style.height = miniSize + 'px';
    };
    const exitMini = () => {
      if (!isMinimized) return;
      isMinimized = false;
      ui.panel.style.display = '';
      ui.miniBasic.classList.remove('show');
      iframe.style.width = normalSize.width + 'px';
      iframe.style.height = normalSize.height + 'px';
    };
    ui.minimality.addEventListener('click', enterMini);
    ui.miniBasic.addEventListener('click', exitMini);

    ui.question.addEventListener('click', () => {
      window.parent.alert('作者：niuwh.cn（重构版 by Codex）');
    });

    const log = message => {
      const li = doc.createElement('li');
      li.innerText = message;
      ui.info.appendChild(li);
      if (ui.info.lastElementChild) ui.info.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'nearest' });
    };

    const defaultAI = { url: 'https://api.deepseek.com/chat/completions', key: 'sk-xxxxxxx', model: 'deepseek-chat' };
    const loadAIConf = () => {
      const saved = Store.getAIConf();
      ui.aiUrlInput.value = saved.url || defaultAI.url;
      ui.aiKeyInput.value = saved.key || defaultAI.key;
      ui.aiModelInput.value = saved.model || defaultAI.model;
    };
    const loadFeatureConf = () => {
      const saved = Store.getFeatureConf();
      ui.featureAutoAI.checked = saved.autoAI;
      ui.featureAIVision.checked = saved.aiVision;
      ui.featureAutoComment.checked = saved.autoComment;
    };
    loadAIConf();
    loadFeatureConf();
    ui.btnSetting.onclick = () => {
      loadAIConf();
      loadFeatureConf();
      ui.settings.style.display = 'block';
    };
    ui.closeSettings.onclick = () => {
      ui.settings.style.display = 'none';
    };
    ui.saveSettings.onclick = () => {
      const conf = {
        url: ui.aiUrlInput.value.trim(),
        key: ui.aiKeyInput.value.trim(),
        model: ui.aiModelInput.value.trim()
      };
      Store.setAIConf(conf);
      const featureConf = {
        autoAI: ui.featureAutoAI.checked,
        aiVision: ui.featureAIVision.checked,
        autoComment: ui.featureAutoComment.checked
      };
      Store.setFeatureConf(featureConf);
      ui.settings.style.display = 'none';
      log('✅ AI 配置已保存');
    };

    ui.btnClear.onclick = () => {
      Store.removeProgress(window.parent.location.href);
      localStorage.removeItem(Config.storageKeys.proClassCount);
      log('已清除当前课程的刷课进度缓存');
    };

    // 后面赋值给panel
    return {
      ...ui,
      log,
      setStartHandler(fn) {
        ui.btnStart.onclick = () => {
          fn && fn();
        };
      },
      resetStartButton(text = '开始刷课') {
        ui.btnStart.innerText = text;
      }
    };
  }

  const Panel = {
    ui: null,
    startHandler: null,
    creating: null,
    bootLogged: false,
    async ensure() {
      if (Utils.inIframe()) return null;
      if (this.ui?.iframe && document.body?.contains(this.ui.iframe)) return this.ui;
      if (this.creating) return this.creating;
      this.creating = (async () => {
        await Utils.waitForBody();
        this.ui = createPanelUI();
        if (this.startHandler) this.ui.setStartHandler(this.startHandler);
        if (!this.bootLogged) {
          this.ui.log(`雨课堂刷课助手 v${Config.version} 已加载`);
          this.bootLogged = true;
        }
        return this.ui;
      })();
      try {
        return await this.creating;
      } finally {
        this.creating = null;
      }
    },
    async log(message) {
      const ui = await this.ensure();
      ui?.log(message);
    },
    async resetStartButton(text = '开始刷课') {
      const ui = await this.ensure();
      ui?.resetStartButton(text);
    },
    async setStartHandler(fn) {
      this.startHandler = fn;
      const ui = await this.ensure();
      ui?.setStartHandler(fn);
    }
  };

  // ---- 播放器工具 ----
  const Player = {
    applySpeed() {
      const rate = Config.playbackRate;
      const speedBtn = document.querySelector('xt-speedlist xt-button') || document.getElementsByTagName('xt-speedlist')[0]?.firstElementChild?.firstElementChild;
      const speedWrap = document.getElementsByTagName('xt-speedbutton')[0];
      if (speedBtn && speedWrap) {
        speedBtn.setAttribute('data-speed', rate);
        speedBtn.setAttribute('keyt', `${rate}.00`);
        speedBtn.innerText = `${rate}.00X`;
        const mousemove = document.createEvent('MouseEvent');
        mousemove.initMouseEvent('mousemove', true, true, unsafeWindow, 0, 10, 10, 10, 10, 0, 0, 0, 0, 0, null);
        speedWrap.dispatchEvent(mousemove);
        speedBtn.click();
      } else if (document.querySelector('video')) {
        document.querySelector('video').playbackRate = rate;
      }
    },
    mute() {
      const muteBtn = document.querySelector('#video-box > div > xt-wrap > xt-controls > xt-inner > xt-volumebutton > xt-icon');
      if (muteBtn) muteBtn.click();
      const video = document.querySelector('video');
      if (video) video.volume = 0;
    },
    applyMediaDefault(media) {
      if (!media) return;
      media.play();
      media.volume = 0;
      media.playbackRate = Config.playbackRate;
    },
    observePause(video) {
      if (!video) return () => { };
      const target = document.getElementsByClassName('play-btn-tip')[0];
      if (!target) return () => { };
      // 自动播放
      const playVideo = () => {
        video.play().catch(e => {
          console.warn('自动播放失败:', e);
          setTimeout(playVideo, 3000);
        });
      };
      playVideo();
      const observer = new MutationObserver(list => {
        for (const mutation of list) {
          if (mutation.type === 'childList' && target.innerText === '播放') {
            video.play();
          }
        }
      });
      observer.observe(target, { childList: true });
      return () => observer.disconnect();
    },
    waitForEnd(media, timeout = 0) {
      return new Promise(resolve => {
        if (!media) return resolve();
        if (media.ended) return resolve();
        let timer;
        const onEnded = () => {
          clearTimeout(timer);
          resolve();
        };
        media.addEventListener('ended', onEnded, { once: true });
        if (timeout > 0) {
          timer = setTimeout(() => {
            media.removeEventListener('ended', onEnded);
            resolve();
          }, timeout);
        }
      });
    }
  };

  // ---- 防切屏 ----
  function preventScreenCheck() {
    const win = unsafeWindow;
    const blackList = new Set(['visibilitychange', 'blur', 'pagehide']);
    win._addEventListener = win.addEventListener;
    win.addEventListener = (...args) => blackList.has(args[0]) ? undefined : win._addEventListener(...args);
    document._addEventListener = document.addEventListener;
    document.addEventListener = (...args) => blackList.has(args[0]) ? undefined : document._addEventListener(...args);
    Object.defineProperties(document, {
      hidden: { value: false },
      visibilityState: { value: 'visible' },
      hasFocus: { value: () => true },
      onvisibilitychange: { get: () => undefined, set: () => { } },
      onblur: { get: () => undefined, set: () => { } }
    });
    Object.defineProperties(win, {
      onblur: { get: () => undefined, set: () => { } },
      onpagehide: { get: () => undefined, set: () => { } }
    });
  }

  // ---- OCR / 截图 / AI ----
  const Solver = {
    async recognize(element, { label = '正在 OCR 识别 (首轮较慢)...' } = {}) {
      if (!element) return '无元素';
      try {
        panel.log(label);
        const canvas = await html2canvas(element, {
          useCORS: true,
          logging: false,
          scale: 2,
          backgroundColor: '#ffffff'
        });
        const { data: { text } } = await Tesseract.recognize(canvas, 'chi_sim', {
          logger: m => {
            if (m.status === 'downloading tesseract lang') {
              console.log(`正在下载语言包 ${(m.progress * 100).toFixed(0)}%`);
            }
          }
        });
        return Utils.normalizeText(text);
      } catch (err) {
        console.error('OCR error:', err);
        panel.log(`OCR 失败: ${err.message || '网络错误'}`);
        return 'OCR识别出错';
      }
    },
    async captureQuestionImage(element, { label = '正在截图题目并发送给 AI...' } = {}) {
      if (!element) throw new Error('未找到题目区域');
      panel.log(label);
      const sourceCanvas = await html2canvas(element, {
        useCORS: true,
        logging: false,
        scale: Math.min(window.devicePixelRatio || 1, 2),
        backgroundColor: '#ffffff'
      });
      const maxSide = 1600;
      const longestSide = Math.max(sourceCanvas.width, sourceCanvas.height);
      if (longestSide <= maxSide) {
        return sourceCanvas.toDataURL('image/jpeg', 0.9);
      }
      const ratio = maxSide / longestSide;
      const outputCanvas = document.createElement('canvas');
      outputCanvas.width = Math.max(1, Math.round(sourceCanvas.width * ratio));
      outputCanvas.height = Math.max(1, Math.round(sourceCanvas.height * ratio));
      const ctx = outputCanvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, outputCanvas.width, outputCanvas.height);
      ctx.drawImage(sourceCanvas, 0, 0, outputCanvas.width, outputCanvas.height);
      return outputCanvas.toDataURL('image/jpeg', 0.85);
    },
    requestAI(userContent, systemPrompt = "你是一个只输出答案的助手。判断题输出'对'或'错'，选择题输出字母。") {
      const saved = Store.getAIConf();
      const API_URL = saved.url?.trim();
      const API_KEY = saved.key?.trim();
      const MODEL_NAME = saved.model?.trim();
      const content = Array.isArray(userContent) ? userContent : String(userContent || '');
      return new Promise((resolve, reject) => {
        if (!API_URL) {
          const msg = '⚠️ 请在 [AI配置] 中填写有效的 API 地址';
          panel.log(msg);
          reject(msg);
          return;
        }
        if (!API_KEY || API_KEY.includes('sk-xxxx')) {
          const msg = '⚠️ 请在 [AI配置] 中填写有效的 API Key';
          panel.log(msg);
          reject(msg);
          return;
        }
        if (!MODEL_NAME) {
          const msg = '⚠️ 请在 [AI配置] 中填写模型名称';
          panel.log(msg);
          reject(msg);
          return;
        }
        GM_xmlhttpRequest({
          method: 'POST',
          url: API_URL,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`
          },
          data: JSON.stringify({
            model: MODEL_NAME,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content }
            ],
            temperature: 0.1
          }),
          timeout: 60000,
          onload: res => {
            if (res.status === 200) {
              try {
                const json = JSON.parse(res.responseText);
                const answerText = Utils.normalizeText(json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text || '');
                if (!answerText) {
                  reject('AI 未返回有效答案');
                  return;
                }
                resolve(answerText);
              } catch (e) {
                reject('JSON 解析失败');
              }
            } else {
              let detail = '';
              try {
                const body = JSON.parse(res.responseText || '{}');
                detail = Utils.normalizeText(body?.error?.message || body?.message || '');
              } catch (_) { }
              if (/insufficient balance/i.test(detail)) {
                detail = '余额不足，请检查 DeepSeek 账户额度';
              }
              if (/insufficient_quota|current quota|billing/i.test(detail)) {
                detail = 'OpenAI 额度不足或未开通计费，请检查 API Billing';
              }
              if (/image|vision|multimodal|content.*array|unsupported.*type/i.test(detail)) {
                detail = `当前接口或模型不支持图像输入，请切换到支持视觉的 OpenAI 兼容接口/模型，或关闭截图模式${detail ? `（${detail}）` : ''}`;
              }
              const err = `请求失败: HTTP ${res.status}${detail ? ` - ${detail}` : ''}`;
              panel.log(err);
              reject(err);
            }
          },
          onerror: () => reject('网络错误'),
          ontimeout: () => reject('请求超时')
        });
      });
    },
    isFatalAIError(error) {
      const text = String(error || '');
      return ['API Key', 'API 地址', '模型名称', 'HTTP 400', 'HTTP 401', 'HTTP 402', 'HTTP 403', 'HTTP 429', '余额不足', '额度不足', '计费', '不支持图像输入'].some(keyword => text.includes(keyword));
    },
    supportsVisionModel(modelName = '') {
      const normalized = String(modelName || '').toLowerCase();
      return /(vl|vision|omni|4o|gpt-4\.1|gemini|glm-4\.1v|qvq|internvl|minicpm-v|claude-3|qwen3\.5-397b-a17b)/.test(normalized);
    },
    async askAI(ocrText, optionCount = 0) {
      const maxChar = String.fromCharCode(65 + optionCount - 1);
      const rangeStr = optionCount ? `A-${maxChar}` : 'A-D';
      const prompt = `
你是专业做题助手，请分析 OCR 文本，判断题型后给出答案。
强约束：
1) 本题只有 ${optionCount || '若干'} 个选项，范围 ${rangeStr}
2) 忽略 OCR 错误的选项字母，按出现顺序映射 A/B/C/D...
3) 输出格式必须包含“正确答案：”前缀，例如 正确答案：A 或 正确答案：ABD 或 正确答案：对/错
题目内容：
${ocrText}
`;
      return this.requestAI(prompt);
    },
    getOptionKeys(itemBodyElement) {
      return this.getOptionNodes(itemBodyElement).map((node, index) => {
        const input = node.querySelector('input[type="checkbox"], input[type="radio"]') || node.querySelector('input');
        return (input?.value || String.fromCharCode(65 + index)).toUpperCase();
      });
    },
    getOptionNodes(itemBodyElement) {
      if (!itemBodyElement) return [];
      const options = itemBodyElement.querySelectorAll('label.el-radio, label.el-checkbox, ul[class*="list-unstyled"] > li, ul.list > li');
      return Array.from(options).filter(node => node.offsetParent !== null || node.querySelector('input'));
    },
    parseAnswer(aiResponse, optionKeys = []) {
      const range = optionKeys.length ? optionKeys.join('') : 'A-F';
      const match = aiResponse.match(new RegExp(`(?:正确)?答案[：:]?\\s*([${range}]+(?:[\\s,，、]+[${range}]+)*|[对错]|正确|错误)`, 'i'));
      if (!match) {
        panel.log('⚠️ 未提取到有效选项，请人工检查');
        return [];
      }
      let answerRaw = match[1].replace(/[\s,，、]/g, '').trim();
      let targetValues = [];
      if (answerRaw === '对' || answerRaw === '正确') {
        targetValues = [optionKeys[0] || 'A'];
      } else if (answerRaw === '错' || answerRaw === '错误') {
        targetValues = [optionKeys[1] || 'B'];
      } else {
        targetValues = Array.from(new Set(answerRaw.toUpperCase().split('').filter(char => !optionKeys.length || optionKeys.includes(char))));
      }
      if (!targetValues.length) return [];
      panel.log(`✅ AI 建议选：${answerRaw}`);
      return targetValues;
    },
    async applyAnswer(itemBodyElement, answerValues) {
      const optionNodes = this.getOptionNodes(itemBodyElement);
      if (!optionNodes.length) {
        panel.log('⚠️ 未找到选项容器');
        return false;
      }
      const getInput = node => node.querySelector('input[type="checkbox"], input[type="radio"]') || node.querySelector('input');
      const nodeMap = new Map();
      optionNodes.forEach((node, index) => {
        const input = getInput(node);
        const value = (input?.value || String.fromCharCode(65 + index)).toUpperCase();
        nodeMap.set(value, { node, input });
      });
      for (const [value, { node, input }] of nodeMap.entries()) {
        if (input?.type === 'checkbox' && input.checked && !answerValues.includes(value)) {
          node.click();
          await Utils.sleep(150);
        }
      }
      for (const value of answerValues) {
        const entry = nodeMap.get(value);
        if (!entry) continue;
        if (!entry.input?.checked) {
          entry.node.click();
          await Utils.sleep(150);
        }
      }
      return answerValues.some(value => nodeMap.get(value)?.input?.checked);
    },
    getVisibleSubmitButton(scope = document) {
      return Array.from(scope.querySelectorAll('button.el-button--primary, .el-button.el-button--primary')).find(btn => {
        const text = Utils.normalizeText(btn.innerText || '');
        return btn.offsetParent !== null && text.includes('提交') && !text.includes('全部提交') && !btn.classList.contains('is-round') && !btn.classList.contains('is-disabled');
      }) || null;
    },
    async autoSelectAndSubmit(aiResponse, itemBodyElement) {
      const optionKeys = this.getOptionKeys(itemBodyElement);
      const answerValues = this.parseAnswer(aiResponse, optionKeys);
      if (!answerValues.length) return;
      const applied = await this.applyAnswer(itemBodyElement, answerValues);
      if (!applied) {
        panel.log('⚠️ 选项未成功勾选，请人工检查');
        return;
      }
      const submitBtn = this.getVisibleSubmitButton(document) || this.getVisibleSubmitButton(itemBodyElement?.parentElement || document);
      if (submitBtn) {
        panel.log('正在提交...');
        submitBtn.click();
      } else {
        panel.log('⚠️ 未找到提交按钮，请手动提交');
      }
    },
    async extractProHomeworkQuestion(problem, itemBodyElement, { preferVision = false } = {}) {
      const content = problem?.content || {};
      const encrypted = /xuetangx-com-encrypted-font/.test(content.Body || '') || (content.Options || []).some(option => /xuetangx-com-encrypted-font/.test(option.value || ''));
      const structured = {
        type: content.TypeText || content.Type || '未知题型',
        stem: Utils.htmlToText(content.Body || ''),
        options: (content.Options || []).map(option => ({
          key: option.key?.toUpperCase(),
          text: Utils.htmlToText(option.value || '')
        })),
        encrypted,
        rawOcrText: ''
      };
      if (encrypted && itemBodyElement && !preferVision) {
        structured.rawOcrText = await this.recognize(itemBodyElement, { label: '检测到加密字体，正在 OCR 识别题目和选项...' });
      }
      if (!structured.options.length && itemBodyElement) {
        const optionNodes = this.getOptionNodes(itemBodyElement);
        structured.options = optionNodes.map((node, index) => {
          const input = node.querySelector('input[type="checkbox"], input[type="radio"]') || node.querySelector('input');
          return {
            key: (input?.value || String.fromCharCode(65 + index)).toUpperCase(),
            text: Utils.normalizeText(node.innerText || '')
          };
        });
      }
      return structured;
    },
    buildQuestionPrompt(question, { forVision = false } = {}) {
      const letters = question.options.map(option => option.key).filter(Boolean);
      const rangeStr = letters.length ? letters.join('/') : 'A/B/C/D';
      const optionLines = question.options.map(option => `${option.key}. ${option.text}`).join('\n');
      const optionOrder = letters.length ? letters.join('、') : 'A、B、C、D';
      const pageTextHint = !question.encrypted && (question.stem || optionLines)
        ? `${question.stem ? `\n页面文本题干：${question.stem}` : ''}${optionLines ? `\n页面文本选项：\n${optionLines}` : ''}`
        : '';
      const questionBlock = forVision
        ? `请以截图内容为准识别题干与选项；如果下面的文字与截图不一致，请优先相信截图。\n题型：${question.type}\n可选答案顺序：${optionOrder}${pageTextHint}`
        : question.encrypted && question.rawOcrText
        ? `以下文本来自页面渲染后的 OCR 识别，请按选项顺序 ${optionOrder} 作答：\n${question.rawOcrText}`
        : `题干：${question.stem}\n选项：\n${optionLines}`;
      return `
你是专业做题助手，请根据题干和选项直接给出答案。
强约束：
1) 题型：${question.type}
2) 可选答案范围：${rangeStr}
3) 若是多选题，只输出选项字母的组合，例如 ABD
4) 若是单选题，只输出一个字母
5) 若是判断题，输出“对”或“错”
6) 输出格式必须包含“正确答案：”前缀，例如 正确答案：A

${questionBlock}
`;
    },
    async askQuestion(question, itemBodyElement) {
      const featureFlags = Store.getFeatureConf();
      const modelName = Store.getAIConf().model;
      const useVision = featureFlags.aiVision && itemBodyElement && this.supportsVisionModel(modelName);
      if (featureFlags.aiVision && itemBodyElement && !useVision) {
        panel.log(`当前模型 ${modelName} 不支持图像输入，已自动切换到文本/OCR模式`);
      }
      if (useVision) {
        const imageDataUrl = await this.captureQuestionImage(itemBodyElement);
        const prompt = this.buildQuestionPrompt(question, { forVision: true });
        return this.requestAI([
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageDataUrl, detail: 'high' } }
        ]);
      }
      const prompt = this.buildQuestionPrompt(question);
      return this.requestAI(prompt);
    },
    async askQuestionFromElement(itemBodyElement, { type = '未知题型', preferVision = false } = {}) {
      const optionKeys = this.getOptionKeys(itemBodyElement);
      const optionNodes = this.getOptionNodes(itemBodyElement);
      const question = {
        type,
        stem: Utils.normalizeText(itemBodyElement?.querySelector('.problem-body, .topic-content, .item-type')?.innerText || itemBodyElement?.innerText || ''),
        options: optionNodes.map((node, index) => ({
          key: optionKeys[index] || String.fromCharCode(65 + index),
          text: Utils.normalizeText(node.innerText || '')
        })),
        encrypted: false,
        rawOcrText: ''
      };
      if (!preferVision && !question.options.length) {
        const ocrText = await this.recognize(itemBodyElement);
        return this.askAI(ocrText);
      }
      return this.askQuestion(question, itemBodyElement);
    }
  };

  // ---- v2 逻辑 ----
  class V2Runner {
    constructor(panel) {
      this.panel = panel;
      this.baseUrl = location.href;
      const { current } = Store.getProgress(this.baseUrl);
      this.outside = current.outside;
      this.inside = current.inside;
    }

    updateProgress(outside, inside = 0) {
      this.outside = outside;
      this.inside = inside;
      Store.setProgress(this.baseUrl, outside, inside);
      Runtime.touch();
    }

    async run() {
      this.panel.log(`检测到已播放到第 ${this.outside} 集，继续刷课...`);
      while (true) {
        await this.autoSlide();
        const list = document.querySelector('.logs-list')?.childNodes;
        if (!list || !list.length) {
          this.panel.log('未找到课程列表，稍后重试');
          await Utils.sleep(2000);
          continue;
        }
        console.log(`当前集数:${this.outside}/全部集数${list.length}`);
        if (this.outside >= list.length) {
          this.panel.log('课程刷完啦 🎉');
          this.panel.resetStartButton('刷完啦~');
          Store.removeProgress(this.baseUrl);
          break;
        }
        const course = list[this.outside]?.querySelector('.content-box')?.querySelector('section');
        if (!course) {
          this.panel.log('未找到当前课程节点，跳过');
          this.updateProgress(this.outside + 1, 0);
          continue;
        }
        const type = course.querySelector('.tag')?.querySelector('use')?.getAttribute('xlink:href') || 'piliang';
        this.panel.log(`刷课状态：第 ${this.outside + 1}/${list.length} 个，类型 ${type}`);
        if (type.includes('shipin')) {
          await this.handleVideo(course);
        } else if (type.includes('piliang')) {
          await this.handleBatch(course, list);
        } else if (type.includes('ketang')) {
          await this.handleClassroom(course);
        } else if (type.includes('kejian')) {
          await this.handleCourseware(course);
        } else if (type.includes('kaoshi')) {
          this.panel.log('考试区域脚本会被屏蔽，已跳过');
          this.updateProgress(this.outside + 1, 0);
        } else {
          this.panel.log('非视频/批量/课件/考试，已跳过');
          this.updateProgress(this.outside + 1, 0);
        }
      }
    }

    async autoSlide() {
      const frequency = Math.floor((this.outside + 1) / 20) + 1;
      for (let i = 0; i < frequency; i++) {
        Utils.scrollToBottom('.viewContainer');
        await Utils.sleep(800);
      }
    }

    async handleVideo(course) {
      course.click();
      await Utils.sleep(3000);
      const progressNode = document.querySelector('.progress-wrap')?.querySelector('.text');
      const title = document.querySelector('.title')?.innerText || '视频';
      const isDeadline = document.querySelector('.box')?.innerText.includes('已过考核截止时间');
      if (isDeadline) this.panel.log(`${title} 已过截止，进度不再增加，将直接跳过`);
      Player.applySpeed();
      Player.mute();
      const stopObserve = Player.observePause(document.querySelector('video'));
      await Utils.poll(() => isDeadline || Utils.isProgressDone(progressNode?.innerHTML), { interval: 5000, timeout: await Utils.getDDL() });
      stopObserve();
      this.updateProgress(this.outside + 1, 0);
      history.back();
      await Utils.sleep(1200);
    }

    async handleBatch(course, list) {
      const expandBtn = course.querySelector('.sub-info')?.querySelector('.gray')?.querySelector('span');
      if (!expandBtn) {
        this.panel.log('未找到批量展开按钮，跳过');
        this.updateProgress(this.outside + 1, 0);
        return;
      }
      expandBtn.click();
      await Utils.sleep(1200);
      const activities = list[this.outside]?.querySelector('.leaf_list__wrap')?.querySelectorAll('.activity__wrap') || [];
      let idx = this.inside;
      this.panel.log(`进入批量区，内部进度 ${idx}/${activities.length}`);
      while (idx < activities.length) {
        const item = activities[idx];
        if (!item) break;
        const tagText = item.querySelector('.tag')?.innerText || '';
        const tagHref = item.querySelector('.tag')?.querySelector('use')?.getAttribute('xlink:href') || '';
        const title = item.querySelector('h2')?.innerText || `第${idx + 1}项`;
        if (tagText === '音频') {
          idx = await this.playAudioItem(item, title, idx);
        } else if (tagHref.includes('shipin')) {
          idx = await this.playVideoItem(item, title, idx);
        } else if (tagHref.includes('tuwen') || tagHref.includes('taolun')) {
          idx = await this.autoCommentItem(item, tagHref.includes('tuwen') ? '图文' : '讨论', idx);
        } else if (tagHref.includes('zuoye')) {
          idx = await this.handleHomework(item, idx);
        } else {
          this.panel.log(`类型未知，已跳过：${title}`);
          idx++;
          this.updateProgress(this.outside, idx);
        }
      }
      this.updateProgress(this.outside + 1, 0);
      await Utils.sleep(1000);
    }

    async playAudioItem(item, title, idx) {
      this.panel.log(`开始播放音频：${title}`);
      item.click();
      await Utils.sleep(2500);
      Player.applyMediaDefault(document.querySelector('audio'));
      const progressNode = document.querySelector('.progress-wrap')?.querySelector('.text');
      await Utils.poll(() => Utils.isProgressDone(progressNode?.innerHTML), { interval: 3000, timeout: await Utils.getDDL() });
      this.panel.log(`${title} 播放完成`);
      idx++;
      this.updateProgress(this.outside, idx);
      history.back();
      await Utils.sleep(1500);
      return idx;
    }

    async playVideoItem(item, title, idx) {
      this.panel.log(`开始播放视频：${title}`);
      item.click();
      await Utils.sleep(2500);
      Player.applySpeed();
      Player.mute();
      const stopObserve = Player.observePause(document.querySelector('video'));
      const progressNode = document.querySelector('.progress-wrap')?.querySelector('.text');
      await Utils.poll(() => Utils.isProgressDone(progressNode?.innerHTML), { interval: 3000, timeout: await Utils.getDDL() });
      stopObserve();
      this.panel.log(`${title} 播放完成`);
      idx++;
      this.updateProgress(this.outside, idx);
      history.back();
      await Utils.sleep(1500);
      return idx;
    }

    async autoCommentItem(item, typeText, idx) {
      const featureFlags = Store.getFeatureConf();
      if (!featureFlags.autoComment) {
        this.panel.log('已关闭自动回复评论，跳过该项');
        idx++;
        this.updateProgress(this.outside, idx);
        return idx;
      }
      this.panel.log(`开始处理${typeText}：${item.querySelector('h2')?.innerText || ''}`);
      item.click();
      await Utils.sleep(1200);
      window.scrollTo(0, document.body.scrollHeight);
      await Utils.sleep(800);
      window.scrollTo(0, 0);
      const commentSelectors = ['#new_discuss .new_discuss_list .cont_detail', '.new_discuss_list dd .cont_detail', '.cont_detail.word-break'];
      let firstComment = '';
      for (let retry = 0; retry < 30 && !firstComment; retry++) {
        for (const sel of commentSelectors) {
          const list = document.querySelectorAll(sel);
          for (const node of list) {
            if (node?.innerText?.trim()) {
              firstComment = node.innerText.trim();
              break;
            }
          }
          if (firstComment) break;
        }
        if (!firstComment) await Utils.sleep(500);
      }
      if (!firstComment) {
        this.panel.log('未找到评论内容，跳过该项');
      } else {
        const input = document.querySelector('.el-textarea__inner');
        if (input) {
          input.value = firstComment;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          await Utils.sleep(800);
          const sendBtn = document.querySelector('.el-button.submitComment') ||
            document.querySelector('.publish_discuss .postBtn button') ||
            document.querySelector('.el-button--primary');
          if (sendBtn && !sendBtn.disabled && !sendBtn.classList.contains('is-disabled')) {
            sendBtn.click();
            this.panel.log(`已在${typeText}区发表评论`);
          } else {
            this.panel.log('发送按钮不可用或不存在');
          }
        } else {
          this.panel.log('未找到评论输入框，跳过');
        }
      }
      idx++;
      this.updateProgress(this.outside, idx);
      history.back();
      await Utils.sleep(1000);
      return idx;
    }

    async handleHomework(item, idx) {
      const featureFlags = Store.getFeatureConf();
      if (!featureFlags.autoAI) {
        this.panel.log('已关闭AI自动答题，跳过该项');
        idx++;
        this.updateProgress(this.outside, idx);
        return idx;
      }
      this.panel.log('进入作业，启动 OCR + AI');
      item.click();
      await Utils.sleep(1500);
      const preferVision = featureFlags.aiVision && Solver.supportsVisionModel(Store.getAIConf().model);
      let i = 0;
      while (true) {
        const items = document.querySelectorAll('.subject-item.J_order');
        if (i >= items.length) {
          this.panel.log(`所有题目处理完毕，共 ${items.length} 题，准备交卷`);
          break;
        }
        const listItem = items[i];
        listItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
        listItem.click();
        await Utils.sleep(1800);
        const disabled = document.querySelectorAll('.el-button.el-button--info.is-disabled.is-plain');
        if (disabled.length > 0) {
          this.panel.log(`第 ${i + 1} 题已完成，跳过...`);
          i++;
          continue;
        }
        const targetEl = document.querySelector('.item-type')?.parentElement || document.querySelector('.item-body');
        const questionType = Utils.normalizeText(document.querySelector('.item-type')?.innerText || '');
        if (targetEl) {
          try {
            panel.log(`🤖 请求 AI 获取答案...${preferVision ? '（截图模式）' : ''}`);
            const aiText = await Solver.askQuestionFromElement(targetEl, { type: questionType, preferVision });
            await Solver.autoSelectAndSubmit(aiText, targetEl);
          } catch (err) {
            this.panel.log(`AI 答题失败：${err}`);
            if (Solver.isFatalAIError(err)) {
              this.panel.log('AI 配置或额度异常，已停止当前作业自动答题');
              break;
            }
          }
        }
        await Utils.sleep(1500);
        i++;
      }
      idx++;
      this.updateProgress(this.outside, idx);
      history.back();
      await Utils.sleep(1200);
      return idx;
    }

    async handleClassroom(course) {
      this.panel.log('进入课堂模式...');
      course.click();
      await Utils.sleep(5000);
      const iframe = document.querySelector('iframe.lesson-report-mobile');
      if (!iframe || !iframe.contentDocument) {
        this.panel.log('未找到课堂 iframe，跳过');
        this.updateProgress(this.outside + 1, 0);
        return;
      }
      const video = iframe.contentDocument.querySelector('video');
      const audio = iframe.contentDocument.querySelector('audio');
      if (video) {
        Player.applyMediaDefault(video);
        await Player.waitForEnd(video);
      }
      if (audio) {
        Player.applyMediaDefault(audio);
        await Player.waitForEnd(audio);
      }
      this.updateProgress(this.outside + 1, 0);
      history.go(-1);
      await Utils.sleep(1200);
    }

    async handleCourseware(course) {
      const tableData = course.parentNode?.parentNode?.parentNode?.__vue__?.tableData;
      const deadlinePassed = (tableData?.deadline || tableData?.end) ? (tableData.deadline < Date.now() || tableData.end < Date.now()) : false;
      if (deadlinePassed) {
        this.panel.log(`${course.querySelector('h2')?.innerText || '课件'} 已结课，跳过`);
        this.updateProgress(this.outside + 1, 0);
        return;
      }
      course.click();
      await Utils.sleep(3000);
      const classType = document.querySelector('.el-card__header')?.innerText || '';
      const className = document.querySelector('.dialog-header')?.firstElementChild?.innerText || '课件';
      if (classType.includes('PPT')) {
        const slides = document.querySelector('.swiper-wrapper')?.children || [];
        this.panel.log(`开始播放 PPT：${className}`);
        for (let i = 0; i < slides.length; i++) {
          slides[i].click();
          this.panel.log(`${className}：第 ${i + 1} 张`);
          await Utils.sleep(Config.pptInterval);
        }
        await Utils.sleep(Config.pptInterval);
        const videoBoxes = document.querySelectorAll('.video-box');
        if (videoBoxes?.length) {
          this.panel.log('PPT 中有视频，继续播放');
          for (let i = 0; i < videoBoxes.length; i++) {
            if (videoBoxes[i].innerText === '已完成') {
              this.panel.log(`第 ${i + 1} 个视频已完成，跳过`);
              continue;
            }
            videoBoxes[i].click();
            await Utils.sleep(2000);
            Player.applySpeed();
            const muteBtn = document.querySelector('.xt_video_player_common_icon');
            muteBtn && muteBtn.click();
            const stopObserve = Player.observePause(document.querySelector('video'));
            await Utils.poll(() => {
              const allTime = document.querySelector('.xt_video_player_current_time_display')?.innerText || '';
              const [nowTime, totalTime] = allTime.split(' / ');
              return nowTime && totalTime && nowTime === totalTime;
            }, { interval: 800, timeout: await Utils.getDDL() });
            stopObserve();
          }
        }
        this.panel.log(`${className} 已播放完毕`);
      } else {
        const videoBox = document.querySelector('.video-box');
        if (videoBox) {
          videoBox.click();
          await Utils.sleep(1800);
          Player.applySpeed();
          const muteBtn = document.querySelector('.xt_video_player_common_icon');
          muteBtn && muteBtn.click();
          await Utils.poll(() => {
            const times = document.querySelector('.xt_video_player_current_time_display')?.innerText || '';
            const [nowTime, totalTime] = times.split(' / ');
            return nowTime && totalTime && nowTime === totalTime;
          }, { interval: 800, timeout: await Utils.getDDL() });
          this.panel.log(`${className} 视频播放完毕`);
        }
      }
      this.updateProgress(this.outside + 1, 0);
      history.back();
      await Utils.sleep(1000);
    }
  }

  // ---- pro/lms 旧版（仅做转发） ----
  class ProOldRunner {
    constructor(panel) {
      this.panel = panel;
    }
    isCompleted(leafNode) {
      return Utils.isProgressDone(leafNode?.innerText || '');
    }
    getLeafNodes() {
      return Array.from(document.querySelectorAll('.leaf-detail'));
    }
    openLeafInCurrentTab(leafNode) {
      const { vm } = Utils.getLeafContext(leafNode);
      const directUrl = Utils.buildProLmsLeafUrl(leafNode);
      const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      if (directUrl) {
        pageWindow.location.assign(directUrl);
        return;
      }
      if (!vm?.goDetail) {
        leafNode?.click();
        return;
      }
      const originalOpen = pageWindow.open;
      pageWindow.open = (url, target, features) => {
        if (typeof url === 'string' && url) {
          pageWindow.location.assign(new URL(url, location.origin).href);
        }
        return pageWindow;
      };
      try {
        vm.goDetail();
      } finally {
        setTimeout(() => {
          pageWindow.open = originalOpen;
        }, 1000);
      }
    }
    run() {
      Runtime.touch();
      const leafNodes = this.getLeafNodes();
      if (!leafNodes.length) {
        this.panel.log('未找到课程目录，稍后重试');
        return;
      }
      const nextIndex = leafNodes.findIndex(node => !this.isCompleted(node));
      if (nextIndex === -1) {
        localStorage.removeItem(Config.storageKeys.proClassCount);
        this.panel.log('目录页所有课时均已完成 🎉');
        this.panel.resetStartButton('刷完啦~');
        Runtime.stop();
        return;
      }
      const nextLeaf = leafNodes[nextIndex];
      const title = nextLeaf.querySelector('.title')?.innerText?.trim() || `第 ${nextIndex + 1} 项`;
      Store.setProClassCount(nextIndex + 1);
      this.panel.log(`从第一个未完成课时开始：${title}（${nextIndex + 1}/${leafNodes.length}）`);
      this.openLeafInCurrentTab(nextLeaf);
      return { handoff: true };
    }
  }

  // ---- pro/lms 新版（主要逻辑） ----
  class ProNewRunner {
    constructor(panel) {
      this.panel = panel;
    }
    getHomeworkVm() {
      return document.querySelector('.container')?.__vue__ || null;
    }
    getHomeworkProblems(vm = this.getHomeworkVm()) {
      return vm?.exerciseList?.problems || [];
    }
    isHomeworkProblemCompleted(problem) {
      return (problem?.user?.my_count || 0) > 0
        || Utils.hasValue(problem?.submission_status)
        || Utils.hasValue(problem?.user?.is_right);
    }
    async focusHomeworkProblem(vm, problem) {
      if (!vm || !problem) return false;
      vm.setDefaultProblem(problem);
      const targetIndex = Number(problem.index);
      return Utils.poll(() => Number(vm.defaultProblem?.index) === targetIndex && Boolean(document.querySelector('.item-body')), { interval: 300, timeout: 8000 });
    }
    async handleHomework(className) {
      const featureFlags = Store.getFeatureConf();
      if (!featureFlags.autoAI) {
        this.panel.log('已关闭 AI 自动答题，跳过该作业');
        await Utils.sleep(1200);
        return;
      }
      const preferVision = featureFlags.aiVision && Solver.supportsVisionModel(Store.getAIConf().model);
      const ready = await Utils.poll(() => this.getHomeworkProblems().length > 0, { interval: 500, timeout: 15000 });
      if (!ready) {
        this.panel.log(`作业 ${className} 题目未加载完成，已跳过`);
        return;
      }
      const vm = this.getHomeworkVm();
      const problems = this.getHomeworkProblems(vm);
      this.panel.log(`进入作业：${className}，共 ${problems.length} 题，启动 AI 自动答题`);
      for (let i = 0; i < problems.length; i++) {
        const latestProblems = this.getHomeworkProblems(vm);
        const problem = latestProblems[i];
        if (!problem) continue;
        if (this.isHomeworkProblemCompleted(problem)) {
          this.panel.log(`第 ${problem.index} 题已提交，跳过`);
          continue;
        }
        const focused = await this.focusHomeworkProblem(vm, problem);
        if (!focused) {
          this.panel.log(`第 ${problem.index} 题切换失败，跳过`);
          continue;
        }
        const currentProblem = vm.defaultProblem;
        const itemBodyElement = document.querySelector('.item-body');
        if (!currentProblem || !itemBodyElement) {
          this.panel.log(`第 ${problem.index} 题内容未加载完成，跳过`);
          continue;
        }
        const question = await Solver.extractProHomeworkQuestion(currentProblem, itemBodyElement, { preferVision });
        if (!question.options.length) {
          this.panel.log(`第 ${currentProblem.index} 题不是选择/判断题，已跳过`);
          continue;
        }
        try {
          this.panel.log(`🤖 正在解析第 ${currentProblem.index}/${problems.length} 题：${question.type}${preferVision ? '（截图模式）' : ''}`);
          const aiText = await Solver.askQuestion(question, itemBodyElement);
          const answerValues = Solver.parseAnswer(aiText, question.options.map(option => option.key).filter(Boolean));
          if (!answerValues.length) continue;
          const applied = await Solver.applyAnswer(itemBodyElement, answerValues);
          if (!applied) {
            this.panel.log(`第 ${currentProblem.index} 题勾选失败，跳过`);
            continue;
          }
          const beforeCount = currentProblem.user?.my_count || 0;
          await vm.submitProblemNext();
          const submitted = await Utils.poll(() => {
            const latest = this.getHomeworkProblems(vm)[i];
            return (latest?.user?.my_count || 0) > beforeCount
              || Utils.hasValue(latest?.submission_status)
              || Utils.hasValue(latest?.user?.is_right);
          }, { interval: 500, timeout: 15000 });
          if (submitted) {
            this.panel.log(`第 ${currentProblem.index} 题提交完成`);
          } else {
            this.panel.log(`第 ${currentProblem.index} 题提交状态未确认，请人工复核`);
          }
        } catch (err) {
          this.panel.log(`第 ${currentProblem.index} 题 AI 答题失败：${err}`);
          if (Solver.isFatalAIError(err)) {
            this.panel.log('AI 配置或额度异常，已停止当前作业自动答题');
            return;
          }
        }
        await Utils.sleep(1000);
      }
      const remaining = this.getHomeworkProblems(vm).filter(problem => !this.isHomeworkProblemCompleted(problem)).length;
      if (remaining === 0) {
        this.panel.log(`作业 ${className} 已全部处理完毕`);
      } else {
        this.panel.log(`作业 ${className} 仍有 ${remaining} 题未提交，请人工复核`);
      }
    }
    getLessonMeta() {
      const header = document.querySelector('.header-bar')?.firstElementChild;
      return {
        className: header?.innerText?.trim() || '',
        classType: header?.firstElementChild?.getAttribute('class') || '',
        classStatus: document.querySelector('#app > div.app_index-wrapper > div.wrap > div.viewContainer.heightAbsolutely > div > div > div > div > section.title')?.lastElementChild?.innerText || ''
      };
    }
    async waitForLessonReady(previousName = '') {
      const ready = await Utils.poll(() => {
        const { className } = this.getLessonMeta();
        return Boolean(className);
      }, { interval: 500, timeout: 20000 });
      if (!ready) return false;
      if (!previousName) return true;
      return Utils.poll(() => {
        const { className } = this.getLessonMeta();
        return Boolean(className && className !== previousName);
      }, { interval: 500, timeout: 15000 });
    }
    async run() {
      preventScreenCheck();
      let classCount = Store.getProClassCount();
      while (true) {
        Runtime.touch();
        this.panel.log(`准备播放第 ${classCount} 集...`);
        const pageReady = await this.waitForLessonReady();
        if (!pageReady) {
          this.panel.log('课程页面加载超时，准备刷新当前页面后自动续跑');
          location.reload();
          return { handoff: true };
        }
        await Utils.sleep(1500);
        const { className, classType, classStatus } = this.getLessonMeta();
        if (classType.includes('tuwen') && !classStatus.includes('已读')) {
          this.panel.log(`正在阅读：${className}`);
          await Utils.sleep(2000);
        } else if (classType.includes('taolun')) {
          this.panel.log(`讨论区暂不自动发帖，${className}`);
          await Utils.sleep(2000);
        } else if (classType.includes('shipin') && !classStatus.includes('100%')) {
          this.panel.log(`2s 后开始播放：${className}`);
          await Utils.sleep(2000);
          let statusTimer;
          let videoTimer;
          try {
            statusTimer = setInterval(() => {
              const status = document.querySelector('#app > div.app_index-wrapper > div.wrap > div.viewContainer.heightAbsolutely > div > div > div > div > section.title')?.lastElementChild?.innerText || '';
              if (status.includes('100%') || status.includes('99%') || status.includes('98%') || status.includes('已完成')) {
                this.panel.log(`${className} 播放完毕`);
                clearInterval(statusTimer);
                statusTimer = null;
              }
            }, 200);

            const videoWaitStart = Date.now();
            videoTimer = setInterval(() => {
              const video = document.querySelector('video');
              if (video) {
                setTimeout(() => {
                  Player.applySpeed();
                  Player.mute();
                  Player.observePause(video);
                }, 2000);
                clearInterval(videoTimer);
                videoTimer = null;
              } else if (Date.now() - videoWaitStart > 20000) {
                location.reload();
              }
            }, 5000);

            await Utils.sleep(8000);
            await Utils.poll(() => {
              const status = document.querySelector('#app > div.app_index-wrapper > div.wrap > div.viewContainer.heightAbsolutely > div > div > div > div > section.title')?.lastElementChild?.innerText || '';
              return status.includes('100%') || status.includes('99%') || status.includes('98%') || status.includes('已完成');
            }, { interval: 1000, timeout: await Utils.getDDL() });
          } finally {
            if (statusTimer) clearInterval(statusTimer);
            if (videoTimer) clearInterval(videoTimer);
          }
        } else if (classType.includes('zuoye')) {
          await this.handleHomework(className);
        } else if (classType.includes('kaoshi')) {
          this.panel.log(`进入考试：${className}（不会自动答题）`);
          await Utils.sleep(2000);
        } else if (classType.includes('ketang')) {
          this.panel.log(`进入课堂：${className}（暂无自动功能）`);
          await Utils.sleep(2000);
        } else {
          this.panel.log(`已看过：${className}`);
          await Utils.sleep(2000);
        }
        this.panel.log(`第 ${classCount} 集播放完毕`);
        classCount++;
        Store.setProClassCount(classCount);
        Runtime.touch();
        const nextBtn = document.querySelector('.btn-next');
        if (nextBtn) {
          const previousUrl = location.href;
          const previousName = className;
          const event1 = new Event('mousemove', { bubbles: true });
          event1.clientX = 9999;
          event1.clientY = 9999;
          nextBtn.dispatchEvent(event1);
          nextBtn.dispatchEvent(new Event('click'));
          const changed = await Utils.poll(() => {
            if (location.href !== previousUrl) return true;
            const nextMeta = this.getLessonMeta();
            return Boolean(nextMeta.className && nextMeta.className !== previousName);
          }, { interval: 500, timeout: 15000 });
          if (!changed) {
            this.panel.log('下一页未正常加载，准备刷新当前页面后自动续跑');
            location.reload();
            return { handoff: true };
          }
        } else {
          localStorage.removeItem(Config.storageKeys.proClassCount);
          this.panel.log('课程播放完毕 🎉');
          break;
        }
      }
    }
  }

  // ---- 路由 ----
  async function resolveRunner() {
    const url = location.host;
    const path = location.pathname.split('/');
    const matchURL = `${url}${path[0]}/${path[1]}/${path[2]}`;
    panel.log(`正在匹配处理逻辑：${matchURL}`);
    if (matchURL.includes('yuketang.cn/v2/web') || matchURL.includes('gdufemooc.cn/v2/web')) {
      await Utils.poll(() => Boolean(document.querySelector('.logs-list') || document.querySelector('.viewContainer')), { interval: 300, timeout: 15000 });
      return new V2Runner(panel);
    }
    if (matchURL.includes('yuketang.cn/pro/lms') || matchURL.includes('gdufemooc.cn/pro/lms')) {
      await Utils.poll(() => Boolean(document.querySelector('.btn-next') || document.querySelector('.leaf-detail') || document.querySelector('.header-bar')), { interval: 300, timeout: 15000 });
      return document.querySelector('.btn-next') || document.querySelector('.header-bar')
        ? new ProNewRunner(panel)
        : new ProOldRunner(panel);
    }
    panel.resetStartButton('开始刷课');
    panel.log('当前页面非刷课页面，应匹配 */v2/web/* 或 */pro/lms/*');
    return null;
  }

  const App = {
    running: false,
    resumeQueued: false,
    async start({ resume = false } = {}) {
      if (this.running) {
        panel.log('刷课任务已在运行');
        return;
      }
      this.running = true;
      Runtime.start();
      panel.resetStartButton('刷课中...');
      panel.log(resume ? '检测到上一次刷课未完成，正在自动续跑...' : '启动中...');
      try {
        const runner = await resolveRunner();
        if (!runner) {
          Runtime.stop();
          return;
        }
        const result = await runner.run();
        if (result?.handoff) {
          Runtime.markHandoff();
          return;
        }
        Runtime.stop();
        panel.resetStartButton('开始刷课');
      } catch (error) {
        Runtime.stop();
        console.error('脚本运行失败:', error);
        panel.log(`脚本异常：${error?.message || error}`);
        panel.resetStartButton('开始刷课');
      } finally {
        this.running = false;
      }
    },
    scheduleResume() {
      if (this.running || this.resumeQueued || !Runtime.shouldResume() || Runtime.isWaitingOnSamePage()) return;
      this.resumeQueued = true;
      panel.log('检测到页面刷新/跳转，准备恢复刷课...');
      setTimeout(() => {
        this.resumeQueued = false;
        if (Runtime.shouldResume()) this.start({ resume: true });
      }, 1200);
    }
  };

  const RouteWatcher = {
    lastHref: location.href,
    notify() {
      const changed = this.lastHref !== location.href;
      this.lastHref = location.href;
      if (changed || !document.getElementById('ykt-helper-iframe')) {
        panel.ensure();
      }
      if (Runtime.shouldResume()) App.scheduleResume();
    },
    install() {
      ['pushState', 'replaceState'].forEach(method => {
        const original = history[method];
        history[method] = function (...args) {
          const result = original.apply(this, args);
          setTimeout(() => RouteWatcher.notify(), 0);
          return result;
        };
      });
      window.addEventListener('popstate', () => this.notify());
      window.addEventListener('hashchange', () => this.notify());
      setInterval(() => {
        const hrefChanged = location.href !== this.lastHref;
        const panelMissing = !document.getElementById('ykt-helper-iframe');
        if (hrefChanged || panelMissing || Runtime.shouldResume()) {
          this.notify();
        }
      }, 1000);
    }
  };

  // ---- 启动 ----
  if (Utils.inIframe()) return;
  panel = Panel;
  panel.setStartHandler(() => App.start());
  RouteWatcher.install();
  panel.ensure().then(() => {
    if (Runtime.shouldResume()) App.scheduleResume();
  });
  window.addEventListener('pageshow', () => {
    panel.ensure();
    App.scheduleResume();
  });
  document.addEventListener('readystatechange', () => {
    if (document.readyState === 'interactive' || document.readyState === 'complete') {
      panel.ensure();
    }
  });

})();
