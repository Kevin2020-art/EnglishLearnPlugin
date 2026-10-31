// 状态管理
let lessonsMap = new Map(); // folderPath -> { folderPath, name, dirHandle, mp3Files, txtFiles, srtFiles, jsonFiles }
let currentLessonFolderPath = null;
let subtitles = []; // [{ index, start, end, en, zh }]
let currentIndex = 0;
let playState = "stopped"; // "stopped" | "playing" | "paused"
let showEn = true;
let showZh = true;
let stampMode = false;
let currentAudioObjectUrl = null;
let currentAudioFile = null;
let rafId = null;

// DOM 引用
const selectDirBtn = document.getElementById("selectDirBtn");
const dirInput = document.getElementById("dirInput");
const lessonSelectWrap = document.getElementById("lessonSelectWrap");
const lessonSelect = document.getElementById("lessonSelect");
const statusBadge = document.getElementById("statusBadge");
const toggleStampModeBtn = document.getElementById("toggleStampModeBtn");
const stampToolbar = document.getElementById("stampToolbar");
const stampStartBtn = document.getElementById("stampStartBtn");
const stampEndNextBtn = document.getElementById("stampEndNextBtn");
const autoAlignBtn = document.getElementById("autoAlignBtn");
const exportSrtBtn = document.getElementById("exportSrtBtn");
const exportJsonBtn = document.getElementById("exportJsonBtn");

const currentSentenceIndexEl = document.getElementById("currentSentenceIndex");
const currentSentenceTimeEl = document.getElementById("currentSentenceTime");
const stageEn = document.getElementById("stageEn");
const stageZh = document.getElementById("stageZh");
const subtitleList = document.getElementById("subtitleList");

const audioPlayer = document.getElementById("audioPlayer");
const currentTimeLabel = document.getElementById("currentTimeLabel");
const durationLabel = document.getElementById("durationLabel");
const progressBar = document.getElementById("progressBar");

const playStateDot = document.getElementById("playStateDot");
const playStateText = document.getElementById("playStateText");

const prevBtn = document.getElementById("prevBtn");
const playBtn = document.getElementById("playBtn");
const pauseBtn = document.getElementById("pauseBtn");
const resumeBtn = document.getElementById("resumeBtn");
const stopBtn = document.getElementById("stopBtn");
const nextBtn = document.getElementById("nextBtn");

const toggleEnBtn = document.getElementById("toggleEnBtn");
const toggleZhBtn = document.getElementById("toggleZhBtn");

// ================== IndexedDB 记住上次选择的目录句柄 ==================
const DB_NAME = "EnglishLearnPluginDB";
const STORE_NAME = "handles";

function openHandleDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveLastDirHandle(dirHandle) {
  try {
    const db = await openHandleDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(dirHandle, "lastDir");
  } catch (e) {
    console.warn("无法缓存目录句柄:", e);
  }
}

async function getLastDirHandle() {
  try {
    const db = await openHandleDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get("lastDir");
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

// 工具函数：判断文本是否为中文
function isChineseText(text) {
  const matches = text.match(/[\u4e00-\u9fff]/g);
  const zhCount = matches ? matches.length : 0;
  return zhCount > text.length * 0.08;
}

// 工具函数：格式化 mm:ss
function formatShortTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "00:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// 工具函数：格式化 mm:ss.xx
function formatPreciseTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "00:00.00";
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(2).padStart(5, "0");
  return `${String(m).padStart(2, "0")}:${s}`;
}

// 工具函数：格式化 SRT 时间 00:00:01,360
function formatSrtTime(seconds) {
  const ms = Math.round((seconds - Math.floor(seconds)) * 1000);
  const totalSec = Math.floor(seconds);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

// 解析 SRT 时间字符串 -> 秒
function parseSrtTimestamp(ts) {
  const m = ts.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return (
    parseInt(m[1], 10) * 3600 +
    parseInt(m[2], 10) * 60 +
    parseInt(m[3], 10) +
    parseInt(m[4].padEnd(3, "0").slice(0, 3), 10) / 1000
  );
}

// 解析标准 .srt 字幕文件
function parseSrtContent(srtText) {
  const blocks = srtText.replace(/\r\n/g, "\n").trim().split(/\n\s*\n/);
  const items = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    let timeLineIdx = lines[0].includes("-->") ? 0 : 1;
    if (!lines[timeLineIdx] || !lines[timeLineIdx].includes("-->")) continue;
    const [startStr, endStr] = lines[timeLineIdx].split("-->");
    const start = Number(parseSrtTimestamp(startStr).toFixed(2));
    const end = Number(parseSrtTimestamp(endStr).toFixed(2));
    const textLines = lines.slice(timeLineIdx + 1);
    let en = "";
    let zh = "";
    for (const tl of textLines) {
      const cleanLine = tl.replace(/\*\*/g, "").trim();
      if (isChineseText(cleanLine)) {
        zh = zh ? `${zh} ${cleanLine}` : cleanLine;
      } else {
        en = en ? `${en} ${cleanLine}` : cleanLine;
      }
    }
    items.push({
      index: items.length + 1,
      start,
      end,
      en,
      zh
    });
  }
  return items;
}

// 按自然句切分英文文本（保护 6.7 等小数点）
function splitEnglishSentences(text) {
  const fixed = text.replace(/Beyond the book Is your class/g, "Beyond the book. Is your class");
  const result = [];
  for (const rawLine of fixed.split(/\r?\n/)) {
    const line = rawLine.replace(/\*\*/g, "").trim();
    if (!line) continue;
    const safeLine = line.replace(/(\d)\.(\d)/g, "$1__DOT__$2");
    const parts = safeLine
      .split(/(?<=[.?!])\s+/)
      .map((p) => p.replace(/__DOT__/g, ".").trim())
      .filter(Boolean);
    parts.forEach((p, idx) => {
      result.push({ text: p, isParaEnd: idx === parts.length - 1 });
    });
  }
  return result;
}

// 按自然句切分中文文本
function splitChineseSentences(text) {
  const result = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\*\*/g, "").trim();
    if (!line) continue;
    const matches = line.match(/[^。？！：]+(?:(?:\d+\.\d+)[^。？！：]*)*(?:[。？！：]+|$)/g);
    if (matches) {
      for (const m of matches) {
        if (m.trim()) result.push(m.trim());
      }
    }
  }
  return result;
}

// 使用 Web Audio API 提取音频中的人声片段并动态规划对齐句子
async function autoDetectTimestampsFromAudio(mp3File, enMetaList, zhList) {
  const arrayBuffer = await mp3File.arrayBuffer();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  const sampleRate = audioBuffer.sampleRate;
  const ch0 = audioBuffer.getChannelData(0);
  const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : ch0;

  const frameSize = Math.floor(sampleRate * 0.01);
  const totalFrames = Math.floor(ch0.length / frameSize);
  const threshold = Math.pow(10, -35 / 20); // -35dB
  const minSilenceFrames = 35; // 0.35s

  const silences = [];
  let silenceStartFrame = null;

  for (let f = 0; f < totalFrames; f++) {
    let sumSq = 0;
    const offset = f * frameSize;
    for (let i = 0; i < frameSize; i++) {
      const sample = 0.5 * (ch0[offset + i] + ch1[offset + i]);
      sumSq += sample * sample;
    }
    const rms = Math.sqrt(sumSq / frameSize);
    if (rms < threshold) {
      if (silenceStartFrame === null) silenceStartFrame = f;
    } else {
      if (silenceStartFrame !== null) {
        if (f - silenceStartFrame >= minSilenceFrames) {
          silences.push([silenceStartFrame * 0.01, f * 0.01]);
        }
        silenceStartFrame = null;
      }
    }
  }
  if (silenceStartFrame !== null && totalFrames - silenceStartFrame >= minSilenceFrames) {
    silences.push([silenceStartFrame * 0.01, totalFrames * 0.01]);
  }

  await audioCtx.close();

  const chunks = [];
  if (silences.length === 0) {
    chunks.push([0, audioBuffer.duration]);
  } else {
    if (silences[0][0] > 0.2) {
      chunks.push([0, Number(silences[0][0].toFixed(2))]);
    }
    for (let i = 0; i < silences.length; i++) {
      const sEnd = silences[i][1];
      const sNext = i + 1 < silences.length ? silences[i + 1][0] : audioBuffer.duration;
      if (sNext - sEnd > 0.2) {
        chunks.push([Number(sEnd.toFixed(2)), Number(sNext.toFixed(2))]);
      }
    }
  }

  const N = enMetaList.length;
  const M = chunks.length;

  if (N === 0) return [];
  if (M < N) {
    const start0 = chunks.length ? chunks[0][0] : 0;
    const endAll = chunks.length ? chunks[chunks.length - 1][1] : audioBuffer.duration;
    const totalChars = enMetaList.reduce((acc, s) => acc + Math.max(1, s.text.length), 0);
    let cur = start0;
    return enMetaList.map((s, idx) => {
      const dur = ((endAll - start0) * Math.max(1, s.text.length)) / totalChars;
      const item = {
        index: idx + 1,
        start: Number(cur.toFixed(2)),
        end: Number((cur + dur).toFixed(2)),
        en: s.text,
        zh: zhList[idx] || ""
      };
      cur += dur;
      return item;
    });
  }

  const totalSpeech = chunks.reduce((acc, c) => acc + (c[1] - c[0]), 0);
  const totalChars = enMetaList.reduce((acc, s) => acc + s.text.length, 0);
  const secPerChar = totalSpeech / Math.max(1, totalChars);

  const INF = 1e18;
  const dp = Array.from({ length: N + 1 }, () => new Array(M + 1).fill(INF));
  const parent = Array.from({ length: N + 1 }, () => new Array(M + 1).fill(0));
  dp[0][0] = 0;

  for (let i = 1; i <= N; i++) {
    const { text, isParaEnd } = enMetaList[i - 1];
    const expDur = Math.max(0.8, text.length * secPerChar);
    for (let j = i; j <= M - (N - i); j++) {
      const kMin = Math.max(i - 1, j - 5);
      for (let k = kMin; k < j; k++) {
        if (dp[i - 1][k] >= INF) continue;
        let speechDur = 0;
        for (let c = k; c < j; c++) speechDur += chunks[c][1] - chunks[c][0];
        const durCost = Math.pow((speechDur - expDur) / Math.max(1.5, expDur * 0.5), 2);

        let internalGapCost = 0;
        for (let c = k; c < j - 1; c++) {
          const gap = chunks[c + 1][0] - chunks[c][1];
          internalGapCost += Math.pow(gap / 0.35, 3);
        }

        let boundaryCost = 0;
        if (j < M) {
          const gapAfter = chunks[j][0] - chunks[j - 1][1];
          if (gapAfter < 0.65) {
            boundaryCost += Math.pow((0.65 - gapAfter) / 0.15, 2);
          }
          if (isParaEnd && gapAfter < 1.0) {
            boundaryCost += 4.0;
          }
        }

        const cost = dp[i - 1][k] + durCost + internalGapCost + boundaryCost;
        if (cost < dp[i][j]) {
          dp[i][j] = cost;
          parent[i][j] = k;
        }
      }
    }
  }

  const aligned = new Array(N);
  let curr = M;
  for (let i = N; i >= 1; i--) {
    const prev = parent[i][curr];
    aligned[i - 1] = [chunks[prev][0], chunks[curr - 1][1]];
    curr = prev;
  }

  return enMetaList.map((s, idx) => ({
    index: idx + 1,
    start: Number(aligned[idx][0].toFixed(2)),
    end: Number(aligned[idx][1].toFixed(2)),
    en: s.text,
    zh: zhList[idx] || ""
  }));
}

// ================== 目录扫描与加载（优先使用 window.showDirectoryPicker） ==================
async function scanDirectoryHandle(dirHandle, parentPath = "") {
  const currentPath = parentPath ? `${parentPath}/${dirHandle.name}` : dirHandle.name;
  const group = {
    folderPath: currentPath,
    name: dirHandle.name,
    dirHandle,
    mp3Files: [],
    txtFiles: [],
    srtFiles: [],
    jsonFiles: []
  };

  const subDirs = [];
  for await (const entry of dirHandle.values()) {
    if (entry.kind === "file") {
      if (entry.name.startsWith(".")) continue;
      const lower = entry.name.toLowerCase();
      if (lower.endsWith(".mp3") || lower.endsWith(".srt") || lower.endsWith(".json") || lower.endsWith(".txt")) {
        const file = await entry.getFile();
        if (lower.endsWith(".mp3")) group.mp3Files.push(file);
        else if (lower.endsWith(".srt")) group.srtFiles.push(file);
        else if (lower.endsWith(".json")) group.jsonFiles.push(file);
        else if (lower.endsWith(".txt")) group.txtFiles.push(file);
      }
    } else if (entry.kind === "directory" && !entry.name.startsWith(".")) {
      subDirs.push(entry);
    }
  }

  // 按文件名排序保证稳定性
  group.mp3Files.sort((a, b) => a.name.localeCompare(b.name));
  group.srtFiles.sort((a, b) => a.name.localeCompare(b.name));
  group.jsonFiles.sort((a, b) => a.name.localeCompare(b.name));
  group.txtFiles.sort((a, b) => a.name.localeCompare(b.name));

  if (group.mp3Files.length > 0) {
    lessonsMap.set(currentPath, group);
  }

  subDirs.sort((a, b) => a.name.localeCompare(b.name));
  for (const sub of subDirs) {
    await scanDirectoryHandle(sub, currentPath);
  }
}

async function applyScannedLessons() {
  if (lessonsMap.size === 0) {
    statusBadge.textContent = "⚠️ 所选目录中未找到 .mp3 文件";
    return;
  }

  lessonSelect.innerHTML = "";
  for (const [folderPath, group] of lessonsMap.entries()) {
    const opt = document.createElement("option");
    opt.value = folderPath;
    opt.textContent = `${group.name} (${group.mp3Files[0].name})`;
    lessonSelect.appendChild(opt);
  }

  if (lessonsMap.size > 1) {
    lessonSelectWrap.classList.remove("hidden");
  } else {
    lessonSelectWrap.classList.add("hidden");
  }

  const firstFolderPath = lessonsMap.keys().next().value;
  await loadLesson(firstFolderPath);
}

// 点击“选择要播放的目录”：使用现代 File System Access API，不再弹出“上传”提示
selectDirBtn.addEventListener("click", async () => {
  if (typeof window.showDirectoryPicker === "function") {
    try {
      const dirHandle = await window.showDirectoryPicker({ mode: "read" });
      lessonsMap.clear();
      statusBadge.textContent = `正在扫描目录 ${dirHandle.name}...`;
      await scanDirectoryHandle(dirHandle);
      await saveLastDirHandle(dirHandle);
      await applyScannedLessons();
    } catch (err) {
      if (err && err.name !== "AbortError") {
        console.error("目录选择失败:", err);
        statusBadge.textContent = "⚠️ 目录读取失败，请重试";
      }
    }
  } else {
    // 降级兜底
    dirInput.click();
  }
});

// 兼容兜底：传统 input[webkitdirectory]
dirInput.addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  if (files.length === 0) return;

  lessonsMap.clear();

  for (const file of files) {
    const relPath = file.webkitRelativePath || file.name;
    const parts = relPath.split("/");
    const folderPath = parts.length > 1 ? parts.slice(0, -1).join("/") : "默认目录";
    const folderName = parts.length > 1 ? parts[parts.length - 2] : "默认目录";

    if (!lessonsMap.has(folderPath)) {
      lessonsMap.set(folderPath, {
        folderPath,
        name: folderName,
        dirHandle: null,
        mp3Files: [],
        txtFiles: [],
        srtFiles: [],
        jsonFiles: []
      });
    }

    const group = lessonsMap.get(folderPath);
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".mp3")) group.mp3Files.push(file);
    else if (lower.endsWith(".srt")) group.srtFiles.push(file);
    else if (lower.endsWith(".json")) group.jsonFiles.push(file);
    else if (lower.endsWith(".txt")) group.txtFiles.push(file);
  }

  for (const [key, val] of lessonsMap.entries()) {
    if (val.mp3Files.length === 0) lessonsMap.delete(key);
  }

  await applyScannedLessons();
});

lessonSelect.addEventListener("change", async () => {
  if (lessonSelect.value) {
    await loadLesson(lessonSelect.value);
  }
});

// 加载指定目录的课程
async function loadLesson(folderPath) {
  const group = lessonsMap.get(folderPath);
  if (!group) return;

  currentLessonFolderPath = folderPath;
  stopPlayback();
  statusBadge.textContent = `正在加载 ${group.name}...`;

  const mp3File = group.mp3Files[0];
  currentAudioFile = mp3File;
  if (currentAudioObjectUrl) {
    URL.revokeObjectURL(currentAudioObjectUrl);
  }
  currentAudioObjectUrl = URL.createObjectURL(mp3File);
  audioPlayer.src = currentAudioObjectUrl;

  // 先读取中英文 txt（备用或补充）
  let enText = "";
  let zhText = "";
  for (const tf of group.txtFiles) {
    const content = await tf.text();
    if (isChineseText(content)) {
      zhText = content;
    } else {
      enText = content;
    }
  }
  const enMetaList = enText ? splitEnglishSentences(enText) : [];
  const zhList = zhText ? splitChineseSentences(zhText) : [];

  let loadedSubtitles = [];
  let sourceDesc = "";

  // 优先读取 .srt 时间戳文件
  if (group.srtFiles.length > 0) {
    const srtFile = group.srtFiles[0];
    const srtContent = await srtFile.text();
    loadedSubtitles = parseSrtContent(srtContent);
    loadedSubtitles.forEach((item, idx) => {
      if (!item.zh && zhList[idx]) item.zh = zhList[idx];
      if (!item.en && enMetaList[idx]) item.en = enMetaList[idx].text;
    });
    sourceDesc = `已加载时间戳文件 ${srtFile.name} (${loadedSubtitles.length} 句)`;
  } else if (group.jsonFiles.length > 0) {
    // 其次读取 subtitles.json 时间戳文件
    const jsonFile = group.jsonFiles[0];
    try {
      const parsed = JSON.parse(await jsonFile.text());
      if (Array.isArray(parsed) && parsed.length > 0) {
        loadedSubtitles = parsed.map((it, idx) => ({
          index: idx + 1,
          start: Number(it.start) || 0,
          end: Number(it.end) || 0,
          en: it.en || (enMetaList[idx] ? enMetaList[idx].text : ""),
          zh: it.zh || zhList[idx] || ""
        }));
        sourceDesc = `已加载时间戳文件 ${jsonFile.name} (${loadedSubtitles.length} 句)`;
      }
    } catch (err) {
      console.error("解析 JSON 字幕失败:", err);
    }
  }

  // 如果目录里只有 mp3 + txt，自动分析音频波形生成时间戳
  if (loadedSubtitles.length === 0 && (enMetaList.length > 0 || zhList.length > 0)) {
    statusBadge.textContent = "⏳ 未检测到现成时间戳文件，正在根据音频波形生成时间戳...";
    loadedSubtitles = await autoDetectTimestampsFromAudio(mp3File, enMetaList, zhList);
    sourceDesc = `已从 TXT 自动对齐时间戳 (${loadedSubtitles.length} 句，可点击右侧打时间戳微调并保存)`;
  }

  subtitles = loadedSubtitles;
  currentIndex = 0;

  statusBadge.textContent = sourceDesc || `已加载音频 ${mp3File.name}`;
  toggleStampModeBtn.disabled = subtitles.length === 0;
  enableTransportControls(subtitles.length > 0);

  renderSubtitleList();
  updateStageDisplay();
}

function enableTransportControls(enabled) {
  progressBar.disabled = !enabled;
  prevBtn.disabled = !enabled;
  playBtn.disabled = !enabled;
  pauseBtn.disabled = !enabled;
  resumeBtn.disabled = !enabled;
  stopBtn.disabled = !enabled;
  nextBtn.disabled = !enabled;
}

// 渲染全文双语字幕列表
function renderSubtitleList() {
  subtitleList.innerHTML = "";
  if (subtitles.length === 0) {
    subtitleList.innerHTML = `<div class="empty-state"><p>当前目录未找到有效字幕内容</p></div>`;
    return;
  }

  subtitles.forEach((item, idx) => {
    const row = document.createElement("div");
    row.className = `subtitle-item${idx === currentIndex ? " active" : ""}`;
    row.dataset.index = idx;

    const indexCol = document.createElement("div");
    indexCol.className = "sub-index-col";
    indexCol.innerHTML = `
      <span class="sub-idx">#${String(idx + 1).padStart(2, "0")}</span>
      <span class="sub-time-badge" id="time-badge-${idx}">${formatPreciseTime(item.start)} - ${formatPreciseTime(item.end)}</span>
    `;

    const contentCol = document.createElement("div");
    contentCol.className = "sub-content-col";

    const enDiv = document.createElement("div");
    enDiv.className = `sub-en${showEn ? "" : " hidden-text"}`;
    enDiv.textContent = item.en;

    const zhDiv = document.createElement("div");
    zhDiv.className = `sub-zh${showZh ? "" : " hidden-text"}`;
    zhDiv.textContent = item.zh;

    contentCol.appendChild(enDiv);
    contentCol.appendChild(zhDiv);

    row.appendChild(indexCol);
    row.appendChild(contentCol);

    if (stampMode) {
      const stampCol = document.createElement("div");
      stampCol.className = "sub-stamp-col";
      stampCol.innerHTML = `
        <div class="time-input-group">
          <span>起</span>
          <input type="number" step="0.05" min="0" class="time-input start-input" value="${item.start.toFixed(2)}" />
        </div>
        <div class="time-input-group">
          <span>止</span>
          <input type="number" step="0.05" min="0" class="time-input end-input" value="${item.end.toFixed(2)}" />
        </div>
      `;
      stampCol.addEventListener("click", (ev) => ev.stopPropagation());

      const startInput = stampCol.querySelector(".start-input");
      const endInput = stampCol.querySelector(".end-input");

      startInput.addEventListener("change", () => {
        item.start = Math.max(0, Number(parseFloat(startInput.value).toFixed(2)) || 0);
        updateRowTimestampBadge(idx);
        if (idx === currentIndex) updateStageDisplay();
      });

      endInput.addEventListener("change", () => {
        item.end = Math.max(item.start, Number(parseFloat(endInput.value).toFixed(2)) || 0);
        updateRowTimestampBadge(idx);
        if (idx === currentIndex) updateStageDisplay();
      });

      row.appendChild(stampCol);
    }

    row.addEventListener("click", () => {
      jumpToSentence(idx, true);
    });

    subtitleList.appendChild(row);
  });
}

function updateRowTimestampBadge(idx) {
  const badge = document.getElementById(`time-badge-${idx}`);
  if (badge && subtitles[idx]) {
    badge.textContent = `${formatPreciseTime(subtitles[idx].start)} - ${formatPreciseTime(subtitles[idx].end)}`;
  }
}

// 更新顶部当前句大舞台与列表高亮
function updateStageDisplay(scrollIntoView = true) {
  if (subtitles.length === 0) {
    currentSentenceIndexEl.textContent = "第 0 / 0 句";
    currentSentenceTimeEl.textContent = "00:00.00 - 00:00.00";
    return;
  }

  const cur = subtitles[currentIndex] || subtitles[0];
  currentSentenceIndexEl.textContent = `第 ${currentIndex + 1} / ${subtitles.length} 句`;
  currentSentenceTimeEl.textContent = `${formatPreciseTime(cur.start)} - ${formatPreciseTime(cur.end)}`;
  stageEn.textContent = cur.en || "";
  stageZh.textContent = cur.zh || "";

  stageEn.classList.toggle("hidden-text", !showEn);
  stageZh.classList.toggle("hidden-text", !showZh);

  const rows = subtitleList.querySelectorAll(".subtitle-item");
  rows.forEach((r, idx) => {
    if (idx === currentIndex) {
      r.classList.add("active");
      if (scrollIntoView) {
        r.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    } else {
      r.classList.remove("active");
    }
  });
}

// 更新播放状态指示灯与按钮可用状态
function setPlayState(newState) {
  playState = newState;
  playStateDot.className = `state-dot ${newState}`;
  if (newState === "playing") {
    playStateText.textContent = "正在播放";
    pauseBtn.disabled = false;
    resumeBtn.disabled = true;
    startSyncLoop();
  } else if (newState === "paused") {
    playStateText.textContent = "已暂停";
    pauseBtn.disabled = true;
    resumeBtn.disabled = false;
    stopSyncLoop();
  } else {
    playStateText.textContent = "已停止";
    pauseBtn.disabled = true;
    resumeBtn.disabled = true;
    stopSyncLoop();
  }
}

// 跳转到指定句子
function jumpToSentence(idx, autoPlay = true) {
  if (subtitles.length === 0) return;
  const targetIdx = Math.max(0, Math.min(subtitles.length - 1, idx));
  currentIndex = targetIdx;
  const targetStart = subtitles[currentIndex].start;
  audioPlayer.currentTime = targetStart;
  updateStageDisplay(true);

  if (autoPlay) {
    audioPlayer.play();
    setPlayState("playing");
  }
}

// 1. 播放按钮
playBtn.addEventListener("click", () => {
  if (subtitles.length === 0) return;
  if (playState === "stopped") {
    audioPlayer.currentTime = subtitles[currentIndex].start;
  }
  audioPlayer.play();
  setPlayState("playing");
});

// 2. 暂停按钮
pauseBtn.addEventListener("click", () => {
  if (!audioPlayer.paused) {
    audioPlayer.pause();
    setPlayState("paused");
  }
});

// 3. 继续按钮
resumeBtn.addEventListener("click", () => {
  if (audioPlayer.paused && subtitles.length > 0) {
    audioPlayer.play();
    setPlayState("playing");
  }
});

// 4. 停止按钮
function stopPlayback() {
  audioPlayer.pause();
  audioPlayer.currentTime = 0;
  currentIndex = 0;
  progressBar.value = 0;
  currentTimeLabel.textContent = "00:00";
  setPlayState("stopped");
  if (subtitles.length > 0) {
    updateStageDisplay(true);
  }
}

stopBtn.addEventListener("click", stopPlayback);

// 5. 上一句按钮
prevBtn.addEventListener("click", () => {
  if (subtitles.length === 0) return;
  const nextIdx = Math.max(0, currentIndex - 1);
  jumpToSentence(nextIdx, true);
});

// 6. 下一句按钮
nextBtn.addEventListener("click", () => {
  if (subtitles.length === 0) return;
  const nextIdx = Math.min(subtitles.length - 1, currentIndex + 1);
  jumpToSentence(nextIdx, true);
});

// 7. 显示/隐藏英文
toggleEnBtn.addEventListener("click", () => {
  showEn = !showEn;
  toggleEnBtn.textContent = showEn ? "👁️ 隐藏英文" : "👁️ 显示英文";
  toggleEnBtn.classList.toggle("active", showEn);
  stageEn.classList.toggle("hidden-text", !showEn);
  subtitleList.querySelectorAll(".sub-en").forEach((el) => {
    el.classList.toggle("hidden-text", !showEn);
  });
});

// 8. 显示/隐藏中文
toggleZhBtn.addEventListener("click", () => {
  showZh = !showZh;
  toggleZhBtn.textContent = showZh ? "👁️ 隐藏中文" : "👁️ 显示中文";
  toggleZhBtn.classList.toggle("active", showZh);
  stageZh.classList.toggle("hidden-text", !showZh);
  subtitleList.querySelectorAll(".sub-zh").forEach((el) => {
    el.classList.toggle("hidden-text", !showZh);
  });
});

// 音频进度条与时间同步
audioPlayer.addEventListener("loadedmetadata", () => {
  durationLabel.textContent = formatShortTime(audioPlayer.duration);
  progressBar.max = audioPlayer.duration || 100;
});

progressBar.addEventListener("input", () => {
  const t = parseFloat(progressBar.value);
  audioPlayer.currentTime = t;
  currentTimeLabel.textContent = formatShortTime(t);
  syncSentenceByTime(t);
});

audioPlayer.addEventListener("ended", () => {
  setPlayState("stopped");
});

function syncSentenceByTime(t) {
  if (subtitles.length === 0) return;
  let matchedIdx = currentIndex;
  for (let i = 0; i < subtitles.length; i++) {
    const s = subtitles[i].start;
    const nextS = i + 1 < subtitles.length ? subtitles[i + 1].start : Infinity;
    if (t >= s - 0.05 && t < nextS - 0.05) {
      matchedIdx = i;
      break;
    }
  }

  if (matchedIdx !== currentIndex) {
    currentIndex = matchedIdx;
    updateStageDisplay(true);
  }
}

function startSyncLoop() {
  stopSyncLoop();
  function tick() {
    const t = audioPlayer.currentTime;
    progressBar.value = t;
    currentTimeLabel.textContent = formatShortTime(t);
    syncSentenceByTime(t);
    if (!audioPlayer.paused) {
      rafId = requestAnimationFrame(tick);
    }
  }
  rafId = requestAnimationFrame(tick);
}

function stopSyncLoop() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

// ================== 打时间戳 / 微调与直接写入文件夹 ==================
toggleStampModeBtn.addEventListener("click", () => {
  stampMode = !stampMode;
  stampToolbar.classList.toggle("hidden", !stampMode);
  toggleStampModeBtn.textContent = stampMode ? "✖ 关闭打时间戳面板" : "⏱️ 打时间戳 / 微调";
  renderSubtitleList();
});

function stampCurrentStart() {
  if (subtitles.length === 0) return;
  const now = Number(audioPlayer.currentTime.toFixed(2));
  subtitles[currentIndex].start = now;
  if (subtitles[currentIndex].end < now) {
    subtitles[currentIndex].end = Number((now + 2.0).toFixed(2));
  }
  renderSubtitleList();
  updateStageDisplay(false);
}

function stampCurrentEndAndAdvance() {
  if (subtitles.length === 0) return;
  const now = Number(audioPlayer.currentTime.toFixed(2));
  subtitles[currentIndex].end = Math.max(subtitles[currentIndex].start, now);
  if (currentIndex + 1 < subtitles.length) {
    currentIndex += 1;
    if (subtitles[currentIndex].start < now) {
      subtitles[currentIndex].start = now;
      if (subtitles[currentIndex].end <= now) {
        subtitles[currentIndex].end = Number((now + 2.5).toFixed(2));
      }
    }
  }
  renderSubtitleList();
  updateStageDisplay(true);
}

stampStartBtn.addEventListener("click", stampCurrentStart);
stampEndNextBtn.addEventListener("click", stampCurrentEndAndAdvance);

autoAlignBtn.addEventListener("click", async () => {
  if (!currentAudioFile || subtitles.length === 0) return;
  statusBadge.textContent = "⏳ 正在重新自动识别时间戳...";
  const enMetaList = subtitles.map((s) => ({ text: s.en, isParaEnd: false }));
  const zhList = subtitles.map((s) => s.zh);
  subtitles = await autoDetectTimestampsFromAudio(currentAudioFile, enMetaList, zhList);
  renderSubtitleList();
  updateStageDisplay(false);
  statusBadge.textContent = `✅ 已重新对齐 ${subtitles.length} 句时间戳`;
});

// 优先直接写入当前课程目录句柄，若无句柄则触发浏览器下载
async function saveFileToCurrentDirOrDownload(content, filename, mimeType) {
  const group = currentLessonFolderPath ? lessonsMap.get(currentLessonFolderPath) : null;
  if (group && group.dirHandle && typeof group.dirHandle.getFileHandle === "function") {
    try {
      const fileHandle = await group.dirHandle.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(content);
      await writable.close();
      statusBadge.textContent = `✅ 已直接保存到目录: ${group.name}/${filename}`;
      return;
    } catch (err) {
      console.warn("直接写入目录未成功，改为下载保存:", err);
    }
  }
  downloadTextFile(content, filename, mimeType);
}

exportSrtBtn.addEventListener("click", async () => {
  if (subtitles.length === 0) return;
  const lines = [];
  subtitles.forEach((item, idx) => {
    lines.push(String(idx + 1));
    lines.push(`${formatSrtTime(item.start)} --> ${formatSrtTime(item.end)}`);
    if (item.en) lines.push(item.en);
    if (item.zh) lines.push(item.zh);
    lines.push("");
  });
  await saveFileToCurrentDirOrDownload(lines.join("\n"), "subtitles.srt", "text/plain;charset=utf-8");
});

exportJsonBtn.addEventListener("click", async () => {
  if (subtitles.length === 0) return;
  const content = JSON.stringify(subtitles, null, 2);
  await saveFileToCurrentDirOrDownload(content, "subtitles.json", "application/json;charset=utf-8");
});

function downloadTextFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// 键盘快捷键支持
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  if (subtitles.length === 0) return;

  if (stampMode && (e.key === "s" || e.key === "S")) {
    e.preventDefault();
    stampCurrentStart();
  } else if (stampMode && (e.key === "d" || e.key === "D")) {
    e.preventDefault();
    stampCurrentEndAndAdvance();
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    prevBtn.click();
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    nextBtn.click();
  }
});

// 启动时检查是否有上次记住的目录
(async function initCheckLastDir() {
  const lastHandle = await getLastDirHandle();
  if (lastHandle) {
    statusBadge.textContent = `上次目录: ${lastHandle.name}（点击「选择要播放的目录」可重新加载或切换）`;
  }
})();
