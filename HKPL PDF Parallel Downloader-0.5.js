// ==UserScript==
// @name         HKPL PDF Parallel Downloader
// @namespace    hkpl-pdf-parallel-downloader
// @version      0.5
// @match        https://sls.hkpl.gov.hk/digital-collection/common/js/pdfjs/web/viewer.html*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const CONCURRENCY = 16;   // 并发数，可改 8 / 16 / 24
  const CHUNK_MB = 4;       // 每个分片大小，可改 4 / 8 / 16

  function getPdfUrl() {
    return new URLSearchParams(location.search).get('file');
  }

  function filenameFromUrl(url) {
    const u = new URL(url);
    return `hkpl_${u.searchParams.get('id') || Date.now()}.pdf`;
  }

  function mb(n) {
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function createPanel() {
    const box = document.createElement('div');
    box.style.cssText = `
      position: fixed;
      right: 80px;
      top: 10px;
      z-index: 999999;
      width: 280px;
      padding: 10px;
      background: white;
      border: 1px solid #ccc;
      border-radius: 8px;
      box-shadow: 0 3px 12px rgba(0,0,0,.25);
      font-size: 13px;
      color: #222;
    `;

    const btn = document.createElement('button');
    btn.textContent = '并发下载PDF';
    btn.style.cssText = `
      width: 100%;
      padding: 8px;
      border: 0;
      border-radius: 6px;
      background: #0b57d0;
      color: white;
      cursor: pointer;
      font-size: 14px;
    `;

    const text = document.createElement('div');
    text.textContent = '等待下载';
    text.style.cssText = `margin-top: 8px;`;

    const barWrap = document.createElement('div');
    barWrap.style.cssText = `
      margin-top: 8px;
      width: 100%;
      height: 8px;
      background: #e5e7eb;
      border-radius: 999px;
      overflow: hidden;
    `;

    const bar = document.createElement('div');
    bar.style.cssText = `
      width: 0%;
      height: 100%;
      background: #0b57d0;
      transition: width .15s linear;
    `;

    barWrap.appendChild(bar);
    box.appendChild(btn);
    box.appendChild(text);
    box.appendChild(barWrap);
    document.body.appendChild(box);

    return { btn, text, bar };
  }

  async function detectSize(url) {
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        Accept: 'application/pdf,*/*',
        Range: 'bytes=0-0'
      }
    });

    const contentRange = res.headers.get('content-range') || '';
    const match = contentRange.match(/\/(\d+)$/);

    if (res.status === 206 && match) {
      return Number(match[1]);
    }

    const len = Number(res.headers.get('content-length') || 0);
    if (res.status === 200 && len > 0) {
      throw new Error('服务器忽略 Range 请求，不能并发分段下载，只能单连接。');
    }

    const text = await res.clone().text().catch(() => '');
    throw new Error(`无法检测 PDF 大小。HTTP ${res.status}\n${text.slice(0, 300)}`);
  }

  async function fetchPart(url, start, end, onProgress) {
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        Accept: 'application/pdf,*/*',
        Range: `bytes=${start}-${end}`
      }
    });

    if (res.status !== 206) {
      const text = await res.clone().text().catch(() => '');
      throw new Error(`分片请求失败 HTTP ${res.status}\n${text.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress(value.length);
    }

    const expected = end - start + 1;
    if (received !== expected) {
      throw new Error(`分片大小不一致：expected ${expected}, got ${received}`);
    }

    return new Blob(chunks, { type: 'application/pdf' });
  }

  async function parallelDownload(ui) {
    const url = getPdfUrl();
    if (!url) throw new Error('没有找到 viewer.html 的 file 参数');

    ui.btn.disabled = true;
    ui.btn.textContent = '检测大小...';
    ui.text.textContent = '正在检测服务器是否支持分段下载...';

    const total = await detectSize(url);
    const filename = filenameFromUrl(url);
    const chunkSize = CHUNK_MB * 1024 * 1024;

    const ranges = [];
    for (let start = 0; start < total; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, total - 1);
      ranges.push({ index: ranges.length, start, end });
    }

    ui.btn.textContent = '下载中...';

    let downloaded = 0;
    const startedAt = performance.now();
    const parts = new Array(ranges.length);
    let next = 0;

    function updateProgress(delta) {
      downloaded += delta;
      const percent = downloaded / total * 100;
      const seconds = Math.max((performance.now() - startedAt) / 1000, 0.001);
      const speed = downloaded / seconds / 1024 / 1024;

      ui.bar.style.width = `${percent.toFixed(2)}%`;
      ui.text.textContent =
        `${mb(downloaded)} / ${mb(total)} (${percent.toFixed(1)}%)  ${speed.toFixed(2)} MB/s`;
    }

    async function worker() {
      while (next < ranges.length) {
        const item = ranges[next++];
        const blob = await fetchPart(url, item.start, item.end, updateProgress);
        parts[item.index] = blob;
      }
    }

    const workerCount = Math.min(CONCURRENCY, ranges.length);
    ui.text.textContent = `并发 ${workerCount}，共 ${ranges.length} 个分片...`;

    await Promise.all(Array.from({ length: workerCount }, worker));

    ui.text.textContent = '正在合并 PDF...';

    const finalBlob = new Blob(parts, { type: 'application/pdf' });
    if (finalBlob.size !== total) {
      throw new Error(`合并后大小不一致：expected ${total}, got ${finalBlob.size}`);
    }

    const objectUrl = URL.createObjectURL(finalBlob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);

    ui.bar.style.width = '100%';
    ui.text.textContent = `下载成功：${mb(finalBlob.size)}`;
    ui.btn.textContent = '下载成功';
  }

  const ui = createPanel();

  ui.btn.onclick = async () => {
    try {
      await parallelDownload(ui);
    } catch (e) {
      console.error('[HKPL] parallel download failed:', e);
      ui.btn.disabled = false;
      ui.btn.textContent = '重新下载';
      ui.text.textContent = '下载失败';
      alert(`下载失败：\n${e.message}`);
    }
  };

  console.log('[HKPL] parallel downloader ready:', getPdfUrl());
})();
