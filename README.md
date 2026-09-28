# Jev Decision Log

A five-sample decision gate for serialized fiction writing, implementing the
"Jev-style atomic decision" layer used by a long-running AI-novel project:

- Every operation decision is asked **independently 5 times** (Noul =
  probability, Score = 0–3 scale, Choice = option letters A–E).
- Aggregate by **mean**; confidence = mean × **dispersion penalty**
  (k = 1 − range/2).
- Range > 0.5 (or non-unique argmax for Choice) → flagged **divergent** —
  "divergence is information": demote one risk tier even if the mean passes.
- If the decision contradicts your **intuition preset**, it's flagged
  `override` — the core metric of how much the decision layer adds.
- Risk-tier verdict: ≥0.85 auto-execute · 0.60–0.85 execute + review flag ·
  <0.60 fall back / human ruling.

## Usage

- Command **新决策（五样本）**: pick a decision point (P1–P14, from chapter
  pre-flight to "how long can this book still run"), enter the 5 samples and
  your intuition preset, get the integrated verdict, save it.
- Logs land in `决策日志.jsonl` (one JSON per line, machine-readable) and
  `决策日志.md` (human-readable table).
- Command **打开决策统计面板**: record count, mean confidence, divergence rate,
  override-intuition rate, per-point counts, and the P3/P9 emotion-curve view.

## Notes

- The P1–P14 point list is editable at the top of `main.js`.
- Plain JavaScript, no build step; runs entirely offline.
