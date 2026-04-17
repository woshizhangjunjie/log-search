const DEFAULT_CONDITION_COUNT = 2;
const ROW_HEIGHT = 48;
const OVERSCAN_COUNT = 10;
const SEARCH_CHUNK_SIZE = 2 * 1024 * 1024;
const PREVIEW_CONTEXT_LINE_COUNT = 30;

const WORKER_SOURCE = String.raw`
const DEFAULT_BATCH_SIZE = 120;
const TOKEN_SPLIT_CHARS = new Set([
  ' ', '\t', '\r', '\n',
  '[', ']', '(', ')', '{', '}',
  ',', '.', ':', ';', '|', '/', '\\',
  '-', '_', '=', '+',
  String.fromCharCode(39), '"',
  '~', '!', '@', '#', '$', '%', '^', '&', '*', '<', '>', '?',
  '\uFF0C', '\u3002', '\uFF1A', '\uFF1B', '\uFF08', '\uFF09', '\u3010', '\u3011'
]);
let searchContext = null;

self.onmessage = function handleMessage(event) {
  const payload = event.data || {};
  try {
    if (payload.type === 'start') {
      startSearch(payload);
      return;
    }

    if (payload.type === 'chunk') {
      consumeChunk(payload);
      return;
    }

    if (payload.type === 'cancel') {
      resetSearchContext();
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error && error.message ? error.message : 'Worker 搜索失败'
    });
    resetSearchContext();
  }
};

function normalizeCondition(text) {
  if (typeof text !== 'string') {
    return '';
  }
  return text.trim();
}

function tokenize(text) {
  const normalized = normalizeCondition(text);
  const tokens = [];
  let buffer = '';

  for (const char of normalized) {
    if (TOKEN_SPLIT_CHARS.has(char)) {
      if (buffer) {
        tokens.push(buffer);
        buffer = '';
      }
      continue;
    }

    buffer += char;
  }

  if (buffer) {
    tokens.push(buffer);
  }

  return tokens;
}

function pickHintToken(text, tokens) {
  if (!tokens.length) {
    return text;
  }
  return tokens.slice().sort(function sortByLength(left, right) {
    return right.length - left.length;
  })[0];
}

function buildConditionMeta(rawCondition, caseSensitive) {
  const normalized = normalizeCondition(rawCondition);
  const tokens = tokenize(normalized);
  const hint = pickHintToken(normalized, tokens);
  return {
    raw: normalized,
    comparable: caseSensitive ? normalized : normalized.toLocaleLowerCase(),
    hintToken: caseSensitive ? hint : hint.toLocaleLowerCase(),
    tokens
  };
}

function prepareConditions(conditions, caseSensitive) {
  const dedupeSet = new Set();
  const prepared = [];

  for (const item of conditions || []) {
    const normalized = normalizeCondition(item);
    if (!normalized) {
      continue;
    }

    const dedupeKey = caseSensitive ? normalized : normalized.toLocaleLowerCase();
    if (dedupeSet.has(dedupeKey)) {
      continue;
    }

    dedupeSet.add(dedupeKey);
    prepared.push(buildConditionMeta(normalized, caseSensitive));
  }

  return prepared;
}

function matchLineRaw(line, preparedConditions, caseSensitive) {
  const comparableLine = caseSensitive ? line : line.toLocaleLowerCase();

  for (const condition of preparedConditions) {
    const comparableCondition = typeof condition === 'string'
      ? (caseSensitive ? condition : condition.toLocaleLowerCase())
      : condition.comparable;

    if (!comparableLine.includes(comparableCondition)) {
      return false;
    }
  }

  return true;
}

function matchLineFast(line, preparedConditions, caseSensitive) {
  const comparableLine = caseSensitive ? line : line.toLocaleLowerCase();

  for (const condition of preparedConditions) {
    if (condition.hintToken && !comparableLine.includes(condition.hintToken)) {
      return false;
    }
  }

  return matchLineRaw(line, preparedConditions, caseSensitive);
}

function splitLines(text) {
  const lines = [];
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n') {
      continue;
    }

    let line = text.slice(start, index);
    if (line.endsWith('\r')) {
      line = line.slice(0, -1);
    }
    lines.push(line);
    start = index + 1;
  }

  return {
    lines,
    remainder: text.slice(start)
  };
}

function flushBatch(batch) {
  if (!batch.length) {
    return;
  }

  self.postMessage({
    type: 'results',
    items: batch.slice()
  });
  batch.length = 0;
}

function reportProgress(bytesProcessed, totalBytes, lineCount, hitCount, startedAt) {
  self.postMessage({
    type: 'progress',
    bytesProcessed,
    totalBytes,
    lineCount,
    hitCount,
    durationMs: performance.now() - startedAt
  });
}

function startSearch(payload) {
  const caseSensitive = Boolean(payload.caseSensitive);
  const encoding = payload.encoding || 'utf-8';
  const preparedConditions = prepareConditions(payload.conditions, caseSensitive);
  if (!preparedConditions.length) {
    self.postMessage({
      type: 'done',
      hitCount: 0,
      lineCount: 0,
      totalBytes: payload.totalBytes || 0,
      durationMs: 0
    });
    return;
  }

  searchContext = {
    decoder: new TextDecoder(encoding),
    startedAt: performance.now(),
    totalBytes: payload.totalBytes || 0,
    bytesProcessed: 0,
    lineCount: 0,
    hitCount: 0,
    remainder: '',
    resultBatch: [],
    preparedConditions,
    caseSensitive,
    encoding
  };
}

function consumeChunk(payload) {
  if (!searchContext) {
    return;
  }

  const buffer = payload.buffer || new ArrayBuffer(0);
  const decoded = searchContext.decoder.decode(new Uint8Array(buffer), {
    stream: !payload.isLast
  });

  /*
    remainder 保存上一块结尾的半行残片。
    主线程只负责分块读二进制，Worker 负责拼接残片、切行和匹配，
    这样既能避免中文乱码，也能避开部分浏览器里 Worker 直接读 File 的兼容问题。
  */
  const merged = searchContext.remainder + decoded;
  const parsed = splitLines(merged);
  searchContext.remainder = parsed.remainder;
  searchContext.bytesProcessed = payload.bytesProcessed || searchContext.bytesProcessed;

  processLines(parsed.lines);
  reportProgress(
    searchContext.bytesProcessed,
    searchContext.totalBytes,
    searchContext.lineCount,
    searchContext.hitCount,
    searchContext.startedAt
  );

  if (!payload.isLast) {
    return;
  }

  const flushedText = searchContext.decoder.decode();
  finalizeTail(searchContext.remainder + flushedText);
  flushBatch(searchContext.resultBatch);
  self.postMessage({
    type: 'done',
    hitCount: searchContext.hitCount,
    lineCount: searchContext.lineCount,
    totalBytes: searchContext.totalBytes,
    durationMs: performance.now() - searchContext.startedAt
  });
  resetSearchContext();
}

function processLines(lines) {
  for (const line of lines) {
    processLine(line);
  }
}

function processLine(line) {
  searchContext.lineCount += 1;

  /*
    tokenize 只用于生成 hintToken 做候选过滤。
    最终是否命中，仍然完全由 matchLineRaw 对原始整行文本做 AND 判定。
  */
  if (!matchLineFast(line, searchContext.preparedConditions, searchContext.caseSensitive)) {
    return;
  }

  searchContext.hitCount += 1;
  searchContext.resultBatch.push({
    lineNumber: searchContext.lineCount,
    text: line
  });

  if (searchContext.resultBatch.length >= DEFAULT_BATCH_SIZE) {
    flushBatch(searchContext.resultBatch);
  }
}

function finalizeTail(tail) {
  if (!tail.length) {
    return;
  }

  const finalLines = splitLines(tail);
  processLines(finalLines.lines);

  let tailLine = finalLines.remainder;
  if (tailLine.endsWith('\r')) {
    tailLine = tailLine.slice(0, -1);
  }

  if (tailLine.length > 0) {
    processLine(tailLine);
  }
}

function resetSearchContext() {
  searchContext = null;
}
`;
const TOKEN_SPLIT_CHARS = new Set([
  ' ', '\t', '\r', '\n',
  '[', ']', '(', ')', '{', '}',
  ',', '.', ':', ';', '|', '/', '\\',
  '-', '_', '=', '+',
  String.fromCharCode(39), '"',
  '~', '!', '@', '#', '$', '%', '^', '&', '*', '<', '>', '?',
  '\uFF0C', '\u3002', '\uFF1A', '\uFF1B', '\uFF08', '\uFF09', '\u3010', '\u3011'
]);

function splitLines(text) {
  const lines = [];
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n') {
      continue;
    }

    let line = text.slice(start, index);
    if (line.endsWith('\r')) {
      line = line.slice(0, -1);
    }
    lines.push(line);
    start = index + 1;
  }

  return {
    lines,
    remainder: text.slice(start)
  };
}

const refs = {
  fileInput: document.getElementById('fileInput'),
  fileName: document.getElementById('fileName'),
  fileSize: document.getElementById('fileSize'),
  dropZone: document.getElementById('dropZone'),
  addConditionButton: document.getElementById('addConditionButton'),
  conditionList: document.getElementById('conditionList'),
  caseSensitiveCheckbox: document.getElementById('caseSensitiveCheckbox'),
  encodingSelect: document.getElementById('encodingSelect'),
  searchButton: document.getElementById('searchButton'),
  cancelButton: document.getElementById('cancelButton'),
  clearButton: document.getElementById('clearButton'),
  progressText: document.getElementById('progressText'),
  elapsedText: document.getElementById('elapsedText'),
  hitCountText: document.getElementById('hitCountText'),
  lineCountText: document.getElementById('lineCountText'),
  progressBar: document.getElementById('progressBar'),
  resultViewport: document.getElementById('resultViewport'),
  resultSpacer: document.getElementById('resultSpacer'),
  resultContent: document.getElementById('resultContent'),
  emptyState: document.getElementById('emptyState'),
  resultHint: document.getElementById('resultHint'),
  previewViewport: document.getElementById('previewViewport'),
  previewContent: document.getElementById('previewContent'),
  previewEmptyState: document.getElementById('previewEmptyState'),
  previewHint: document.getElementById('previewHint')
};

const state = {
  file: null,
  worker: null,
  conditions: [],
  nextConditionId: 1,
  results: [],
  searchInFlight: false,
  searchStartedAt: 0,
  searchRunId: 0,
  elapsedTimerId: 0,
  renderQueued: false,
  activeConditions: [],
  activeCaseSensitive: false,
  activeEncoding: 'utf-8',
  emptyMessage: '请选择文件并输入条件后开始搜索。',
  selectedLineNumber: 0,
  previewLines: [],
  previewLoading: false,
  previewMessage: '点击搜索结果后，可定位到对应行并查看上下文。',
  previewRangeStart: 0,
  previewRangeEnd: 0,
  previewRequestId: 0
};

init();

function init() {
  resetConditions();
  bindEvents();
  renderConditions();
  updateFileMeta();
  updateSearchStats({
    progressText: '未开始',
    progressRatio: 0,
    elapsedMs: 0,
    hitCount: 0,
    lineCount: 0
  });
  renderResults();
  renderPreview();
  updateActionButtons();
}

function bindEvents() {
  refs.fileInput.addEventListener('change', handleFileInputChange);
  refs.addConditionButton.addEventListener('click', handleAddConditionClick);
  refs.searchButton.addEventListener('click', startSearch);
  refs.cancelButton.addEventListener('click', handleCancelClick);
  refs.clearButton.addEventListener('click', handleClearClick);
  refs.resultViewport.addEventListener('scroll', scheduleResultRender);
  refs.resultContent.addEventListener('click', handleResultClick);
  refs.resultContent.addEventListener('keydown', handleResultKeydown);
  window.addEventListener('resize', scheduleResultRender);

  refs.conditionList.addEventListener('input', handleConditionInput);
  refs.conditionList.addEventListener('click', handleConditionListClick);
  refs.conditionList.addEventListener('keydown', handleConditionListKeydown);

  refs.dropZone.addEventListener('dragenter', handleDragEnter);
  refs.dropZone.addEventListener('dragover', handleDragOver);
  refs.dropZone.addEventListener('dragleave', handleDragLeave);
  refs.dropZone.addEventListener('drop', handleDrop);
}

function handleFileInputChange(event) {
  const files = event.target.files;
  if (!files || !files.length) {
    return;
  }
  setCurrentFile(files[0]);
  event.target.value = '';
}

function handleAddConditionClick() {
  addCondition();
}

function handleCancelClick() {
  cancelSearch('搜索已取消，已保留当前已返回的命中结果。');
}

function handleClearClick() {
  resetConditions();
  renderConditions();
  state.activeConditions = [];
  state.activeCaseSensitive = false;
  clearResults('条件已清空，请重新输入后再搜索。');
}

function handleConditionInput(event) {
  const input = event.target;
  if (!input.classList.contains('condition-input')) {
    return;
  }

  const conditionId = Number(input.closest('.condition-row')?.dataset.id);
  const condition = state.conditions.find((item) => item.id === conditionId);
  if (condition) {
    condition.value = input.value;
  }
}

function handleConditionListClick(event) {
  const button = event.target.closest('[data-action="remove"]');
  if (!button) {
    return;
  }

  const conditionId = Number(button.closest('.condition-row')?.dataset.id);
  removeCondition(conditionId);
}

function handleConditionListKeydown(event) {
  const input = event.target;
  if (!input.classList.contains('condition-input')) {
    return;
  }

  if (event.key !== 'Enter') {
    return;
  }

  event.preventDefault();
  const conditionId = Number(input.closest('.condition-row')?.dataset.id);
  addCondition(conditionId);
}

function handleResultClick(event) {
  const row = event.target.closest('.result-row[data-line-number]');
  if (!row) {
    return;
  }

  const lineNumber = Number(row.dataset.lineNumber);
  if (!lineNumber) {
    return;
  }

  selectResultLine(lineNumber);
}

function handleResultKeydown(event) {
  if (event.key !== 'Enter' && event.key !== ' ') {
    return;
  }

  const row = event.target.closest('.result-row[data-line-number]');
  if (!row) {
    return;
  }

  event.preventDefault();
  selectResultLine(Number(row.dataset.lineNumber));
}

function handleDragEnter(event) {
  event.preventDefault();
  refs.dropZone.classList.add('dragover');
}

function handleDragOver(event) {
  event.preventDefault();
  refs.dropZone.classList.add('dragover');
}

function handleDragLeave(event) {
  if (event.target === refs.dropZone) {
    refs.dropZone.classList.remove('dragover');
  }
}

function handleDrop(event) {
  event.preventDefault();
  refs.dropZone.classList.remove('dragover');
  const files = event.dataTransfer?.files;
  if (!files || !files.length) {
    return;
  }
  setCurrentFile(files[0]);
}

function createCondition(value = '') {
  return {
    id: state.nextConditionId++,
    value
  };
}

function resetConditions() {
  state.conditions = [];
  for (let index = 0; index < DEFAULT_CONDITION_COUNT; index += 1) {
    state.conditions.push(createCondition());
  }
}

function addCondition(afterId = null) {
  const newCondition = createCondition();

  if (afterId === null) {
    state.conditions.push(newCondition);
  } else {
    const targetIndex = state.conditions.findIndex((item) => item.id === afterId);
    if (targetIndex === -1) {
      state.conditions.push(newCondition);
    } else {
      state.conditions.splice(targetIndex + 1, 0, newCondition);
    }
  }

  renderConditions(newCondition.id);
}

function removeCondition(conditionId) {
  if (state.conditions.length <= 1) {
    return;
  }

  const targetIndex = state.conditions.findIndex((item) => item.id === conditionId);
  if (targetIndex === -1) {
    return;
  }

  state.conditions.splice(targetIndex, 1);
  const fallback = state.conditions[Math.max(0, targetIndex - 1)];
  renderConditions(fallback?.id ?? null);
}

function renderConditions(focusId = null) {
  refs.conditionList.innerHTML = state.conditions.map((condition, index) => {
    return `
      <div class="condition-row" data-id="${condition.id}">
        <span class="condition-index">条件 ${index + 1}</span>
        <input
          class="condition-input"
          type="text"
          value="${escapeAttribute(condition.value)}"
          placeholder="请输入中文、英文或带符号的查询条件"
        >
        <button class="icon-button" type="button" data-action="remove" ${state.conditions.length <= 1 ? 'disabled' : ''}>删除</button>
      </div>
    `;
  }).join('');

  if (focusId !== null) {
    const targetInput = refs.conditionList.querySelector(`.condition-row[data-id="${focusId}"] .condition-input`);
    if (targetInput) {
      targetInput.focus();
      const valueLength = targetInput.value.length;
      targetInput.setSelectionRange(valueLength, valueLength);
    }
  }
}

function normalizeCondition(text) {
  if (typeof text !== 'string') {
    return '';
  }
  return text.trim();
}

function tokenize(text) {
  const normalized = normalizeCondition(text);
  const tokens = [];
  let buffer = '';

  for (const char of normalized) {
    if (TOKEN_SPLIT_CHARS.has(char)) {
      if (buffer) {
        tokens.push(buffer);
        buffer = '';
      }
      continue;
    }

    buffer += char;
  }

  if (buffer) {
    tokens.push(buffer);
  }

  return tokens;
}

function getSearchConditions() {
  const caseSensitive = refs.caseSensitiveCheckbox.checked;
  const dedupeSet = new Set();
  const conditions = [];

  for (const item of state.conditions) {
    const normalized = normalizeCondition(item.value);
    if (!normalized) {
      continue;
    }

    const dedupeKey = caseSensitive ? normalized : normalized.toLocaleLowerCase();
    if (dedupeSet.has(dedupeKey)) {
      continue;
    }

    dedupeSet.add(dedupeKey);
    conditions.push(normalized);
  }

  return conditions;
}

function setCurrentFile(file) {
  if (!file) {
    return;
  }

  if (state.searchInFlight) {
    cancelSearch('已切换文件，当前搜索已终止。');
  }

  state.file = file;
  updateFileMeta();
  clearResults('文件已就绪，请输入条件后开始搜索。');
  updateActionButtons();
}

function updateFileMeta() {
  refs.fileName.textContent = state.file ? state.file.name : '未选择文件';
  refs.fileSize.textContent = state.file ? formatFileSize(state.file.size) : '-';
}

function updateActionButtons() {
  refs.searchButton.disabled = !state.file || state.searchInFlight;
  refs.cancelButton.disabled = !state.searchInFlight;
}

function createSearchWorker() {
  const blob = new Blob([WORKER_SOURCE], { type: 'text/javascript;charset=utf-8' });
  const objectUrl = URL.createObjectURL(blob);
  const worker = new Worker(objectUrl);
  return worker;
}

function startSearch() {
  if (!state.file) {
    clearResults('请先选择一个日志文件。');
    return;
  }

  const conditions = getSearchConditions();
  if (!conditions.length) {
    clearResults('请至少输入一个非空查询条件。');
    return;
  }

  if (state.searchInFlight) {
    cancelSearch('已中断旧搜索，准备重新开始。');
  }

  state.results = [];
  state.activeConditions = conditions;
  state.activeCaseSensitive = refs.caseSensitiveCheckbox.checked;
  state.activeEncoding = refs.encodingSelect?.value || 'utf-8';
  state.searchInFlight = true;
  state.searchStartedAt = performance.now();
  refs.resultViewport.scrollTop = 0;
  resetPreview();

  updateActionButtons();
  updateSearchStats({
    progressText: '准备搜索...',
    progressRatio: 0,
    elapsedMs: 0,
    hitCount: 0,
    lineCount: 0
  });
  setEmptyMessage('正在搜索，等待命中结果...');
  scheduleResultRender();
  startElapsedTimer();

  const worker = createSearchWorker();
  state.worker = worker;
  state.searchRunId += 1;
  const currentRunId = state.searchRunId;

  worker.onmessage = function handleWorkerMessage(event) {
    if (worker !== state.worker || currentRunId !== state.searchRunId) {
      return;
    }

    const message = event.data || {};

    if (message.type === 'results') {
      appendResults(message.items || []);
      return;
    }

    if (message.type === 'progress') {
      updateSearchStats({
        progressText: buildProgressText(message.bytesProcessed, message.totalBytes),
        progressRatio: calculateProgress(message.bytesProcessed, message.totalBytes),
        elapsedMs: message.durationMs,
        hitCount: message.hitCount,
        lineCount: message.lineCount
      });
      return;
    }

    if (message.type === 'done') {
      finishSearch({
        progressText: `搜索完成，命中 ${formatNumber(message.hitCount)} 条`,
        progressRatio: 1,
        elapsedMs: message.durationMs,
        hitCount: message.hitCount,
        lineCount: message.lineCount
      });
      return;
    }

    if (message.type === 'error') {
      finishSearch({
        progressText: message.message || '搜索失败',
        progressRatio: parseProgressFromText(),
        elapsedMs: performance.now() - state.searchStartedAt,
        hitCount: state.results.length,
        lineCount: parseLineCount()
      });
      setEmptyMessage(message.message || '搜索失败，请检查文件内容后重试。');
      scheduleResultRender();
    }
  };

  worker.onerror = function handleWorkerError(error) {
    if (worker !== state.worker || currentRunId !== state.searchRunId) {
      return;
    }

    finishSearch({
      progressText: 'Worker 运行异常',
      progressRatio: parseProgressFromText(),
      elapsedMs: performance.now() - state.searchStartedAt,
      hitCount: state.results.length,
      lineCount: parseLineCount()
    });
    setEmptyMessage(error.message || 'Worker 运行异常，请刷新页面后重试。');
    scheduleResultRender();
  };

  worker.postMessage({
    type: 'start',
    totalBytes: state.file.size,
    conditions,
    caseSensitive: state.activeCaseSensitive,
    encoding: state.activeEncoding
  });

  void streamFileInChunks(worker, currentRunId);
}

function appendResults(items) {
  if (!items.length) {
    return;
  }

  state.results.push(...items);
  if (state.results.length) {
    setEmptyMessage('');
  }
  refs.hitCountText.textContent = formatNumber(state.results.length);
  scheduleResultRender();
}

function finishSearch(stats) {
  stopElapsedTimer();
  updateSearchStats(stats);

  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }

  state.searchInFlight = false;
  updateActionButtons();

  if (!state.results.length) {
    setEmptyMessage(buildNoResultMessage());
  }
  scheduleResultRender();
}

function cancelSearch(progressText) {
  state.searchRunId += 1;

  if (state.worker) {
    state.worker.postMessage({ type: 'cancel' });
    state.worker.terminate();
    state.worker = null;
  }

  stopElapsedTimer();
  state.searchInFlight = false;
  updateActionButtons();

  const elapsedMs = state.searchStartedAt ? performance.now() - state.searchStartedAt : 0;
  updateSearchStats({
    progressText,
    progressRatio: parseProgressFromText(),
    elapsedMs,
    hitCount: state.results.length,
    lineCount: parseLineCount()
  });

  if (!state.results.length) {
    setEmptyMessage('搜索已取消，当前没有命中结果。');
  }
  scheduleResultRender();
}

function clearResults(message) {
  state.searchRunId += 1;

  if (state.worker) {
    state.worker.postMessage({ type: 'cancel' });
    state.worker.terminate();
    state.worker = null;
  }

  stopElapsedTimer();
  state.searchInFlight = false;
  state.results = [];
  state.activeEncoding = refs.encodingSelect?.value || 'utf-8';
  refs.resultViewport.scrollTop = 0;
  setEmptyMessage(message);
  resetPreview();
  updateSearchStats({
    progressText: '未开始',
    progressRatio: 0,
    elapsedMs: 0,
    hitCount: 0,
    lineCount: 0
  });
  updateActionButtons();
  scheduleResultRender();
}

function startElapsedTimer() {
  stopElapsedTimer();
  state.elapsedTimerId = window.setInterval(() => {
    if (!state.searchInFlight) {
      return;
    }
    const elapsedMs = performance.now() - state.searchStartedAt;
    refs.elapsedText.textContent = formatDuration(elapsedMs);
  }, 100);
}

function stopElapsedTimer() {
  if (state.elapsedTimerId) {
    window.clearInterval(state.elapsedTimerId);
    state.elapsedTimerId = 0;
  }
}

function updateSearchStats({ progressText, progressRatio, elapsedMs, hitCount, lineCount }) {
  refs.progressText.textContent = progressText;
  refs.progressBar.style.width = `${Math.max(0, Math.min(1, progressRatio)) * 100}%`;
  refs.elapsedText.textContent = formatDuration(elapsedMs);
  refs.hitCountText.textContent = formatNumber(hitCount);
  refs.lineCountText.textContent = formatNumber(lineCount);
}

function buildProgressText(bytesProcessed, totalBytes) {
  if (!totalBytes) {
    return '已处理 100%';
  }
  const percent = calculateProgress(bytesProcessed, totalBytes) * 100;
  return `已处理 ${percent.toFixed(2)}%（${formatFileSize(bytesProcessed)} / ${formatFileSize(totalBytes)}）`;
}

function calculateProgress(bytesProcessed, totalBytes) {
  if (!totalBytes) {
    return 1;
  }
  return bytesProcessed / totalBytes;
}

function parseLineCount() {
  const normalized = refs.lineCountText.textContent.replace(/,/g, '');
  return Number(normalized) || 0;
}

function parseProgressFromText() {
  const progressWidth = refs.progressBar.style.width || '0%';
  const numeric = Number(progressWidth.replace('%', ''));
  if (Number.isNaN(numeric)) {
    return 0;
  }
  return numeric / 100;
}

function scheduleResultRender() {
  if (state.renderQueued) {
    return;
  }

  state.renderQueued = true;
  window.requestAnimationFrame(() => {
    state.renderQueued = false;
    renderResults();
  });
}

function resetPreview(message = '点击搜索结果后，可定位到对应行并查看上下文。') {
  state.previewRequestId += 1;
  state.selectedLineNumber = 0;
  state.previewLines = [];
  state.previewLoading = false;
  state.previewMessage = message;
  state.previewRangeStart = 0;
  state.previewRangeEnd = 0;
  refs.previewViewport.scrollTop = 0;
  renderPreview();
}

function selectResultLine(lineNumber) {
  if (!state.file || !lineNumber) {
    return;
  }

  state.previewRequestId += 1;
  state.selectedLineNumber = lineNumber;
  state.previewLines = [];
  state.previewLoading = true;
  state.previewMessage = `正在定位第 ${formatNumber(lineNumber)} 行附近内容...`;
  state.previewRangeStart = 0;
  state.previewRangeEnd = 0;
  refs.previewViewport.scrollTop = 0;
  scheduleResultRender();
  renderPreview();

  void loadPreviewContext(lineNumber, state.previewRequestId);
}

function renderResults() {
  const total = state.results.length;
  const viewportHeight = refs.resultViewport.clientHeight || 480;
  const scrollTop = refs.resultViewport.scrollTop;

  if (!total) {
    refs.resultSpacer.style.height = '0px';
    refs.resultContent.style.transform = 'translateY(0)';
    refs.resultContent.innerHTML = '';
    refs.emptyState.textContent = state.emptyMessage || '当前没有命中结果。';
    refs.emptyState.hidden = false;
    refs.resultHint.textContent = state.searchInFlight
      ? '正在流式搜索中，命中结果会边搜边显示。'
      : '仅渲染可视区域附近的少量结果，点击结果可定位到原始日志对应行。';
    return;
  }

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_COUNT);
  const endIndex = Math.min(
    total,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN_COUNT
  );

  const visibleItems = state.results.slice(startIndex, endIndex);
  refs.resultSpacer.style.height = `${total * ROW_HEIGHT}px`;
  refs.resultContent.style.transform = `translateY(${startIndex * ROW_HEIGHT}px)`;
  refs.resultContent.innerHTML = visibleItems.map((item) => {
    return renderResultRow(item);
  }).join('');

  refs.emptyState.hidden = true;
  refs.resultHint.textContent = `命中 ${formatNumber(total)} 条，当前渲染第 ${formatNumber(startIndex + 1)} 到 ${formatNumber(endIndex)} 条附近结果，点击任一结果可定位原文。`;
}

function renderResultRow(item) {
  const activeClass = item.lineNumber === state.selectedLineNumber ? ' is-active' : '';

  return `
    <div
      class="result-row${activeClass}"
      style="height:${ROW_HEIGHT}px"
      data-line-number="${item.lineNumber}"
      role="button"
      tabindex="0"
    >
      <div class="line-number">第 ${formatNumber(item.lineNumber)} 行</div>
      <div class="line-text">${highlightLine(item.text, state.activeConditions, state.activeCaseSensitive)}</div>
    </div>
  `;
}

function renderPreview() {
  if (!state.selectedLineNumber) {
    refs.previewContent.innerHTML = '';
    refs.previewEmptyState.textContent = state.previewMessage;
    refs.previewEmptyState.hidden = false;
    refs.previewHint.textContent = '点击上方搜索结果后，在这里查看对应行附近的日志内容。';
    return;
  }

  if (state.previewLoading) {
    refs.previewContent.innerHTML = '';
    refs.previewEmptyState.textContent = state.previewMessage;
    refs.previewEmptyState.hidden = false;
    refs.previewHint.textContent = `正在定位第 ${formatNumber(state.selectedLineNumber)} 行，仅按需读取附近上下文。`;
    return;
  }

  if (!state.previewLines.length) {
    refs.previewContent.innerHTML = '';
    refs.previewEmptyState.textContent = state.previewMessage || `未能定位到第 ${formatNumber(state.selectedLineNumber)} 行附近内容。`;
    refs.previewEmptyState.hidden = false;
    refs.previewHint.textContent = '当前未读取到可展示的上下文，可重新点击结果重试。';
    return;
  }

  refs.previewContent.innerHTML = state.previewLines.map((item) => {
    return renderPreviewRow(item);
  }).join('');
  refs.previewEmptyState.hidden = true;
  refs.previewHint.textContent = `已定位到第 ${formatNumber(state.selectedLineNumber)} 行，当前展示第 ${formatNumber(state.previewRangeStart)} 到 ${formatNumber(state.previewRangeEnd)} 行。`;

  window.requestAnimationFrame(() => {
    const currentRow = refs.previewContent.querySelector('.preview-row.is-current');
    if (!currentRow) {
      return;
    }

    const targetTop = currentRow.offsetTop - (refs.previewViewport.clientHeight - currentRow.offsetHeight) / 2;
    refs.previewViewport.scrollTop = Math.max(0, targetTop);
  });
}

function renderPreviewRow(item) {
  const currentClass = item.lineNumber === state.selectedLineNumber ? ' is-current' : '';

  return `
    <div class="preview-row${currentClass}">
      <div class="line-number">第 ${formatNumber(item.lineNumber)} 行</div>
      <div class="preview-text">${highlightLine(item.text, state.activeConditions, state.activeCaseSensitive)}</div>
    </div>
  `;
}

function highlightLine(line, conditions, caseSensitive) {
  if (!line) {
    return '';
  }

  const normalizedConditions = dedupeConditions(conditions, caseSensitive).sort((left, right) => {
    return right.length - left.length;
  });

  if (!normalizedConditions.length) {
    return escapeHtml(line);
  }

  const comparableLine = caseSensitive ? line : line.toLocaleLowerCase();
  const ranges = [];

  for (const condition of normalizedConditions) {
    const comparableCondition = caseSensitive ? condition : condition.toLocaleLowerCase();
    let searchFrom = 0;

    while (searchFrom < comparableLine.length) {
      const start = comparableLine.indexOf(comparableCondition, searchFrom);
      if (start === -1) {
        break;
      }

      const end = start + comparableCondition.length;
      if (!hasOverlap(ranges, start, end)) {
        ranges.push({ start, end });
      }

      searchFrom = start + Math.max(1, comparableCondition.length);
    }
  }

  if (!ranges.length) {
    return escapeHtml(line);
  }

  ranges.sort((left, right) => left.start - right.start);

  let html = '';
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      html += escapeHtml(line.slice(cursor, range.start));
    }
    html += '<mark>' + escapeHtml(line.slice(range.start, range.end)) + '</mark>';
    cursor = range.end;
  }

  if (cursor < line.length) {
    html += escapeHtml(line.slice(cursor));
  }

  return html;
}

function dedupeConditions(conditions, caseSensitive) {
  const seen = new Set();
  const result = [];

  for (const rawCondition of conditions || []) {
    const normalized = normalizeCondition(rawCondition);
    if (!normalized) {
      continue;
    }

    const dedupeKey = caseSensitive ? normalized : normalized.toLocaleLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    result.push(normalized);
  }

  return result;
}

function hasOverlap(ranges, start, end) {
  return ranges.some((range) => start < range.end && end > range.start);
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttribute(text) {
  return escapeHtml(text);
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '-';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 100 || unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return '0 ms';
  }

  if (milliseconds < 1000) {
    return `${Math.round(milliseconds)} ms`;
  }

  if (milliseconds < 60000) {
    return `${(milliseconds / 1000).toFixed(2)} s`;
  }

  const minutes = Math.floor(milliseconds / 60000);
  const seconds = ((milliseconds % 60000) / 1000).toFixed(1);
  return `${minutes} 分 ${seconds} 秒`;
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN').format(value || 0);
}

function setEmptyMessage(message) {
  state.emptyMessage = message;
}

function buildNoResultMessage() {
  if (state.activeEncoding === 'utf-8' && mayContainChineseCondition(state.activeConditions)) {
    return '搜索完成，但没有命中任何结果。如果英文条件能单独搜到而中文搜不到，请切换“文件编码”为 GB18030 / GBK 后重试。';
  }

  return '搜索完成，但没有命中任何结果。';
}

function mayContainChineseCondition(conditions) {
  return (conditions || []).some((condition) => /[\u3400-\u9fff]/u.test(condition));
}

async function loadPreviewContext(lineNumber, requestId) {
  if (!state.file) {
    return;
  }

  const startLineNumber = Math.max(1, lineNumber - PREVIEW_CONTEXT_LINE_COUNT);
  const endLineNumber = lineNumber + PREVIEW_CONTEXT_LINE_COUNT;
  const previewLines = [];
  const decoder = new TextDecoder(state.activeEncoding || 'utf-8');
  let remainder = '';
  let offset = 0;
  let lineCount = 0;
  let reachedEnd = false;

  function collectLine(text) {
    lineCount += 1;

    if (lineCount >= startLineNumber && lineCount <= endLineNumber) {
      previewLines.push({
        lineNumber: lineCount,
        text
      });
    }

    if (lineCount >= endLineNumber) {
      reachedEnd = true;
    }
  }

  try {
    while (offset < state.file.size && !reachedEnd) {
      if (requestId !== state.previewRequestId || !state.file) {
        return;
      }

      const nextOffset = Math.min(offset + SEARCH_CHUNK_SIZE, state.file.size);
      const isLast = nextOffset >= state.file.size;
      const buffer = await state.file.slice(offset, nextOffset).arrayBuffer();

      if (requestId !== state.previewRequestId || !state.file) {
        return;
      }

      const decoded = decoder.decode(new Uint8Array(buffer), {
        stream: !isLast
      });
      const parsed = splitLines(remainder + decoded);
      remainder = parsed.remainder;

      for (const line of parsed.lines) {
        collectLine(line);
        if (reachedEnd) {
          break;
        }
      }

      if (isLast && !reachedEnd) {
        let tailLine = remainder;
        if (tailLine.endsWith('\r')) {
          tailLine = tailLine.slice(0, -1);
        }

        if (tailLine.length > 0) {
          collectLine(tailLine);
        }
      }

      offset = nextOffset;

      if (!reachedEnd) {
        await waitForNextTurn();
      }
    }

    if (requestId !== state.previewRequestId) {
      return;
    }

    state.previewLoading = false;
    state.previewLines = previewLines;
    state.previewRangeStart = previewLines.length ? previewLines[0].lineNumber : 0;
    state.previewRangeEnd = previewLines.length ? previewLines[previewLines.length - 1].lineNumber : 0;
    state.previewMessage = previewLines.length
      ? ''
      : `未能定位到第 ${formatNumber(lineNumber)} 行附近内容，请重试。`;
    renderPreview();
  } catch (error) {
    if (requestId !== state.previewRequestId) {
      return;
    }

    state.previewLoading = false;
    state.previewLines = [];
    state.previewRangeStart = 0;
    state.previewRangeEnd = 0;
    state.previewMessage = buildFileReadErrorMessage(error);
    renderPreview();
  }
}

async function streamFileInChunks(worker, runId) {
  if (!state.file) {
    return;
  }

  try {
    if (state.file.size === 0) {
      const emptyBuffer = new ArrayBuffer(0);
      worker.postMessage({
        type: 'chunk',
        buffer: emptyBuffer,
        bytesProcessed: 0,
        isLast: true
      }, [emptyBuffer]);
      return;
    }

    let offset = 0;

    while (offset < state.file.size) {
      if (!isCurrentSearchRun(worker, runId)) {
        return;
      }

      const nextOffset = Math.min(offset + SEARCH_CHUNK_SIZE, state.file.size);
      const buffer = await state.file.slice(offset, nextOffset).arrayBuffer();

      if (!isCurrentSearchRun(worker, runId)) {
        return;
      }

      const isLast = nextOffset >= state.file.size;
      worker.postMessage({
        type: 'chunk',
        buffer,
        bytesProcessed: nextOffset,
        isLast
      }, [buffer]);

      offset = nextOffset;
      await waitForNextTurn();
    }
  } catch (error) {
    if (!isCurrentSearchRun(worker, runId)) {
      return;
    }

    const message = buildFileReadErrorMessage(error);
    finishSearch({
      progressText: message,
      progressRatio: parseProgressFromText(),
      elapsedMs: performance.now() - state.searchStartedAt,
      hitCount: state.results.length,
      lineCount: parseLineCount()
    });
    setEmptyMessage(message);
    scheduleResultRender();
  }
}

function isCurrentSearchRun(worker, runId) {
  return state.searchInFlight && state.worker === worker && state.searchRunId === runId;
}

function waitForNextTurn() {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function buildFileReadErrorMessage(error) {
  const rawMessage = error && error.message ? error.message : '';
  if (rawMessage.includes('requested file could not be read')) {
    return '文件读取失败，可能是浏览器权限限制。请改用本地静态服务器方式打开页面后重试。';
  }

  if (rawMessage) {
    return `文件读取失败：${rawMessage}`;
  }

  return '文件读取失败，请确认文件仍可访问后重试。';
}
