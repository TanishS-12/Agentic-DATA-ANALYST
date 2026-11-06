// ---- State -----------------------------------------------------------------
const state = {
  datasets: {},              // table_name -> dataset metadata
  activeTable: null,         // table whose schema is shown in the sidebar
  selectedTables: new Set(), // tables ticked for the current query / join
};

// ---- DOM refs --------------------------------------------------------------
const el = (id) => document.getElementById(id);

const dropZone        = el('drop-zone');
const fileInput       = el('file-input');
const dropLabel       = el('drop-label');
const datasetList     = el('dataset-list');
const joinPanel       = el('join-panel');
const joinChecklist   = el('join-checklist');
const schemaPanel     = el('schema-panel');
const schemaColumns   = el('schema-columns');
const questionInput   = el('question-input');
const askButton       = el('ask-button');
const queryHint       = el('query-hint');
const queryForm       = el('query-form');
const resultsSection  = el('results');
const sqlOutput       = el('sql-output');
const resultsTable    = el('results-table');
const anomalyFlag     = el('anomaly-flag');
const reportOutput    = el('report-output');
const errorBox        = el('error-box');
const engineStatus    = el('engine-status');
const chartCanvas     = el('result-chart');
const chartEmpty      = el('chart-empty');
const chartTypeSelect = el('chart-type-select');

let activeChart   = null;
let lastChartData = null;

chartTypeSelect.addEventListener('change', () => {
  if (lastChartData) renderChart(lastChartData.columns, lastChartData.rows);
});

// ---- Helpers ---------------------------------------------------------------

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.remove('hidden');
}
function clearError() {
  errorBox.classList.add('hidden');
  errorBox.textContent = '';
}
function setEngineStatus(text) {
  engineStatus.textContent = text;
}

// ---- Session restore -------------------------------------------------------
// On every page load, ask the server what tables it already knows about
// (populated from SQLite on startup) so the user never has to re-upload
// after a Flask debug-mode reload or browser refresh.

async function restoreSessionDatasets() {
  try {
    const res = await fetch('/api/datasets');
    if (!res.ok) return;
    const { datasets } = await res.json();
    (datasets || []).forEach((ds) => { state.datasets[ds.table_name] = ds; });

    if (Object.keys(state.datasets).length > 0) {
      // Auto-select the first table so the UI is immediately usable
      const first = Object.keys(state.datasets)[0];
      state.activeTable = first;
      state.selectedTables.add(first);
      renderDatasetList();
      renderJoinChecklist();
      showSchemaForTable(first);
      refreshQueryBar();
    }
  } catch (_) { /* server not ready — ignore */ }
}

// ---- Upload ----------------------------------------------------------------

['dragover', 'dragenter'].forEach((evt) =>
  dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add('dragover'); })
);
['dragleave', 'drop'].forEach((evt) =>
  dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); })
);

dropZone.addEventListener('drop', (e) => {
  const files = Array.from(e.dataTransfer.files).filter((f) => f.name.toLowerCase().endsWith('.csv'));
  if (files.length) uploadFiles(files);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files.length) uploadFiles(Array.from(fileInput.files));
});

async function uploadFiles(files) {
  clearError();
  setEngineStatus('ingesting csv');

  for (const file of files) {
    dropLabel.textContent = `Uploading ${file.name}…`;
    const form = new FormData();
    form.append('file', file);

    try {
      const res  = await fetch('/api/upload', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed.');

      state.datasets[data.dataset.table_name] = data.dataset;
      // First file uploaded becomes the active / selected table
      if (!state.activeTable) state.activeTable = data.dataset.table_name;
      state.selectedTables.add(data.dataset.table_name);
    } catch (err) {
      showError(err.message);
    }
  }

  dropLabel.textContent = 'Drop CSV(s) or click to choose';
  setEngineStatus('engine idle');
  renderDatasetList();
  renderJoinChecklist();
  showSchemaForTable(state.activeTable);
  refreshQueryBar();
}

// ---- Dataset list ----------------------------------------------------------

function renderDatasetList() {
  const entries = Object.values(state.datasets);
  if (!entries.length) {
    datasetList.innerHTML = '<div class="text-sm text-dim italic">Nothing loaded yet.</div>';
    return;
  }
  datasetList.innerHTML = '';
  entries.forEach((ds) => {
    const active = ds.table_name === state.activeTable;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      'text-left w-full border px-3 py-2 text-sm transition-colors ' +
      (active ? 'border-amber-dim bg-raised' : 'border-hairline hover:border-amber-dim');
    btn.innerHTML = `
      <div class="font-medium truncate">${ds.source_filename}</div>
      <div class="text-xs text-dim font-mono">${ds.row_count} rows · ${ds.columns.length} cols</div>
    `;
    btn.addEventListener('click', () => {
      state.activeTable = ds.table_name;
      renderDatasetList();
      showSchemaForTable(ds.table_name);
    });
    datasetList.appendChild(btn);
  });
}

function showSchemaForTable(tableName) {
  const ds = state.datasets[tableName];
  if (!ds) return;
  schemaPanel.classList.remove('hidden');
  schemaColumns.innerHTML = ds.columns
    .map((c) => {
      const num = ds.numeric_columns.includes(c);
      return `<div>${c} <span class="text-dim/60">${num ? '(num)' : '(text)'}</span></div>`;
    })
    .join('');
}

// ---- Join checklist --------------------------------------------------------

function renderJoinChecklist() {
  const entries = Object.values(state.datasets);
  if (entries.length < 2) { joinPanel.classList.add('hidden'); return; }
  joinPanel.classList.remove('hidden');
  joinChecklist.innerHTML = '';

  entries.forEach((ds) => {
    const id  = `chk-${ds.table_name}`;
    const lbl = document.createElement('label');
    lbl.htmlFor   = id;
    lbl.className = 'flex items-center gap-2 cursor-pointer text-sm py-1';

    const chk = document.createElement('input');
    chk.type      = 'checkbox';
    chk.id        = id;
    chk.checked   = state.selectedTables.has(ds.table_name);
    chk.className = 'accent-amber';
    chk.addEventListener('change', () => {
      chk.checked
        ? state.selectedTables.add(ds.table_name)
        : state.selectedTables.delete(ds.table_name);
      refreshQueryBar();
    });

    const span = document.createElement('span');
    span.className   = 'truncate';
    span.textContent = ds.source_filename;

    lbl.appendChild(chk);
    lbl.appendChild(span);
    joinChecklist.appendChild(lbl);
  });
}

function refreshQueryBar() {
  const count = state.selectedTables.size;
  if (count === 0) {
    questionInput.disabled = true;
    askButton.disabled     = true;
    queryHint.textContent  = 'Tick at least one dataset on the left to begin.';
  } else if (count === 1) {
    const ds = state.datasets[[...state.selectedTables][0]];
    questionInput.disabled = false;
    askButton.disabled     = false;
    queryHint.textContent  = `Asking about ${ds.source_filename}.`;
  } else {
    const names = [...state.selectedTables].map((t) => state.datasets[t].source_filename).join(', ');
    questionInput.disabled = false;
    askButton.disabled     = false;
    queryHint.textContent  =
      `Joining ${count} datasets: ${names}. The agent will write the JOIN automatically.`;
  }
}

// ---- Query -----------------------------------------------------------------

queryForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();

  const question = questionInput.value.trim();
  if (!question || !state.selectedTables.size) return;

  askButton.disabled    = true;
  askButton.textContent = 'Thinking…';
  setEngineStatus('translating question → sql');
  resultsSection.classList.add('hidden');

  try {
    const res  = await fetch('/api/query', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ question, table_names: [...state.selectedTables] }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Query failed.');
    renderResults(data);
    setEngineStatus('engine idle');
  } catch (err) {
    showError(err.message);
    setEngineStatus('engine idle');
  } finally {
    askButton.disabled    = false;
    askButton.textContent = 'Analyze';
  }
});

// ---- Results ---------------------------------------------------------------

function renderResults(data) {
  resultsSection.classList.remove('hidden');
  sqlOutput.textContent = data.sql;

  const thead = resultsTable.querySelector('thead');
  const tbody = resultsTable.querySelector('tbody');
  thead.innerHTML = `<tr>${data.columns.map((c) => `<th>${c}</th>`).join('')}</tr>`;
  tbody.innerHTML = data.rows
    .map((row) => {
      const cells = data.columns.map((c) => `<td>${row[c] === null ? '—' : row[c]}</td>`).join('');
      return `<tr class="${row.is_anomaly ? 'anomaly-row' : ''}">${cells}</tr>`;
    })
    .join('');

  if (data.anomaly_count > 0) {
    anomalyFlag.textContent = `${data.anomaly_count} outlier${data.anomaly_count === 1 ? '' : 's'} flagged`;
    anomalyFlag.className   = 'text-xs font-mono text-amber';
    anomalyFlag.classList.remove('hidden');
  } else {
    anomalyFlag.classList.add('hidden');
  }

  reportOutput.textContent = data.report;
  renderChart(data.columns, data.rows);
}

// ---- Chart -----------------------------------------------------------------

function renderChart(columns, rows) {
  lastChartData = { columns, rows };
  if (activeChart) { activeChart.destroy(); activeChart = null; }

  const numCols  = columns.filter(
    (c) => rows.length > 0 && rows.every((r) => r[c] === null || typeof r[c] === 'number')
  );
  const labelCol = columns.find((c) => !numCols.includes(c));

  if (!numCols.length || rows.length < 2 || rows.length > 60) {
    chartCanvas.classList.add('hidden');
    chartEmpty.classList.remove('hidden');
    chartEmpty.textContent = 'Not enough numeric data in this result to chart.';
    return;
  }
  chartCanvas.classList.remove('hidden');
  chartEmpty.classList.add('hidden');

  const labels  = labelCol ? rows.map((r) => String(r[labelCol])) : rows.map((_, i) => `Row ${i + 1}`);
  const palette = ['#E3A23C','#5FA88C','#D97A63','#8FA0A8','#7A5A26','#C97B3D','#4A8F76','#B0563F'];
  const choice  = chartTypeSelect.value;

  let type, data, extraOptions = {};

  if (choice === 'pie') {
    if (rows.length > 12) {
      chartCanvas.classList.add('hidden');
      chartEmpty.classList.remove('hidden');
      chartEmpty.textContent = 'Too many rows for a readable pie chart (max 12).';
      return;
    }
    type = 'pie';
    data = {
      labels,
      datasets: [{
        label: numCols[0],
        data:  rows.map((r) => r[numCols[0]]),
        backgroundColor: labels.map((_, i) => palette[i % palette.length]),
      }],
    };
    extraOptions = { plugins: { legend: { display: true, labels: { color: '#8FA0A8' } } } };
  } else {
    type = choice === 'auto' ? (rows.length > 15 ? 'line' : 'bar') : choice;
    data = {
      labels,
      datasets: numCols.slice(0, 4).map((col, i) => ({
        label: col,
        data:  rows.map((r) => r[col]),
        backgroundColor: palette[i % palette.length],
        borderColor:     palette[i % palette.length],
        borderRadius: 2,
        fill: false,
      })),
    };
    extraOptions = {
      plugins: { legend: { display: data.datasets.length > 1, labels: { color: '#8FA0A8' } } },
      scales: {
        x: { ticks: { color: '#8FA0A8' }, grid: { color: '#2B363D' } },
        y: { ticks: { color: '#8FA0A8' }, grid: { color: '#2B363D' } },
      },
    };
  }

  chartEmpty.textContent = 'Not enough numeric data in this result to chart.';
  activeChart = new Chart(chartCanvas, {
    type,
    data,
    options: { responsive: true, ...extraOptions },
  });
}

// ---- Boot ------------------------------------------------------------------
restoreSessionDatasets();
