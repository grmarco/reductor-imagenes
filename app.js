const fileInput = document.querySelector('#file-input');
const startButton = document.querySelector('#start-button');
const logEl = document.querySelector('#log');
const resultsEl = document.querySelector('#results');
const statusEl = document.querySelector('#status');
const fileSummary = document.querySelector('#file-summary');
const targetSizeInput = document.querySelector('#target-size');
const unitSelect = document.querySelector('#size-unit');
const formatSelect = document.querySelector('#format-select');
const suffixInput = document.querySelector('#suffix-input');

let selectedFiles = [];
let activeDownloadUrls = [];

fileInput.addEventListener('change', () => {
  selectedFiles = Array.from(fileInput.files || []);
  if (!selectedFiles.length) {
    fileSummary.textContent = 'Ningún archivo seleccionado';
    return;
  }
  const totalSize = selectedFiles.reduce((acc, file) => acc + file.size, 0);
  const pretty = formatBytes(totalSize);
  fileSummary.textContent = `${selectedFiles.length} archivo(s), ${pretty} en total`;
});

startButton.addEventListener('click', async () => {
  if (!selectedFiles.length) {
    alert('Selecciona al menos una imagen para continuar.');
    return;
  }

  const rawValue = Number.parseFloat(targetSizeInput.value);
  if (!Number.isFinite(rawValue) || rawValue <= 0) {
    alert('Introduce un número positivo para el tamaño objetivo.');
    return;
  }

  const multiplier = unitSelect.value === 'KB' ? 1024 : 1024 * 1024;
  const targetBytes = Math.round(rawValue * multiplier);
  const preferredType = formatSelect.value;
  const suffix = suffixInput.value.trim() || '_monica';

  resetResults();
  startButton.disabled = true;
  setStatus('Procesando...');
  appendLog(
    `Procesando ${selectedFiles.length} archivo(s) → ${targetBytes} bytes (formato ${preferredType === 'auto' ? 'automático' : preferredType}).`
  );

  for (const [index, file] of selectedFiles.entries()) {
    appendLog(`→ (${index + 1}/${selectedFiles.length}) ${file.name}`);
    try {
      const outcome = await reduceImage(file, {
        targetBytes,
        preferredType,
        suffix,
        minQuality: 30,
        maxQuality: 95,
        scaleFloor: 0.35,
        scaleStep: 0.82,
      });
      registerResult(outcome);
      const marker = outcome.success ? 'OK' : 'Ajuste parcial';
      appendLog(
        `   [${marker}] ${outcome.downloadName} → ${formatBytes(outcome.finalBytes)}, calidad ${outcome.quality}, escala ${outcome.scale.toFixed(2)}`
      );
    } catch (error) {
      console.error(error);
      appendLog(`   [Error] ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  setStatus('Completado');
  startButton.disabled = false;
});

window.addEventListener('beforeunload', () => {
  activeDownloadUrls.forEach((url) => URL.revokeObjectURL(url));
  activeDownloadUrls = [];
});

function resetResults() {
  activeDownloadUrls.forEach((url) => URL.revokeObjectURL(url));
  activeDownloadUrls = [];
  resultsEl.innerHTML = '';
  logEl.textContent = '';
}

function setStatus(message) {
  statusEl.textContent = message;
}

function appendLog(message) {
  const now = new Date();
  const timestamp = now.toLocaleTimeString();
  logEl.textContent += `[${timestamp}] ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function registerResult(outcome) {
  const card = document.createElement('div');
  card.className = 'result-card';

  const meta = document.createElement('div');
  meta.innerHTML = `
    <strong>${outcome.downloadName}</strong>
    <span class="result-meta">${formatBytes(outcome.finalBytes)} · calidad ${outcome.quality} · escala ${outcome.scale.toFixed(2)}</span>
  `;

  const action = document.createElement('a');
  action.className = 'download-link';
  action.href = outcome.objectUrl;
  action.download = outcome.downloadName;
  action.textContent = 'Descargar';

  card.appendChild(meta);
  card.appendChild(action);
  resultsEl.appendChild(card);

  activeDownloadUrls.push(outcome.objectUrl);
}

function formatBytes(value) {
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${value} bytes`;
}

async function reduceImage(file, options) {
  const { targetBytes, preferredType, suffix, minQuality, maxQuality, scaleFloor, scaleStep } = options;
  if (targetBytes <= 0) {
    throw new Error('El tamaño objetivo debe ser un número positivo.');
  }

  const img = await loadImageFromFile(file);
  const baseType = selectTargetType(file.type, preferredType);

  const qualityRange = {
    min: Math.max(5, Math.min(100, minQuality)),
    max: Math.max(5, Math.min(100, maxQuality)),
  };
  if (qualityRange.max < qualityRange.min) {
    [qualityRange.min, qualityRange.max] = [qualityRange.max, qualityRange.min];
  }

  let scale = 1;
  let bestCandidate = null;
  let closestOver = null;

  const width = img.naturalWidth;
  const height = img.naturalHeight;

  while (scale >= scaleFloor) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) {
      throw new Error('No fue posible inicializar el contexto de canvas.');
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    let low = qualityRange.min;
    let high = qualityRange.max;
    let localCandidate = null;

    while (low <= high) {
      const q = Math.floor((low + high) / 2);
      const quality = q / 100;
      const blob = await canvasToBlob(canvas, baseType, quality);
      const size = blob.size;
      if (size <= targetBytes) {
        localCandidate = { blob, size, quality: q, scale };
        low = q + 1;
      } else {
        if (!closestOver || size < closestOver.size) {
          closestOver = { blob, size, quality: q, scale };
        }
        high = q - 1;
      }
    }

    if (localCandidate) {
      if (!bestCandidate || localCandidate.size > bestCandidate.size) {
        bestCandidate = localCandidate;
      }
      if (bestCandidate.size >= targetBytes * 0.98) {
        canvas.width = 0;
        canvas.height = 0;
        break;
      }
    }

    canvas.width = 0;
    canvas.height = 0;
    scale = parseFloat((scale * scaleStep).toFixed(4));
  }

  if (!bestCandidate) {
    if (closestOver) {
      bestCandidate = closestOver;
    } else {
      const blob = await canvasToBlobFromImage(img, baseType, qualityRange.min / 100);
      bestCandidate = { blob, size: blob.size, quality: qualityRange.min, scale: 1 };
    }
  }

  const downloadName = buildDownloadName(file.name, suffix, baseType);
  const objectUrl = URL.createObjectURL(bestCandidate.blob);

  return {
    success: bestCandidate.size <= targetBytes,
    finalBytes: bestCandidate.size,
    quality: bestCandidate.quality,
    scale: bestCandidate.scale,
    downloadName,
    objectUrl,
  };
}

function selectTargetType(originalType, preferred) {
  if (preferred && preferred !== 'auto') {
    return preferred;
  }
  if (originalType) {
    return originalType;
  }
  return 'image/jpeg';
}

function buildDownloadName(originalName, suffix, mimeType) {
  const extension = mimeTypeToExtension(mimeType);
  const dotIndex = originalName.lastIndexOf('.');
  const base = dotIndex > -1 ? originalName.slice(0, dotIndex) : originalName;
  return `${base}${suffix}${extension}`;
}

function mimeTypeToExtension(type) {
  switch (type) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    default:
      return '.jpg';
  }
}

async function loadImageFromFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = (event) => reject(new Error(`No se pudo leer ${file.name}`));
      img.src = url;
    });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasToBlob(canvas, mimeType, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Falló la compresión; toBlob devolvió null.'));
        } else {
          resolve(blob);
        }
      },
      mimeType,
      normalizeQuality(mimeType, quality)
    );
  });
}

async function canvasToBlobFromImage(img, mimeType, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('No fue posible inicializar el contexto de canvas.');
  }
  ctx.drawImage(img, 0, 0);
  return canvasToBlob(canvas, mimeType, quality);
}

function normalizeQuality(mimeType, quality) {
  if (mimeType === 'image/png') {
    return undefined;
  }
  return Math.min(1, Math.max(0.05, quality));
}
