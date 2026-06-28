document.addEventListener('DOMContentLoaded', () => {
  const api = window.echo;

  // Sidebar navigation
  document.querySelectorAll('.nav-item[data-tab]').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item[data-tab]').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      item.classList.add('active');
      const content = document.getElementById('tab-' + item.dataset.tab);
      if (content) content.classList.add('active');
    });
  });

  // Load settings
  async function loadSettings() {
    const s = await api.getSettings();
    document.getElementById('hotkey').value = s.hotkey;
    document.getElementById('recordingMode').value = s.recordingMode || 'toggle';
    document.getElementById('llmProvider').value = s.llmProvider;
    document.getElementById('openAtLogin').checked = s.openAtLogin || false;
    const ollamaEndpoint = document.getElementById('ollamaEndpoint');
    const ollamaModel = document.getElementById('ollamaModel');
    if (ollamaEndpoint) ollamaEndpoint.value = s.ollamaEndpoint;
    if (ollamaModel) ollamaModel.value = s.ollamaModel;

    const customPrompt = document.getElementById('customPrompt');
    if (customPrompt) customPrompt.value = s.customPrompt || '';
    const vocabularyList = document.getElementById('vocabularyList');
    if (vocabularyList) vocabularyList.value = s.vocabularyList || '';
    const useWindowContext = document.getElementById('useWindowContext');
    if (useWindowContext) useWindowContext.checked = s.useWindowContext !== false;
    const contextProvider = document.getElementById('contextProvider');
    if (contextProvider) contextProvider.value = s.contextProvider || 'none';
    const claudeApiKey = document.getElementById('claudeApiKey');
    if (claudeApiKey) claudeApiKey.value = s.claudeApiKey || '';
    const startDelay = document.getElementById('startDelay');
    if (startDelay) startDelay.value = s.startDelay || 0;
    const silenceDetection = document.getElementById('silenceDetection');
    if (silenceDetection) silenceDetection.checked = s.silenceDetection !== false;
    const noiseReduction = document.getElementById('noiseReduction');
    if (noiseReduction) noiseReduction.checked = s.noiseReduction !== false;
    const whisperModeEl = document.getElementById('whisperMode');
    if (whisperModeEl) whisperModeEl.checked = s.whisperMode || false;
    const deepgramApiKey = document.getElementById('deepgramApiKey');
    if (deepgramApiKey) deepgramApiKey.value = s.deepgramApiKey || '';
    const openaiApiKey = document.getElementById('openaiApiKey');
    if (openaiApiKey) openaiApiKey.value = s.openaiApiKey || '';
    const transcriptionLanguage = document.getElementById('transcriptionLanguage');
    if (transcriptionLanguage) transcriptionLanguage.value = s.transcriptionLanguage || 'en';
    const claudeApiModel = document.getElementById('claudeApiModel');
    if (claudeApiModel) claudeApiModel.value = s.claudeApiModel || '';
    const openaiApiModel = document.getElementById('openaiApiModel');
    if (openaiApiModel) openaiApiModel.value = s.openaiApiModel || '';
    const groqLlmModel = document.getElementById('groqLlmModel');
    if (groqLlmModel) groqLlmModel.value = s.groqLlmModel || 'llama-3.1-8b-instant';
    const geminiApiKey = document.getElementById('geminiApiKey');
    if (geminiApiKey) geminiApiKey.value = s.geminiApiKey || '';
    const geminiModel = document.getElementById('geminiModel');
    if (geminiModel) geminiModel.value = s.geminiModel || 'gemini-2.0-flash';
    const bedrockAccessKeyId = document.getElementById('bedrockAccessKeyId');
    if (bedrockAccessKeyId) bedrockAccessKeyId.value = s.bedrockAccessKeyId || '';
    const bedrockSecretAccessKey = document.getElementById('bedrockSecretAccessKey');
    if (bedrockSecretAccessKey) bedrockSecretAccessKey.value = s.bedrockSecretAccessKey || '';
    const bedrockRegion = document.getElementById('bedrockRegion');
    if (bedrockRegion) bedrockRegion.value = s.bedrockRegion || 'us-east-1';
    const bedrockModel = document.getElementById('bedrockModel');
    if (bedrockModel) bedrockModel.value = s.bedrockModel || 'anthropic.claude-3-5-haiku-20241022-v1:0';
    const llamaEndpoint = document.getElementById('llamaEndpoint');
    if (llamaEndpoint) llamaEndpoint.value = s.llamaEndpoint || 'http://localhost:8080';
    const llamaModel = document.getElementById('llamaModel');
    if (llamaModel) llamaModel.value = s.llamaModel || 'llama-3.2-3b';
    const voiceCommandsEnabled = document.getElementById('voiceCommandsEnabled');
    if (voiceCommandsEnabled) voiceCommandsEnabled.checked = s.voiceCommandsEnabled !== false;
    const sttEngine = document.getElementById('sttEngine');
    if (sttEngine) sttEngine.value = s.sttEngine || 'groq';
    const groqApiKey = document.getElementById('groqApiKey');
    if (groqApiKey) groqApiKey.value = s.groqApiKey || '';
    const grammarCheck = document.getElementById('grammarCheck');
    if (grammarCheck) grammarCheck.checked = s.grammarCheck !== false;
    const audioDevice = document.getElementById('audioDevice');
    if (audioDevice) audioDevice.value = s.audioDevice || '';
  }

  // Auto-save on change
  ['hotkey', 'recordingMode', 'startDelay', 'llmProvider', 'ollamaEndpoint', 'ollamaModel', 'customPrompt', 'vocabularyList', 'contextProvider', 'claudeApiKey', 'sttEngine', 'groqApiKey', 'audioDevice', 'deepgramApiKey', 'openaiApiKey', 'transcriptionLanguage', 'claudeApiModel', 'openaiApiModel', 'groqLlmModel', 'geminiApiKey', 'geminiModel', 'bedrockAccessKeyId', 'bedrockSecretAccessKey', 'bedrockRegion', 'bedrockModel', 'llamaEndpoint', 'llamaModel'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      const val = el.type === 'number' ? Number(el.value) : el.value;
      api.setSetting(id, val);
    });
    el.addEventListener('blur', () => {
      const val = el.type === 'number' ? Number(el.value) : el.value;
      api.setSetting(id, val);
    });
  });

  // Checkbox settings
  ['openAtLogin', 'useWindowContext', 'grammarCheck', 'silenceDetection', 'noiseReduction', 'whisperMode', 'voiceCommandsEnabled'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', function() {
      api.setSetting(id, this.checked);
    });
  });

  // Whisper model selector
  async function loadWhisperModels() {
    var select = document.getElementById('whisperModelName');
    var section = document.getElementById('whisper-model-section');
    var dlBtn = document.getElementById('download-model-btn');
    var statusEl = document.getElementById('model-download-status');
    var sttEngine = document.getElementById('sttEngine');
    var binaryBadge = document.getElementById('whisper-binary-badge');
    var buildBtn = document.getElementById('build-binary-btn');
    var buildStatus = document.getElementById('build-status');
    if (!select || !section) return;

    // Show/hide based on STT engine
    function toggleSection() {
      section.style.display = sttEngine.value === 'whisper' ? '' : 'none';
    }
    sttEngine.addEventListener('change', function() {
      toggleSection();
      if (sttEngine.value === 'whisper') checkBinary();
    });
    // Set initial value from settings before toggling visibility
    var s0 = await api.getSettings();
    sttEngine.value = s0.sttEngine || 'whisper';
    toggleSection();

    // Check binary status
    async function checkBinary() {
      var status = await api.checkWhisperBinary(select.value);
      if (status.binary) {
        binaryBadge.textContent = 'Installed';
        binaryBadge.className = 'status status-ok';
        buildBtn.style.display = 'none';
        if (buildStatus) buildStatus.style.display = 'none';
      } else {
        binaryBadge.textContent = 'Not found';
        binaryBadge.className = 'status status-error';
        buildBtn.style.display = '';
      }
    }
    checkBinary();

    // Build binary button
    buildBtn.addEventListener('click', async function() {
      buildBtn.disabled = true;
      buildBtn.innerHTML = '<span class="spinner"></span>Building...';
      buildStatus.style.display = '';
      buildStatus.textContent = 'Cloning and compiling whisper.cpp...';
      buildStatus.style.color = '#888';

      var result = await api.buildWhisperBinary();
      if (result.success) {
        buildBtn.style.display = 'none';
        buildStatus.textContent = 'Build complete!';
        buildStatus.style.color = 'var(--success)';
        binaryBadge.textContent = 'Installed';
        binaryBadge.className = 'status status-ok';
        setTimeout(function() { buildStatus.style.display = 'none'; }, 3000);
      } else {
        buildBtn.disabled = false;
        buildBtn.textContent = 'Retry';
        buildStatus.textContent = 'Failed: ' + result.error;
        buildStatus.style.color = 'var(--danger)';
      }
    });

    // Build progress
    api.onBuildProgress(function(message) {
      if (buildStatus) {
        buildStatus.style.display = '';
        buildStatus.textContent = message;
      }
    });

    // Populate models
    var models = await api.listWhisperModels();
    select.innerHTML = '';
    models.forEach(function(m) {
      var opt = document.createElement('option');
      opt.value = m.name;
      opt.textContent = m.label + ' (' + m.size + ')' + (m.downloaded ? ' \u2713' : '');
      select.appendChild(opt);
    });

    // Set current value
    var s = await api.getSettings();
    select.value = s.whisperModelName || 'ggml-base.en.bin';

    // Update download button visibility
    async function updateDlButton() {
      var status = await api.checkWhisperBinary(select.value);
      if (status.model) {
        dlBtn.style.display = 'none';
        statusEl.textContent = 'Model ready';
        statusEl.style.color = 'var(--success)';
      } else {
        dlBtn.style.display = '';
        statusEl.textContent = 'Model not downloaded';
        statusEl.style.color = 'var(--warning)';
      }
    }
    updateDlButton();

    select.addEventListener('change', function() {
      api.setSetting('whisperModelName', select.value);
      updateDlButton();
    });

    // Download button
    dlBtn.addEventListener('click', async function() {
      dlBtn.disabled = true;
      dlBtn.textContent = 'Downloading...';
      statusEl.textContent = 'Starting download...';
      statusEl.style.color = '#888';

      var result = await api.downloadWhisperModel(select.value);
      if (result.success) {
        dlBtn.style.display = 'none';
        statusEl.textContent = 'Downloaded!';
        statusEl.style.color = 'var(--success)';
        updateDlButton();
      } else {
        dlBtn.disabled = false;
        dlBtn.textContent = 'Retry';
        statusEl.textContent = 'Failed: ' + result.error;
        statusEl.style.color = 'var(--danger)';
      }
    });

    // Download progress
    api.onDownloadProgress(function(percent) {
      statusEl.textContent = 'Downloading... ' + percent + '%';
    });
  }

  // Status (no longer rendered in a bar; kept for potential future use)
  async function loadStatus() {
    try {
      await api.getStatus();
    } catch (e) { /* ignore */ }
  }

  // Memory
  async function loadMemory() {
    const entries = await api.getMemory();
    const list = document.getElementById('memory-list');
    if (entries.length === 0) {
      list.innerHTML = '<div class="empty-state">No vocabulary entries yet</div>';
      return;
    }
    list.innerHTML = '';
    entries.forEach(e => {
      const item = document.createElement('div');
      item.className = 'list-item';

      const info = document.createElement('div');
      const termSpan = document.createElement('span');
      termSpan.className = 'term';
      termSpan.textContent = e.term;
      info.appendChild(termSpan);
      const contextSpan = document.createElement('span');
      contextSpan.className = 'context';
      contextSpan.textContent = ' \u2014 ' + e.context;
      info.appendChild(contextSpan);
      if (e.misrecognitions.length) {
        const br = document.createElement('br');
        info.appendChild(br);
        const mis = document.createElement('span');
        mis.className = 'misrec';
        mis.textContent = '\u2260 ' + e.misrecognitions.join(', ');
        info.appendChild(mis);
      }

      const btn = document.createElement('button');
      btn.className = 'remove-btn';
      btn.textContent = '\u2715';
      btn.addEventListener('click', async () => {
        await api.removeMemory(e.id);
        loadMemory();
      });

      item.appendChild(info);
      item.appendChild(btn);
      list.appendChild(item);
    });
  }

  // Add memory
  var addMemoryBtn = document.getElementById('add-memory-btn');
  if (addMemoryBtn) addMemoryBtn.addEventListener('click', async () => {
    const term = document.getElementById('mem-term').value.trim();
    const context = document.getElementById('mem-context').value.trim();
    const misrec = document.getElementById('mem-misrec').value.trim();
    const category = document.getElementById('mem-category').value;
    if (!term) return;

    await api.addMemory({
      term,
      context,
      misrecognitions: misrec ? misrec.split(',').map(s => s.trim()) : [],
      category,
    });

    document.getElementById('mem-term').value = '';
    document.getElementById('mem-context').value = '';
    document.getElementById('mem-misrec').value = '';
    loadMemory();
  });

  // Project context
  async function loadProjectContext() {
    const result = await api.getProjectContext();
    const preview = document.getElementById('context-preview');
    const empty = document.getElementById('context-empty');
    if (!preview) return;
    if (result.hasContext && result.context) {
      preview.textContent = result.context;
      preview.style.display = 'block';
      if (empty) empty.style.display = 'none';
    } else {
      preview.textContent = '';
      preview.style.display = 'none';
      if (empty) empty.style.display = 'block';
    }
  }

  // Browse folder button
  var browseBtn = document.getElementById('browse-btn');
  if (browseBtn) browseBtn.addEventListener('click', async () => {
    const folder = await api.browseFolder();
    if (folder) {
      document.getElementById('project-path').value = folder;
    }
  });

  // Stream scan output into the context preview in real-time
  api.onScanStream(function(text) {
    var preview = document.getElementById('context-preview');
    if (!preview) return;
    preview.textContent = text;
    preview.style.display = 'block';
    preview.scrollTop = preview.scrollHeight;
  });

  var scanBtnEl = document.getElementById('scan-btn');
  if (scanBtnEl) scanBtnEl.addEventListener('click', async () => {
    const projectPath = document.getElementById('project-path').value.trim();
    const statusEl = document.getElementById('scan-status');

    if (!projectPath) {
      statusEl.textContent = 'Please select a project folder';
      statusEl.style.color = 'var(--danger)';
      return;
    }

    // Auto-derive project name from folder basename
    const projectName = projectPath.split('/').filter(Boolean).pop() || 'project';

    statusEl.textContent = 'Scanning with Claude... streaming output below';
    statusEl.style.color = 'var(--warning)';
    var scanBtn = document.getElementById('scan-btn');
    scanBtn.disabled = true;
    scanBtn.innerHTML = '<span class="spinner"></span>Scanning...';

    // Clear and show preview for streaming
    var preview = document.getElementById('context-preview');
    preview.textContent = '';
    preview.style.display = 'block';

    const result = await api.scanProject(projectPath, projectName);

    if (result.success) {
      statusEl.textContent = 'Context generated for "' + projectName + '"! (' + result.length + ' chars)';
      statusEl.style.color = 'var(--success)';
      loadProjectContext();
    } else {
      statusEl.textContent = 'Error: ' + result.error;
      statusEl.style.color = 'var(--danger)';
    }

    scanBtn.disabled = false;
    scanBtn.textContent = 'Scan Project';
  });

  // Audio devices
  async function loadAudioDevices() {
    const select = document.getElementById('audioDevice');
    if (!select) return;
    try {
      const devices = await api.listAudioDevices();
      // Keep "System Default" option, add discovered devices
      devices.forEach(function(d) {
        var opt = document.createElement('option');
        opt.value = d;
        opt.textContent = d;
        select.appendChild(opt);
      });
      // Restore saved value
      var s = await api.getSettings();
      if (s.audioDevice) select.value = s.audioDevice;
    } catch (e) { /* ignore */ }
  }

  // Groq API key validation
  var validateBtn = document.getElementById('validate-groq-btn');
  if (validateBtn) {
    validateBtn.addEventListener('click', async function() {
      var statusEl = document.getElementById('groq-validation-status');
      var key = document.getElementById('groqApiKey').value.trim();
      if (!key) {
        statusEl.textContent = 'Enter an API key first';
        statusEl.style.color = 'var(--warning)';
        return;
      }
      statusEl.textContent = 'Validating...';
      statusEl.style.color = 'var(--text-muted)';
      var result = await api.validateGroqKey(key);
      if (result.valid) {
        statusEl.textContent = 'API key is valid';
        statusEl.style.color = 'var(--success)';
      } else {
        statusEl.textContent = 'Invalid: ' + (result.error || 'unknown error');
        statusEl.style.color = 'var(--danger)';
      }
    });
  }

  // Prompt staleness check
  async function checkPromptStaleness() {
    try {
      var result = await api.checkPromptStaleness();
      var warning = document.getElementById('prompt-staleness-warning');
      if (warning) {
        warning.style.display = result.stale ? 'block' : 'none';
      }
    } catch (e) { /* ignore */ }
  }

  // Track custom prompt date when user edits it
  var promptEl = document.getElementById('customPrompt');
  if (promptEl) {
    promptEl.addEventListener('blur', function() {
      if (promptEl.value.trim()) {
        api.setSetting('customPromptDate', new Date().toISOString().split('T')[0]);
      } else {
        api.setSetting('customPromptDate', '');
      }
    });
  }

  // Run log / history
  async function loadHistory() {
    var list = document.getElementById('history-list');
    if (!list) return;
    try {
      var entries = await api.getRunLog();
      renderHistory(entries);
    } catch (e) {
      list.innerHTML = '<div style="color:#FF3B30">Failed to load history</div>';
    }
  }

  var clearHistoryBtn = document.getElementById('clear-history-btn');
  if (clearHistoryBtn) clearHistoryBtn.addEventListener('click', async function() {
    try {
      await api.clearRunLog();
      loadHistory();
    } catch (e) { /* ignore clear failure */ }
  });

  // History search
  var historySearch = document.getElementById('history-search');
  if (historySearch) {
    historySearch.addEventListener('input', async function() {
      var query = historySearch.value.trim();
      if (query) {
        var results = await api.searchRunLog(query);
        renderHistory(results);
      } else {
        loadHistory();
      }
    });
  }

  function renderHistory(entries) {
    var list = document.getElementById('history-list');
    if (!list) return;
    if (!entries || entries.length === 0) {
      list.innerHTML = '<div class="empty-state">No runs found</div>';
      return;
    }
    list.innerHTML = '';
    entries.forEach(function(e) {
      var item = document.createElement('div');
      item.className = 'history-item';

      var time = new Date(e.timestamp).toLocaleString();
      var duration = (e.durationMs / 1000).toFixed(1) + 's';
      var header = '<div class="meta">' +
        '<span>' + time + '</span>' +
        '<span>' + e.sttEngine + ' / ' + e.llmProvider + ' / ' + duration + '</span>' +
        '</div>';

      var body = '';
      if (e.error) {
        body = '<div class="error">Error: ' + escapeHtml(e.error.substring(0, 200)) + '</div>';
      } else {
        body = '<div class="raw">Raw: ' +
          escapeHtml((e.rawTranscription || '').substring(0, 100)) + '</div>' +
          '<div class="refined">Refined: ' +
          escapeHtml((e.refinedText || '').substring(0, 200)) + '</div>';
      }

      item.innerHTML = header + body;

      if (e.refinedText && !e.error) {
        var reinsertBtn = document.createElement('button');
        reinsertBtn.className = 'btn-secondary';
        reinsertBtn.style.cssText = 'font-size:12px;margin-top:8px;padding:5px 10px';
        reinsertBtn.textContent = 'Re-insert';
        reinsertBtn.addEventListener('click', function() {
          api.reinsertFromHistory(e.refinedText);
        });
        item.appendChild(reinsertBtn);
      }

      list.appendChild(item);
    });
  }

  // Templates
  async function loadTemplates() {
    var list = document.getElementById('template-list');
    if (!list) return;
    var templates = await api.getTemplates();
    if (!templates.length) {
      list.innerHTML = '<div class="empty-state">No templates yet</div>';
      return;
    }
    list.innerHTML = '';
    templates.forEach(function(t) {
      var item = document.createElement('div');
      item.className = 'list-item';
      item.innerHTML = '<div><span class="term">' + escapeHtml(t.name) + '</span> <span class="context">\u2014 trigger: "' + escapeHtml(t.trigger) + '"</span></div>';
      var btn = document.createElement('button');
      btn.className = 'remove-btn';
      btn.textContent = '\u2715';
      btn.addEventListener('click', async function() {
        await api.removeTemplate(t.id);
        loadTemplates();
      });
      item.appendChild(btn);
      list.appendChild(item);
    });
  }

  var addTemplateBtn = document.getElementById('add-template-btn');
  if (addTemplateBtn) {
    addTemplateBtn.addEventListener('click', async function() {
      var name = document.getElementById('tpl-name').value.trim();
      var trigger = document.getElementById('tpl-trigger').value.trim();
      var content = document.getElementById('tpl-content').value.trim();
      if (!name || !trigger || !content) return;
      await api.addTemplate({ name: name, trigger: trigger, content: content });
      document.getElementById('tpl-name').value = '';
      document.getElementById('tpl-trigger').value = '';
      document.getElementById('tpl-content').value = '';
      loadTemplates();
    });
  }

  // Provider health
  async function loadProviderHealth() {
    var list = document.getElementById('provider-status-list');
    if (!list) return;
    try {
      var providers = await api.checkProviders();
      list.innerHTML = providers.map(function(p) {
        var cls = p.ok ? 'status-ok' : 'status-error';
        return '<div style="margin-bottom:6px"><span class="status ' + cls + '">' + p.label + '</span> <span style="margin-left:6px">' + p.message + '</span></div>';
      }).join('');
    } catch (e) {
      list.textContent = 'Failed to check providers';
    }
  }

  // Copy logs
  var copyLogsBtn = document.getElementById('copy-logs-btn');
  if (copyLogsBtn) {
    copyLogsBtn.addEventListener('click', async function() {
      var result = await api.copyLogs();
      var status = document.getElementById('copy-logs-status');
      if (status) {
        status.textContent = result.success ? 'Copied!' : 'Failed';
        status.style.color = result.success ? 'var(--success)' : 'var(--danger)';
        if (result.success) setTimeout(function() { status.textContent = ''; }, 2000);
      }
    });
  }

  // Deepgram validation
  var validateDgBtn = document.getElementById('validate-deepgram-btn');
  if (validateDgBtn) {
    validateDgBtn.addEventListener('click', async function() {
      var statusEl = document.getElementById('deepgram-validation-status');
      var key = document.getElementById('deepgramApiKey').value.trim();
      if (!key) { statusEl.textContent = 'Enter an API key first'; statusEl.style.color = 'var(--warning)'; return; }
      statusEl.textContent = 'Validating...';
      statusEl.style.color = 'var(--text-muted)';
      var result = await api.validateDeepgramKey(key);
      statusEl.textContent = result.valid ? 'API key is valid' : 'Invalid: ' + (result.error || '');
      statusEl.style.color = result.valid ? 'var(--success)' : 'var(--danger)';
    });
  }

  // OpenAI validation
  var validateOaiBtn = document.getElementById('validate-openai-btn');
  if (validateOaiBtn) {
    validateOaiBtn.addEventListener('click', async function() {
      var statusEl = document.getElementById('openai-validation-status');
      var key = document.getElementById('openaiApiKey').value.trim();
      if (!key) { statusEl.textContent = 'Enter an API key first'; statusEl.style.color = 'var(--warning)'; return; }
      statusEl.textContent = 'Validating...';
      statusEl.style.color = 'var(--text-muted)';
      var result = await api.validateOpenaiKey(key);
      statusEl.textContent = result.valid ? 'API key is valid' : 'Invalid: ' + (result.error || '');
      statusEl.style.color = result.valid ? 'var(--success)' : 'var(--danger)';
    });
  }

  // Home
  function setText(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  function formatHotkey(hk) {
    if (!hk) return '⌘⇧V';
    return hk
      .replace(/CommandOrControl|Command|Cmd|Meta/g, '⌘')
      .replace(/Control|Ctrl/g, '⌃')
      .replace(/Shift/g, '⇧')
      .replace(/Alt|Option/g, '⌥')
      .replace(/\+/g, '');
  }

  async function loadHome() {
    try {
      var greet = document.getElementById('home-greeting');
      if (greet) {
        var h = new Date().getHours();
        greet.textContent = 'Good ' + (h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening');
      }
      var s = await api.getSettings();
      setText('home-hotkey', formatHotkey(s.hotkey));

      var stats = await api.getStats();
      setText('home-total', (stats.totalWordsDictated || 0).toLocaleString());
      setText('home-wpm', stats.avgWordsPerMinute > 0 ? stats.avgWordsPerMinute : '—');
      setText('home-streak', (stats.currentStreak || 0) + 'd');

      var recent = document.getElementById('home-recent');
      if (recent) {
        if (!stats.recentDictations || stats.recentDictations.length === 0) {
          recent.innerHTML = '<div class="empty-state">Hold the hotkey and start talking — your dictations show up here.</div>';
        } else {
          recent.innerHTML = stats.recentDictations.slice(0, 5).map(function(d) {
            return '<div class="recent-item">' +
              '<span class="recent-time">' + d.time + '</span>' +
              '<span class="recent-text">' + escapeHtml(d.text) + '</span>' +
            '</div>';
          }).join('');
        }
      }
    } catch (e) { /* ignore */ }
  }

  // Stats / Insights
  async function loadStats() {
    try {
      var stats = await api.getStats();
      renderStats(stats);
    } catch (e) {
      console.warn('Failed to load stats:', e);
    }
  }

  function renderStats(stats) {
    // WPM with comparison to typing speed
    var wpmEl = document.getElementById('stat-wpm');
    if (wpmEl) wpmEl.textContent = stats.avgWordsPerMinute || '—';
    var speedupEl = document.getElementById('stat-wpm-speedup');
    if (speedupEl) {
      if (stats.wpmSpeedup > 1) {
        speedupEl.textContent = stats.wpmSpeedup + 'x faster than typing';
        speedupEl.style.display = '';
      } else if (stats.avgWordsPerMinute > 0) {
        speedupEl.textContent = 'vs 40 wpm avg typing';
        speedupEl.style.color = 'var(--text-muted)';
        speedupEl.style.display = '';
      } else {
        speedupEl.style.display = 'none';
      }
    }
    var gaugeEl = document.getElementById('stat-wpm-gauge');
    if (gaugeEl) {
      if (stats.avgWordsPerMinute > 0) {
        var maxWpm = Math.max(stats.avgWordsPerMinute, 200);
        var userPct = Math.min((stats.avgWordsPerMinute / maxWpm) * 100, 100);
        var typingPct = (40 / maxWpm) * 100;
        gaugeEl.innerHTML = '<div class="stat-gauge-fill" style="width:' + userPct + '%"></div>' +
          '<div class="stat-gauge-marker" style="left:' + typingPct + '%"></div>';
      } else {
        gaugeEl.innerHTML = '<div class="stat-gauge-fill" style="width:0%"></div>';
      }
    }
    var wpmLabel = document.getElementById('stat-wpm-value-label');
    if (wpmLabel && stats.avgWordsPerMinute > 0) {
      wpmLabel.textContent = 'You (' + stats.avgWordsPerMinute + ')';
    }

    // Corrections
    var corrEl = document.getElementById('stat-corrections');
    if (corrEl) corrEl.textContent = stats.totalCorrections.toLocaleString();
    var corrDetailEl = document.getElementById('stat-corrections-detail');
    if (corrDetailEl) {
      corrDetailEl.textContent = stats.totalDictations + ' total dictations';
    }

    // Total words
    var totalEl = document.getElementById('stat-total-words');
    if (totalEl) totalEl.textContent = stats.totalWordsDictated.toLocaleString();
    var growthEl = document.getElementById('stat-growth-badge');
    if (growthEl) {
      if (stats.monthGrowthPercent !== 0) {
        var sign = stats.monthGrowthPercent > 0 ? '+' : '';
        growthEl.textContent = sign + stats.monthGrowthPercent + '% this month';
        growthEl.style.display = '';
      } else {
        growthEl.style.display = 'none';
      }
    }

    // App usage
    var appList = document.getElementById('stats-app-usage');
    if (appList) {
      var appsWithData = stats.topApps.filter(function(a) { return a.app !== 'Other'; });
      if (appsWithData.length === 0 && stats.topApps.length > 0) {
        appList.innerHTML = '<div class="empty-state" style="text-align:left;padding:8px 0">' +
          '<div style="color:var(--text-secondary);font-size:13px;margin-bottom:4px">App tracking active</div>' +
          '<div style="color:var(--text-muted);font-size:12px">Your next dictations will show which apps you use — Cursor, Slack, Mail, Docs, etc.</div>' +
          '</div>';
      } else if (stats.topApps.length === 0) {
        appList.innerHTML = '<div class="empty-state">No data yet</div>';
      } else {
        appList.innerHTML = stats.topApps.map(function(a) {
          var icon = getAppIcon(a.app);
          return '<div class="app-usage-item">' +
            '<div class="app-usage-icon">' + icon + '</div>' +
            '<div class="app-usage-bar-wrap">' +
              '<span class="app-usage-name">' + escapeHtml(a.app) + '</span>' +
              '<div class="app-usage-bar"><div class="app-usage-bar-fill" style="width:' + a.percent + '%">' + a.percent + '%</div></div>' +
            '</div>' +
            '<span class="app-usage-count">' + a.count + '</span>' +
          '</div>';
        }).join('');
      }
    }

    // Streak
    var streakVal = document.getElementById('stats-streak-value');
    if (streakVal) streakVal.textContent = stats.currentStreak;
    var longestEl = document.getElementById('stats-streak-longest');
    if (longestEl) longestEl.textContent = 'LONGEST: ' + stats.longestStreak;

    // Heatmap (GitHub-style: Y = days of week, X = weeks/months)
    var heatmap = document.getElementById('stats-heatmap');
    if (heatmap && stats.dailyActivity) {
      var maxCount = Math.max(1, Math.max.apply(null, stats.dailyActivity.map(function(d) { return d.count; })));

      // Build a map of date -> count
      var dateMap = {};
      stats.dailyActivity.forEach(function(d) { dateMap[d.date] = d.count; });

      // Determine the range: last ~16 weeks ending on today
      var today = new Date();
      today.setHours(0, 0, 0, 0);
      var dayOfWeek = today.getDay(); // 0=Sun
      var endDate = new Date(today);
      var startDate = new Date(today);
      startDate.setDate(startDate.getDate() - (16 * 7) - dayOfWeek);

      // Build weeks array (columns), each with 7 days (rows: Sun-Sat)
      var weeks = [];
      var currentDate = new Date(startDate);
      var currentWeek = [];
      while (currentDate <= endDate) {
        var dateStr = currentDate.toISOString().split('T')[0];
        var count = dateMap[dateStr] || 0;
        var level = 0;
        if (count > 0) {
          var ratio = count / maxCount;
          if (ratio <= 0.25) level = 1;
          else if (ratio <= 0.5) level = 2;
          else if (ratio <= 0.75) level = 3;
          else level = 4;
        }
        currentWeek.push({ date: dateStr, count: count, level: level, dayOfWeek: currentDate.getDay() });
        if (currentDate.getDay() === 6) {
          weeks.push(currentWeek);
          currentWeek = [];
        }
        currentDate.setDate(currentDate.getDate() + 1);
      }
      if (currentWeek.length > 0) weeks.push(currentWeek);

      // Find month labels (first week of each month)
      var monthLabels = [];
      var lastMonth = -1;
      var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      weeks.forEach(function(week, wi) {
        var firstDay = week[0];
        var m = parseInt(firstDay.date.split('-')[1], 10) - 1;
        if (m !== lastMonth) {
          monthLabels.push({ index: wi, label: months[m] });
          lastMonth = m;
        }
      });

      // Render
      var dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      var html = '<div class="heatmap-container">';

      // Month labels row
      html += '<div class="heatmap-months"><div class="heatmap-day-label"></div>';
      var monthPositions = {};
      monthLabels.forEach(function(ml) { monthPositions[ml.index] = ml.label; });
      for (var wi = 0; wi < weeks.length; wi++) {
        html += '<div class="heatmap-month-label">' + (monthPositions[wi] || '') + '</div>';
      }
      html += '</div>';

      // Grid rows (one per day of week)
      for (var row = 0; row < 7; row++) {
        html += '<div class="heatmap-row">';
        html += '<div class="heatmap-day-label">' + dayLabels[row] + '</div>';
        for (var col = 0; col < weeks.length; col++) {
          var cell = weeks[col][row];
          if (cell) {
            var isFuture = cell.date > today.toISOString().split('T')[0];
            html += '<div class="heatmap-cell' + (isFuture ? '' : ' level-' + cell.level) + '" title="' + cell.date + ': ' + cell.count + ' dictations"></div>';
          } else {
            html += '<div class="heatmap-cell"></div>';
          }
        }
        html += '</div>';
      }

      html += '</div>';
      heatmap.innerHTML = html;
    }

    // Recent dictations
    var recentList = document.getElementById('stats-recent-list');
    if (recentList) {
      if (stats.recentDictations.length === 0) {
        recentList.innerHTML = '<div class="empty-state">Start dictating to see your history here</div>';
      } else {
        recentList.innerHTML = stats.recentDictations.map(function(d) {
          return '<div class="recent-item">' +
            '<span class="recent-time">' + d.time + '</span>' +
            '<span class="recent-text">' + escapeHtml(d.text) + '</span>' +
          '</div>';
        }).join('');
      }
    }
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function getAppIcon(appName) {
    var name = (appName || '').toLowerCase();
    if (name.includes('cursor')) return '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect width="16" height="16" rx="3" fill="#1a1a1a"/><path d="M4 4l8 4-8 4V4z" fill="white"/></svg>';
    if (name.includes('slack')) return '<svg width="14" height="14" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#4A154B"/><path d="M6 3a1 1 0 112 0v3H6V3zm-3 4a1 1 0 010-2h3v2H3zm7-2a1 1 0 112 0v2h-2V5zm3 3a1 1 0 010 2h-2V8h2zM8 13a1 1 0 11-2 0v-2h2v2zm3-3a1 1 0 010 2H8v-2h3zm-5 0v2a1 1 0 11-2 0v-2h2zm-3-3a1 1 0 010-2h2v2H3z" fill="white"/></svg>';
    if (name.includes('mail') || name.includes('outlook') || name.includes('gmail')) return '<svg width="14" height="14" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#4285F4"/><path d="M3 5l5 3 5-3v7H3V5z" fill="white" opacity="0.9"/><path d="M3 5l5 3 5-3" stroke="white" stroke-width="1" fill="none"/></svg>';
    if (name.includes('chrome') || name.includes('safari') || name.includes('firefox') || name.includes('arc')) return '<svg width="14" height="14" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#4A90D9"/><circle cx="8" cy="8" r="4" stroke="white" stroke-width="1.5" fill="none"/><circle cx="8" cy="8" r="1.5" fill="white"/></svg>';
    if (name.includes('notion')) return '<svg width="14" height="14" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#000"/><path d="M4 4h8v8H4z" fill="white" opacity="0.9"/><path d="M6 6v4M8 6v4M10 6v4" stroke="#000" stroke-width="0.8"/></svg>';
    if (name.includes('terminal') || name.includes('iterm') || name.includes('warp')) return '<svg width="14" height="14" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#1a1a1a"/><path d="M5 5l3 3-3 3M9 11h3" stroke="#4AF626" stroke-width="1.5" stroke-linecap="round"/></svg>';
    if (name.includes('docs') || name.includes('pages') || name.includes('word')) return '<svg width="14" height="14" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#4285F4"/><path d="M5 5h6M5 7.5h6M5 10h4" stroke="white" stroke-width="1.2" stroke-linecap="round"/></svg>';
    if (name.includes('figma')) return '<svg width="14" height="14" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#1E1E1E"/><circle cx="6" cy="5" r="2" fill="#F24E1E"/><circle cx="10" cy="5" r="2" fill="#FF7262"/><circle cx="6" cy="8" r="2" fill="#A259FF"/><circle cx="10" cy="8" r="2" fill="#1ABCFE"/><circle cx="6" cy="11" r="2" fill="#0ACF83"/></svg>';
    if (name.includes('messages') || name.includes('whatsapp') || name.includes('telegram')) return '<svg width="14" height="14" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#34C759"/><path d="M4 11l1-3a4 4 0 114 4l-3 1 -2-2z" fill="white" opacity="0.9"/></svg>';
    return (appName || '?')[0].toUpperCase();
  }

  // Permissions (Microphone + Accessibility + Input Monitoring)
  function renderPerm(badgeId, btnId, state) {
    var badge = document.getElementById(badgeId);
    if (badge) {
      badge.textContent = state.label;
      badge.className = 'status ' + state.cls;
    }
    var btn = document.getElementById(btnId);
    if (btn) {
      btn.style.display = state.showFix ? '' : 'none';
      if (state.fixLabel) btn.textContent = state.fixLabel;
    }
  }

  async function loadPermissions() {
    try {
      var s = await api.getStatus();

      // Microphone — Electron reports the precise TCC status; Tauri may report "unknown".
      var mic = s.microphone || { ok: false, status: 'unknown' };
      if (mic.ok) {
        renderPerm('perm-mic', 'perm-fix-mic', { label: 'Granted', cls: 'status-ok', showFix: false });
      } else if (mic.status === 'not-determined') {
        renderPerm('perm-mic', 'perm-fix-mic', { label: 'Not requested', cls: 'status-warn', showFix: true, fixLabel: 'Grant' });
      } else if (mic.status === 'unknown') {
        renderPerm('perm-mic', 'perm-fix-mic', { label: 'Unknown', cls: 'status-warn', showFix: true, fixLabel: 'Open' });
      } else {
        renderPerm('perm-mic', 'perm-fix-mic', { label: 'Not granted', cls: 'status-error', showFix: true, fixLabel: 'Open' });
      }

      // Accessibility
      var axOk = !!(s.accessibility && s.accessibility.ok);
      renderPerm('perm-ax', 'perm-fix-ax', axOk
        ? { label: 'Granted', cls: 'status-ok', showFix: false }
        : { label: 'Not granted', cls: 'status-error', showFix: true, fixLabel: 'Open' });

      // Input Monitoring
      var im = s.inputMonitoring || { ok: false, status: 'unknown' };
      if (im.ok) {
        renderPerm('perm-input', 'perm-fix-input', { label: 'Granted', cls: 'status-ok', showFix: false });
      } else if (im.status === 'unknown') {
        renderPerm('perm-input', 'perm-fix-input', { label: 'Unknown', cls: 'status-warn', showFix: true, fixLabel: 'Open' });
      } else {
        renderPerm('perm-input', 'perm-fix-input', { label: 'Not granted', cls: 'status-error', showFix: true, fixLabel: 'Open' });
      }

      var hint = document.getElementById('perm-hint');
      if (hint) hint.style.display = (mic.ok && axOk && im.ok) ? 'none' : 'block';
    } catch (e) { /* ignore */ }
  }

  var permFixMic = document.getElementById('perm-fix-mic');
  if (permFixMic) permFixMic.addEventListener('click', async function() {
    if (api.openMicrophoneSettings) { try { await api.openMicrophoneSettings(); } catch (e) { /* ignore */ } }
    // Re-check shortly after — covers both the native prompt and returning from System Settings.
    setTimeout(loadPermissions, 800);
  });
  var permFixAx = document.getElementById('perm-fix-ax');
  if (permFixAx) permFixAx.addEventListener('click', function() { api.openAccessibilitySettings(); });
  var permFixInput = document.getElementById('perm-fix-input');
  if (permFixInput) permFixInput.addEventListener('click', function() { if (api.openInputMonitoringSettings) api.openInputMonitoringSettings(); });
  // Re-check when the window regains focus (e.g. after granting in System Settings)
  window.addEventListener('focus', loadPermissions);

  // Init
  loadHome();
  loadPermissions();
  loadSettings();
  loadStatus();
  loadMemory();
  loadProjectContext();
  loadAudioDevices();
  loadWhisperModels();
  checkPromptStaleness();
  loadHistory();
  loadTemplates();
  loadProviderHealth();
  loadStats();
});
