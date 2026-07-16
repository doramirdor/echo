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
    const captureScreenshots = document.getElementById('captureScreenshots');
    if (captureScreenshots) captureScreenshots.checked = s.captureScreenshots || false;
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
    if (groqLlmModel) groqLlmModel.value = s.groqLlmModel || 'llama-3.3-70b-versatile';
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
    const refinementEnabled = document.getElementById('refinementEnabled');
    if (refinementEnabled) refinementEnabled.checked = s.refinementEnabled !== false;
    const grammarCheck = document.getElementById('grammarCheck');
    if (grammarCheck) grammarCheck.checked = s.grammarCheck !== false;
    const autoFormatContent = document.getElementById('autoFormatContent');
    if (autoFormatContent) autoFormatContent.checked = s.autoFormatContent !== false;
    const learnFromEdits = document.getElementById('learnFromEdits');
    if (learnFromEdits) learnFromEdits.checked = s.learnFromEdits !== false;
    const audioDevice = document.getElementById('audioDevice');
    if (audioDevice) audioDevice.value = s.audioDevice || '';
    const dictationHistoryContext = document.getElementById('dictationHistoryContext');
    if (dictationHistoryContext) dictationHistoryContext.value = s.dictationHistoryContext != null ? s.dictationHistoryContext : 2;
    HOTKEY_KEYS.forEach(k => {
      if (document.getElementById(k)) lastGoodHotkeys[k] = s[k] || '';
    });
    currentSettings = s;
    syncSharedKeyInputs();
    updateRefinementDependents();
    updateSttFields();
    updateRefinerFields();
    renderSttSummary();
    renderRefinerSummary();
    renderPromptReadout();
  }

  // Last-loaded settings, so Edit panels can be (re)populated and the read-only
  // summaries can be rendered without another round-trip.
  let currentSettings = {};

  // Shared API keys appear in two places (STT tab + Refinement tab) under
  // different element ids that all write the same setting. Mirror the canonical
  // value into every [data-setting] twin so both views stay in sync.
  function syncSharedKeyInputs() {
    document.querySelectorAll('[data-setting]').forEach(function(el) {
      const key = el.getAttribute('data-setting');
      if (currentSettings[key] != null) el.value = currentSettings[key];
    });
  }

  // Human-readable engine labels for the read-only summaries.
  const STT_ENGINE_LABELS = {
    whisper: 'Whisper (on-device)',
    macos: 'macOS Speech Recognition',
    groq: 'Groq (cloud)',
    deepgram: 'Deepgram (cloud)',
    'openai-whisper': 'OpenAI Whisper (cloud)',
  };
  const LLM_PROVIDER_LABELS = {
    'claude-cli': 'Claude CLI',
    'codex-cli': 'Codex CLI',
    'openai-api': 'OpenAI API',
    'claude-api': 'Anthropic API (Claude)',
    gemini: 'Google Gemini',
    bedrock: 'AWS Bedrock',
    ollama: 'Ollama (local)',
    groq: 'Groq API',
    'llama-local': 'Llama.cpp (local)',
    none: 'None (raw transcript)',
  };

  // Show only the field group(s) that match the currently-selected engine
  // inside an Edit panel, driven by the data-*-fields attribute.
  function showFieldsFor(attr, value) {
    document.querySelectorAll('[' + attr + ']').forEach(function(group) {
      const matches = group.getAttribute(attr).split(/\s+/);
      group.style.display = matches.indexOf(value) === -1 ? 'none' : '';
    });
  }
  function updateSttFields() {
    const sel = document.getElementById('sttEngine');
    if (sel) showFieldsFor('data-stt-fields', sel.value);
  }
  function updateRefinerFields() {
    const sel = document.getElementById('llmProvider');
    if (sel) showFieldsFor('data-refiner-fields', sel.value);
  }

  function setText(id, text, muted) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('muted', !!muted);
  }
  function showRow(id, show) {
    const el = document.getElementById(id);
    if (el) el.style.display = show ? '' : 'none';
  }

  function renderSttSummary() {
    const s = currentSettings;
    const engine = s.sttEngine || 'whisper';
    setText('stt-summary-engine', STT_ENGINE_LABELS[engine] || engine);
    let label = 'Detail', detail = '', muted = true;
    if (engine === 'whisper') {
      label = 'Model'; detail = s.whisperModelName || 'ggml-base.en.bin'; muted = false;
    } else if (engine === 'macos') {
      label = 'Runs'; detail = 'On-device, no key';
    } else {
      const key = engine === 'deepgram' ? s.deepgramApiKey
        : engine === 'openai-whisper' ? s.openaiApiKey : s.groqApiKey;
      label = 'API key'; detail = key ? 'Set' : 'Not set'; muted = !key;
    }
    const detailLabel = document.getElementById('stt-summary-detail-label');
    if (detailLabel) detailLabel.textContent = label;
    setText('stt-summary-detail', detail, muted);
  }

  function renderRefinerSummary() {
    const s = currentSettings;
    const p = s.llmProvider || 'claude-cli';
    setText('refiner-summary-engine', LLM_PROVIDER_LABELS[p] || p);
    let label = 'Model', detail = '', muted = false, show = true;
    if (p === 'openai-api') detail = s.openaiApiModel || 'gpt-4o-mini';
    else if (p === 'claude-api') detail = s.claudeApiModel || 'claude-sonnet-4-20250514';
    else if (p === 'groq') detail = s.groqLlmModel || 'llama-3.3-70b-versatile';
    else if (p === 'gemini') detail = s.geminiModel || 'gemini-2.0-flash';
    else if (p === 'bedrock') detail = s.bedrockModel || '—';
    else if (p === 'ollama') detail = s.ollamaModel || '—';
    else if (p === 'llama-local') detail = s.llamaModel || '—';
    else if (p === 'claude-cli' || p === 'codex-cli') { label = 'Auth'; detail = 'CLI login'; muted = true; }
    else { show = false; }
    showRow('refiner-summary-detail-row', show);
    if (show) {
      const detailLabel = document.getElementById('refiner-summary-detail-label');
      if (detailLabel) detailLabel.textContent = label;
      setText('refiner-summary-detail', detail, muted);
    }
  }

  function renderPromptReadout() {
    const el = document.getElementById('prompt-readout');
    if (!el) return;
    const custom = (currentSettings.customPrompt || '').trim();
    if (custom) {
      el.textContent = custom;
      el.classList.remove('muted');
    } else {
      el.textContent = 'Using the built-in default prompt.';
      el.classList.add('muted');
    }
  }

  // Generic Edit / Save / Cancel wiring for a summary+edit card. On Save it
  // writes every input/select/textarea in the edit panel (keyed by data-setting
  // or id) through the settings bridge, then re-renders the summary.
  function setupEditableCard(opts) {
    const editBtn = document.getElementById(opts.editBtn);
    const saveBtn = document.getElementById(opts.saveBtn);
    const cancelBtn = document.getElementById(opts.cancelBtn);
    const summaryEl = document.getElementById(opts.summary);
    const editEl = document.getElementById(opts.edit);
    if (!editBtn || !saveBtn || !cancelBtn || !editEl) return;

    function open() {
      syncSharedKeyInputs();
      if (opts.onOpen) opts.onOpen();
      if (summaryEl) summaryEl.style.display = 'none';
      editEl.style.display = '';
      editBtn.style.display = 'none';
    }
    function close() {
      editEl.style.display = 'none';
      if (summaryEl) summaryEl.style.display = '';
      editBtn.style.display = '';
    }

    editBtn.addEventListener('click', open);
    cancelBtn.addEventListener('click', function() {
      // Discard: restore edit fields from the last-saved settings.
      loadSettings().then(close);
    });
    saveBtn.addEventListener('click', async function() {
      const fields = editEl.querySelectorAll('input[id], select[id], textarea[id], [data-setting]');
      for (const el of fields) {
        const key = el.getAttribute('data-setting') || el.id;
        if (!key) continue;
        const val = el.type === 'number' ? Number(el.value) : el.value;
        currentSettings[key] = val;
        await api.setSetting(key, val);
      }
      if (opts.onSave) await opts.onSave();
      if (opts.render) opts.render();
      close();
    });
  }

  // Grammar validation and auto-format only run inside the refinement pass, so
  // disable (and visually dim) them when AI refinement is turned off.
  function updateRefinementDependents() {
    const master = document.getElementById('refinementEnabled');
    const on = master ? master.checked : true;
    document.querySelectorAll('.refinement-dependent').forEach(function(row) {
      row.style.opacity = on ? '' : '0.45';
      const input = row.querySelector('input');
      if (input) input.disabled = !on;
    });
  }

  // Hotkey settings get registration feedback: 'set-setting' returns
  // { ok: false, error } when re-registration fails (Electron). The Tauri
  // bridge returns undefined — anything that isn't { ok: false } is success.
  const HOTKEY_KEYS = ['hotkey', 'overlayHotkey', 'undoHotkey'];
  const lastGoodHotkeys = {};

  function hotkeyFeedbackEl(el) {
    let fb = document.getElementById(el.id + '-feedback');
    if (!fb) {
      fb = document.createElement('div');
      fb.id = el.id + '-feedback';
      fb.setAttribute('role', 'alert');
      fb.style.cssText = 'display:none;font-size:12px;margin-top:6px;color:var(--danger)';
      el.insertAdjacentElement('afterend', fb);
    }
    return fb;
  }

  async function saveHotkeySetting(el) {
    const val = el.value;
    // Skip no-op saves — a post-revert blur would otherwise clear the feedback.
    if (val === lastGoodHotkeys[el.id]) return;
    const result = await api.setSetting(el.id, val);
    const fb = hotkeyFeedbackEl(el);
    if (result && typeof result === 'object' && result.ok === false) {
      fb.textContent = (result.error || 'Could not register this hotkey') + ' — reverted to previous value.';
      fb.style.display = 'block';
      if (lastGoodHotkeys[el.id] !== undefined) el.value = lastGoodHotkeys[el.id];
    } else {
      lastGoodHotkeys[el.id] = val;
      fb.style.display = 'none';
      fb.textContent = '';
    }
  }

  // Auto-save on change. NOTE: engine selection, per-provider keys/models and
  // the refinement prompt are intentionally NOT here — they live inside Edit
  // panels and commit only via their Save button (see setupEditableCard).
  ['hotkey', 'overlayHotkey', 'undoHotkey', 'recordingMode', 'startDelay', 'vocabularyList', 'contextProvider', 'claudeApiKey', 'audioDevice', 'transcriptionLanguage', 'dictationHistoryContext'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (HOTKEY_KEYS.includes(id)) {
      el.addEventListener('change', () => { saveHotkeySetting(el); });
      el.addEventListener('blur', () => { saveHotkeySetting(el); });
      return;
    }
    el.addEventListener('change', () => {
      const val = el.type === 'number' ? Number(el.value) : el.value;
      currentSettings[id] = val;
      api.setSetting(id, val);
    });
    el.addEventListener('blur', () => {
      const val = el.type === 'number' ? Number(el.value) : el.value;
      currentSettings[id] = val;
      api.setSetting(id, val);
    });
  });

  // Engine dropdowns live inside Edit panels: swap the visible field group as
  // the selection changes (value is only persisted on Save).
  const sttEngineSel = document.getElementById('sttEngine');
  if (sttEngineSel) sttEngineSel.addEventListener('change', updateSttFields);
  const llmProviderSel = document.getElementById('llmProvider');
  if (llmProviderSel) llmProviderSel.addEventListener('change', updateRefinerFields);

  // Editable summary+edit cards
  setupEditableCard({
    editBtn: 'stt-edit-btn', saveBtn: 'stt-save-btn', cancelBtn: 'stt-cancel-btn',
    summary: 'stt-summary', edit: 'stt-edit',
    onOpen: updateSttFields, render: renderSttSummary,
  });
  setupEditableCard({
    editBtn: 'refiner-edit-btn', saveBtn: 'refiner-save-btn', cancelBtn: 'refiner-cancel-btn',
    summary: 'refiner-summary', edit: 'refiner-edit',
    onOpen: updateRefinerFields, render: renderRefinerSummary,
  });
  setupEditableCard({
    editBtn: 'prompt-edit-btn', saveBtn: 'prompt-save-btn', cancelBtn: 'prompt-cancel-btn',
    summary: 'prompt-readout', edit: 'prompt-edit',
    render: renderPromptReadout,
    onSave: async function() {
      // Track when a custom prompt was set so staleness can be detected later.
      const custom = (document.getElementById('customPrompt').value || '').trim();
      const date = custom ? new Date().toISOString().split('T')[0] : '';
      currentSettings.customPromptDate = date;
      await api.setSetting('customPromptDate', date);
    },
  });

  // Checkbox settings
  ['openAtLogin', 'useWindowContext', 'captureScreenshots', 'refinementEnabled', 'grammarCheck', 'autoFormatContent', 'learnFromEdits', 'silenceDetection', 'noiseReduction', 'whisperMode', 'voiceCommandsEnabled'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', function() {
      api.setSetting(id, this.checked);
      if (id === 'refinementEnabled') updateRefinementDependents();
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
    api.onDownloadProgress(function(p) {
      var percent = (p && typeof p === 'object') ? p.percent : p;
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

  // (Custom-prompt date is tracked when the Refinement Prompt card is saved —
  // see the prompt setupEditableCard onSave above.)

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

  // Word-level diff of raw -> refined so users can see what the LLM changed
  // (mirrors src/main/history/diff.ts — proves Echo corrects, not rewrites).
  function diffWords(raw, refined) {
    var a = (raw || '').trim() ? raw.trim().split(/\s+/) : [];
    var b = (refined || '').trim() ? refined.trim().split(/\s+/) : [];
    var dp = [];
    for (var x = 0; x <= a.length; x++) dp[x] = new Array(b.length + 1).fill(0);
    for (var i = a.length - 1; i >= 0; i--)
      for (var j = b.length - 1; j >= 0; j--)
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    var ops = [];
    var p = 0, q = 0;
    while (p < a.length && q < b.length) {
      if (a[p] === b[q]) { ops.push(['equal', a[p]]); p++; q++; }
      else if (dp[p + 1][q] >= dp[p][q + 1]) { ops.push(['remove', a[p]]); p++; }
      else { ops.push(['add', b[q]]); q++; }
    }
    while (p < a.length) ops.push(['remove', a[p++]]);
    while (q < b.length) ops.push(['add', b[q++]]);
    var segs = [];
    ops.forEach(function(o) {
      var last = segs[segs.length - 1];
      if (last && last[0] === o[0]) last[1] += ' ' + o[1];
      else segs.push([o[0], o[1]]);
    });
    return segs;
  }

  function renderDiffHtml(raw, refined) {
    var segs = diffWords(raw, refined);
    var changed = segs.some(function(s) { return s[0] !== 'equal'; });
    if (!changed) return '';
    return '<div class="diff">' + segs.map(function(s) {
      var t = escapeHtml(s[1]);
      if (s[0] === 'add') return '<span class="diff-add">' + t + '</span>';
      if (s[0] === 'remove') return '<span class="diff-del">' + t + '</span>';
      return '<span>' + t + '</span>';
    }).join(' ') + '</div>';
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
        var diffHtml = renderDiffHtml(e.rawTranscription || '', e.refinedText || '');
        if (diffHtml) {
          body += '<details class="changes"><summary>Show changes</summary>' + diffHtml + '</details>';
        }
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

  // App Profiles — per-app refinement overrides. Options mirror
  // getAppProfileOptions() in src/main/context/appProfiles.ts (source of truth).
  var APP_PROFILE_OPTIONS = [
    { id: 'coding', label: 'Coding (preserve technical terms)' },
    { id: 'prompt', label: 'Prompt (AI agent — keep every detail)' },
    { id: 'shell', label: 'Shell (preserve command syntax)' },
    { id: 'prose', label: 'Prose (formal writing)' },
    { id: 'email', label: 'Email (courteous correspondence)' },
    { id: 'chat', label: 'Chat (casual messaging)' },
    { id: 'default', label: 'Default' },
  ];

  function profileLabel(id) {
    var opt = APP_PROFILE_OPTIONS.find(function(o) { return o.id === id; });
    return opt ? opt.label : id;
  }

  function populateProfileSelect() {
    var sel = document.getElementById('ap-profile');
    if (!sel || sel.options.length) return;
    APP_PROFILE_OPTIONS.forEach(function(o) {
      var opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = o.label;
      sel.appendChild(opt);
    });
  }

  async function loadAppProfiles() {
    populateProfileSelect();
    var list = document.getElementById('app-profile-list');
    if (!list) return;
    var s = await api.getSettings();
    var profiles = (s && s.appProfiles) || {};
    var apps = Object.keys(profiles);
    if (!apps.length) {
      list.innerHTML = '<div class="empty-state">No app overrides yet — add one to steer refinement per app.</div>';
      return;
    }
    list.innerHTML = '';
    apps.forEach(function(appName) {
      var item = document.createElement('div');
      item.className = 'list-item';
      item.innerHTML = '<div><span class="term">' + escapeHtml(appName) +
        '</span> <span class="context">— ' + escapeHtml(profileLabel(profiles[appName])) + '</span></div>';
      var btn = document.createElement('button');
      btn.className = 'remove-btn';
      btn.textContent = '✕';
      btn.addEventListener('click', async function() {
        var cur = ((await api.getSettings()) || {}).appProfiles || {};
        delete cur[appName];
        await api.setSetting('appProfiles', cur);
        loadAppProfiles();
      });
      item.appendChild(btn);
      list.appendChild(item);
    });
  }

  var addAppProfileBtn = document.getElementById('add-app-profile-btn');
  if (addAppProfileBtn) {
    addAppProfileBtn.addEventListener('click', async function() {
      var appName = document.getElementById('ap-app').value.trim();
      var profile = document.getElementById('ap-profile').value;
      if (!appName || !profile) return;
      var cur = ((await api.getSettings()) || {}).appProfiles || {};
      cur[appName] = profile;
      await api.setSetting('appProfiles', cur);
      document.getElementById('ap-app').value = '';
      loadAppProfiles();
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

  // Copy debug logs (History tab) — same source as the sidebar button
  var copyDebugLogsBtn = document.getElementById('copy-debug-logs-btn');
  if (copyDebugLogsBtn) {
    copyDebugLogsBtn.addEventListener('click', async function() {
      var result = await api.copyLogs();
      var status = document.getElementById('copy-debug-logs-status');
      if (status) {
        status.textContent = result.success ? 'Copied to clipboard.' : 'Copy failed.';
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

      // fn (🌐) key — not a TCC permission but the same gate in practice: if
      // macOS is using fn to change input source, it eats the tap before the
      // hotkey fires. One click fixes it, so this offers "Free it", not "Open".
      var fnKey = s.fnKey || { ok: false, status: 'unknown' };
      renderPerm('perm-fnkey', 'perm-fix-fnkey', fnKey.ok
        ? { label: 'Free', cls: 'status-ok', showFix: false }
        : { label: 'Used by macOS', cls: 'status-warn', showFix: true, fixLabel: 'Free it' });

      // Situational permissions. Screen Recording carries a real TCC status;
      // Speech Recognition and Automation have no query API, so they read
      // "unknown" and simply offer a shortcut to the relevant pane.
      renderStdPerm('perm-screen', 'perm-fix-screen', s.screenRecording);
      renderStdPerm('perm-speech', 'perm-fix-speech', s.speechRecognition);
      renderStdPerm('perm-automation', 'perm-fix-automation', s.automation);

      var hint = document.getElementById('perm-hint');
      if (hint) hint.style.display = (mic.ok && axOk && im.ok) ? 'none' : 'block';
    } catch (e) { /* ignore */ }
  }

  // Generic status → badge mapping for permissions that share the microphone's
  // { ok, status } shape but have no native prompt (so the fix is always "Open").
  function renderStdPerm(badgeId, btnId, obj) {
    var st = obj || { ok: false, status: 'unknown' };
    if (st.ok) {
      renderPerm(badgeId, btnId, { label: 'Granted', cls: 'status-ok', showFix: false });
    } else if (st.status === 'not-determined') {
      renderPerm(badgeId, btnId, { label: 'Not requested', cls: 'status-warn', showFix: true, fixLabel: 'Open' });
    } else if (st.status === 'unknown') {
      renderPerm(badgeId, btnId, { label: 'Unknown', cls: 'status-warn', showFix: true, fixLabel: 'Open' });
    } else {
      renderPerm(badgeId, btnId, { label: 'Not granted', cls: 'status-error', showFix: true, fixLabel: 'Open' });
    }
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
  var permFixFnKey = document.getElementById('perm-fix-fnkey');
  if (permFixFnKey) permFixFnKey.addEventListener('click', async function() {
    if (!api.freeFnKey) return;
    permFixFnKey.disabled = true;
    try {
      var res = await api.freeFnKey();
      await loadPermissions();
      // The pref is written, but HIToolbox may only honour it at the next login.
      var hint = document.getElementById('perm-fnkey-hint');
      if (hint && res && res.ok) hint.style.display = 'block';
    } catch (e) { /* ignore */ }
    permFixFnKey.disabled = false;
  });
  var permFixScreen = document.getElementById('perm-fix-screen');
  if (permFixScreen) permFixScreen.addEventListener('click', function() { if (api.openScreenRecordingSettings) api.openScreenRecordingSettings(); });
  var permFixSpeech = document.getElementById('perm-fix-speech');
  if (permFixSpeech) permFixSpeech.addEventListener('click', function() { if (api.openSpeechRecognitionSettings) api.openSpeechRecognitionSettings(); });
  var permFixAutomation = document.getElementById('perm-fix-automation');
  if (permFixAutomation) permFixAutomation.addEventListener('click', function() { if (api.openAutomationSettings) api.openAutomationSettings(); });
  var permRefresh = document.getElementById('perm-refresh');
  if (permRefresh) permRefresh.addEventListener('click', loadPermissions);
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
  loadAppProfiles();
  loadProviderHealth();
  loadStats();
});
