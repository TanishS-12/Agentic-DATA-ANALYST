const state = {
  datasets: {},
  activeTable: null,
};

const el = (id) => document.getElementById(id);

const dropZone = el('drop-zone');
const fileInput = el('file-input');
const dropLabel = el('drop-label');
const datasetList = el('dataset-list');
const schemaPanel = el('schema-panel');
const schemaColumns = el('schema-columns');
const questionInput = el('question-input');
const askButton = el('ask-button');
const queryHint = el('query-hint');
const queryForm = el('query-form');
const resultsSection = el('results');
const sqlOutput = el('sql-output');
const resultsTable = el('results-table');
const anomalyFlag = el('anomaly-flag');
const reportOutput = el('report-output');
const errorBox = el('error-box');
const engineStatus = el('engine-status');
const chartCanvas = el('result-chart');
const chartEmpty = el('chart-empty');
const chartTypeSelect = el('chart-type-select');
let activeChart = null;
let lastChartData = null;

chartTypeSelect.addEventListener('change', () => {
  if (lastChartData) {
    renderChart(lastChartData.columns, lastChartData.rows);
  }
});

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove('hidden');
}

function clearError() {
  errorBox.classList.add('hidden');
  errorBox.textContent = '';
}

function setEngineStatus(text) {
  engineStatus.textContent = text;
}

// ---- Upload handling -------------------------------------------------

['dragover', 'dragenter'].forEach((evt) =>
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  })
);
['dragleave', 'drop'].forEach((evt) =>
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
  })
);
dropZone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) uploadFile(file);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) uploadFile(fileInput.files[0]);
});

async function uploadFile(file) {
  clearError();
  dropLabel.textContent = `Uploading ${file.name}…`;
  setEngineStatus('ingesting csv');

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed.');

    state.datasets[data.dataset.table_name] = data.dataset;
    renderDatasetList();
    selectDataset(data.dataset.table_name);
    dropLabel.textContent = 'Drop a CSV or click to choose one';
    setEngineStatus('engine idle');
  } catch (err) {
    dropLabel.textContent = 'Drop a CSV or click to choose one';
    showError(err.message);
    setEngineStatus('engine idle');
  }
}

function renderDatasetList() {
  const entries = Object.values(state.datasets);
  if (entries.length === 0) {
    datasetList.innerHTML = '<div class="text-sm text-dim italic">Nothing loaded yet.</div>';
    return;
  }
  datasetList.innerHTML = '';
  entries.forEach((ds) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className =
      'text-left w-full border px-3 py-2 text-sm transition-colors ' +
      (ds.table_name === state.activeTable
        ? 'border-amber-dim bg-raised'
        : 'border-hairline hover:border-amber-dim');
    button.innerHTML = `
      <div class="font-medium truncate">${ds.source_filename}</div>
      <div class="text-xs text-dim font-mono">${ds.row_count} rows · ${ds.columns.length} cols</div>
    `;
    button.addEventListener('click', () => selectDataset(ds.table_name));
    datasetList.appendChild(button);
  });
}

function selectDataset(tableName) {
  state.activeTable = tableName;
  renderDatasetList();

  const ds = state.datasets[tableName];
  schemaPanel.classList.remove('hidden');
  schemaColumns.innerHTML = ds.columns
    .map((c) => {
      const isNumeric = ds.numeric_columns.includes(c);
      return `<div>${c} <span class="text-dim/60">${isNumeric ? '(num)' : '(text)'}</span></div>`;
    })
    .join('');

  questionInput.disabled = false;
  askButton.disabled = false;
  queryHint.textContent = `Asking questions about ${ds.source_filename}.`;
}

// ---- Query handling ----------------------------------------------------

queryForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();

  const question = questionInput.value.trim();
  if (!question || !state.activeTable) return;

  askButton.disabled = true;
  askButton.textContent = 'Thinking…';
  setEngineStatus('translating question → sql');
  resultsSection.classList.add('hidden');

  try {
    const res = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, table_name: state.activeTable }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Query failed.');

    renderResults(data);
    setEngineStatus('engine idle');
  } catch (err) {
    showError(err.message);
    setEngineStatus('engine idle');
  } finally {
    askButton.disabled = false;
    askButton.textContent = 'Analyze';
  }
});

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
    anomalyFlag.className = 'text-xs font-mono text-amber';
    anomalyFlag.classList.remove('hidden');
  } else {
    anomalyFlag.classList.add('hidden');
  }

  reportOutput.textContent = data.report;
  renderChart(data.columns, data.rows);
}

function renderChart(columns, rows) {
  lastChartData = { columns, rows };

  if (activeChart) {
    activeChart.destroy();
    activeChart = null;
  }

  const numericCols = columns.filter(
    (c) => rows.length > 0 && rows.every((r) => r[c] === null || typeof r[c] === 'number')
  );
  const labelCol = columns.find((c) => !numericCols.includes(c));

  if (numericCols.length === 0 || rows.length < 2 || rows.length > 60) {
    chartCanvas.classList.add('hidden');
    chartEmpty.classList.remove('hidden');
    return;
  }
  chartCanvas.classList.remove('hidden');
  chartEmpty.classList.add('hidden');

  const labels = labelCol
    ? rows.map((r) => String(r[labelCol]))
    : rows.map((_, i) => `Row ${i + 1}`);

  const palette = ['#E3A23C', '#5FA88C', '#D97A63', '#8FA0A8', '#7A5A26', '#C97B3D', '#4A8F76', '#B0563F'];
  const choice = chartTypeSelect.value; // 'auto' | 'bar' | 'line' | 'pie'

  let type, data, extraOptions = {};

  if (choice === 'pie') {
    // Pie charts only make sense as one value per label, so use the first
    // numeric column and require the row count to be small enough to read.
    if (rows.length > 12) {
      chartCanvas.classList.add('hidden');
      chartEmpty.classList.remove('hidden');
      chartEmpty.textContent = 'Too many rows for a readable pie chart (try 12 or fewer).';
      return;
    }
    type = 'pie';
    data = {
      labels,
      datasets: [
        {
          label: numericCols[0],
          data: rows.map((r) => r[numericCols[0]]),
          backgroundColor: labels.map((_, i) => palette[i % palette.length]),
        },
      ],
    };
    extraOptions = { plugins: { legend: { display: true, labels: { color: '#8FA0A8' } } } };
  } else {
    type = choice === 'auto' ? (rows.length > 15 ? 'line' : 'bar') : choice;
    data = {
      labels,
      datasets: numericCols.slice(0, 4).map((col, i) => ({
        label: col,
        data: rows.map((r) => r[col]),
        backgroundColor: palette[i % palette.length],
        borderColor: palette[i % palette.length],
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