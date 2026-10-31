#!/usr/bin/env python3
"""
为英文听力目录生成标准双语时间戳文件 (subtitles.srt 与 subtitles.json)
用法:
    python3 generate_timestamps.py [目录路径，默认 ./resources]
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path


def is_chinese_text(text: str) -> bool:
    zh_chars = len(re.findall(r"[\u4e00-\u9fff]", text))
    return zh_chars > len(text) * 0.1


def split_english_sentences(text: str):
    """按自然句切分英文文本，保留是否段落末尾的标记，保护小数点不切分。"""
    # 修正常见的标题漏句号情况
    text = text.replace("Beyond the book Is your class", "Beyond the book. Is your class")
    sents = []
    for line in text.splitlines():
        line = re.sub(r"\*\*.*?\*\*", lambda m: m.group(0).replace("*", ""), line).strip()
        if not line:
            continue
        parts = [p.strip() for p in re.split(r"(?<=[.?!])(?<!\d\.)\s+", line) if p.strip()]
        for idx, p in enumerate(parts):
            sents.append((p, idx == len(parts) - 1))
    return sents


def split_chinese_sentences(text: str):
    """按自然句切分中文文本，去除 Markdown 加粗符号。"""
    sents = []
    for line in text.splitlines():
        line = re.sub(r"\*\*.*?\*\*", lambda m: m.group(0).replace("*", ""), line).strip()
        if not line:
            continue
        parts = re.findall(r"[^。？！：]+(?:(?:\d+\.\d+)[^。？！：]*)*(?:[。？！：]+|$)", line)
        for p in parts:
            if p.strip():
                sents.append(p.strip())
    return sents


def detect_audio_chunks(mp3_path: Path, noise_db: int = -35, min_silence: float = 0.35):
    """使用 ffmpeg silencedetect 提取音频中的人声发音片段。"""
    cmd = [
        "ffmpeg",
        "-i",
        str(mp3_path),
        "-af",
        f"silencedetect=noise={noise_db}dB:d={min_silence}",
        "-f",
        "null",
        "-",
    ]
    out = subprocess.check_output(cmd, stderr=subprocess.STDOUT).decode("utf-8", errors="ignore")

    dur_match = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.\d+)", out)
    total_duration = 0.0
    if dur_match:
        h, m, s = int(dur_match.group(1)), int(dur_match.group(2)), float(dur_match.group(3))
        total_duration = h * 3600 + m * 60 + s

    starts = [float(x) for x in re.findall(r"silence_start:\s*([0-9.]+)", out)]
    ends = [float(x) for x in re.findall(r"silence_end:\s*([0-9.]+)", out)]

    chunks = []
    # 如果音频一开头就有声音（第一个 silence_start > 0.2 且在第一个 silence_end 之前）
    if starts and (not ends or starts[0] < ends[0] - 0.1) and starts[0] > 0.2:
        chunks.append((0.0, starts[0]))

    for i, s_end in enumerate(ends):
        # 找下一个 silence_start
        next_starts = [st for st in starts if st > s_end + 0.05]
        s_next = next_starts[0] if next_starts else total_duration
        if s_next - s_end > 0.2:
            chunks.append((round(s_end, 2), round(s_next, 2)))

    return chunks


def align_sentences_to_chunks(en_sents_with_meta, zh_sents, chunks):
    """使用动态规划将 M 个原子语音块精准对齐到 N 个句子。"""
    N = len(en_sents_with_meta)
    M = len(chunks)
    if M < N:
        # 若原子块少于句子数，按字数比例线性分配
        total_start = chunks[0][0] if chunks else 0.0
        total_end = chunks[-1][1] if chunks else N * 3.0
        total_chars = sum(max(1, len(s[0])) for s in en_sents_with_meta)
        cur = total_start
        result = []
        for idx, (en_text, _) in enumerate(en_sents_with_meta):
            dur = (total_end - total_start) * (max(1, len(en_text)) / total_chars)
            zh_text = zh_sents[idx] if idx < len(zh_sents) else ""
            result.append({
                "index": idx + 1,
                "start": round(cur, 2),
                "end": round(cur + dur, 2),
                "en": en_text,
                "zh": zh_text,
            })
            cur += dur
        return result

    total_speech = sum(e - s for s, e in chunks)
    total_chars = sum(len(s[0]) for s in en_sents_with_meta)
    sec_per_char = total_speech / max(1, total_chars)

    INF = 1e18
    dp = [[INF] * (M + 1) for _ in range(N + 1)]
    parent = [[0] * (M + 1) for _ in range(N + 1)]
    dp[0][0] = 0.0

    for i in range(1, N + 1):
        text, is_para_end = en_sents_with_meta[i - 1]
        exp_dur = max(0.8, len(text) * sec_per_char)
        for j in range(i, M - (N - i) + 1):
            for k in range(max(i - 1, j - 5), j):
                if dp[i - 1][k] >= INF:
                    continue
                speech_dur = sum(chunks[c][1] - chunks[c][0] for c in range(k, j))
                dur_cost = ((speech_dur - exp_dur) / max(1.5, exp_dur * 0.5)) ** 2

                internal_gap_cost = 0.0
                for c in range(k, j - 1):
                    gap = chunks[c + 1][0] - chunks[c][1]
                    internal_gap_cost += (gap / 0.35) ** 3

                boundary_cost = 0.0
                if j < M:
                    gap_after = chunks[j][0] - chunks[j - 1][1]
                    if gap_after < 0.65:
                        boundary_cost += ((0.65 - gap_after) / 0.15) ** 2
                    if is_para_end and gap_after < 1.0:
                        boundary_cost += 4.0

                cost = dp[i - 1][k] + dur_cost + internal_gap_cost + boundary_cost
                if cost < dp[i][j]:
                    dp[i][j] = cost
                    parent[i][j] = k

    aligned = []
    curr = M
    for i in range(N, 0, -1):
        prev = parent[i][curr]
        aligned.append((chunks[prev][0], chunks[curr - 1][1]))
        curr = prev
    aligned.reverse()

    result = []
    for idx, ((s, e), (en_text, _)) in enumerate(zip(aligned, en_sents_with_meta)):
        zh_text = zh_sents[idx] if idx < len(zh_sents) else ""
        result.append({
            "index": idx + 1,
            "start": round(s, 2),
            "end": round(e, 2),
            "en": en_text,
            "zh": zh_text,
        })
    return result


def format_srt_time(seconds: float) -> str:
    ms = int(round((seconds - int(seconds)) * 1000))
    total_sec = int(seconds)
    s = total_sec % 60
    m = (total_sec // 60) % 60
    h = total_sec // 3600
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def process_directory(folder: Path):
    mp3_files = sorted(folder.glob("*.mp3"))
    txt_files = [
        p for p in sorted(folder.glob("*.txt"))
        if p.name.lower() not in ("subtitles.txt",)
    ]
    if not mp3_files or len(txt_files) < 1:
        print(f"跳过 {folder}: 未找到 mp3 或 txt 文件")
        return

    mp3_path = mp3_files[0]
    en_text, zh_text = "", ""
    for txt_path in txt_files:
        content = txt_path.read_text(encoding="utf-8", errors="ignore")
        if is_chinese_text(content):
            zh_text = content
        else:
            en_text = content

    en_sents = split_english_sentences(en_text)
    zh_sents = split_chinese_sentences(zh_text)
    chunks = detect_audio_chunks(mp3_path)
    items = align_sentences_to_chunks(en_sents, zh_sents, chunks)

    # 1. 保存 subtitles.json
    json_path = folder / "subtitles.json"
    json_path.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")

    # 2. 保存标准双语 subtitles.srt
    srt_lines = []
    for item in items:
        srt_lines.append(str(item["index"]))
        srt_lines.append(f"{format_srt_time(item['start'])} --> {format_srt_time(item['end'])}")
        if item["en"]:
            srt_lines.append(item["en"])
        if item["zh"]:
            srt_lines.append(item["zh"])
        srt_lines.append("")
    srt_path = folder / "subtitles.srt"
    srt_path.write_text("\n".join(srt_lines), encoding="utf-8")

    print(f"✅ 已生成时间戳文件 ({len(items)} 句):")
    print(f"   - {srt_path}")
    print(f"   - {json_path}")


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "resources"
    if target.is_dir():
        process_directory(target)
        for sub in sorted(target.iterdir()):
            if sub.is_dir():
                process_directory(sub)

