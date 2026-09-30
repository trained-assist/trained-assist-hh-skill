# A/B enrichment: free-ladder vs deepseek — 2026-09-30

**Решение: берём free-ladder для ATS-enrichment кандидатов** (`enrichCandidate` /
`enrichCandidates`), temp 0.1 как в проде, фолбэк на прямой OpenRouter при
отсутствии токена лестницы.

Issue с обсуждением: https://github.com/trained-assist/trained-assist-hh-skill/issues/59

## Зачем

Enrichment — «промпт → JSON со score/тегами», ровно тот use-case, под который
строили лестницу. Перед переключением проверили гипотезу «бесплатные ранги
косячат по качеству скоринга», чтобы не переключать впустую.

## Методика

- Выборка: **30 реальных кандидатов** из `tes-recruiter`, вакансия
  «Private Banking Sales», стратифицированно 10 PASS / 10 REVIEW / 10 WEAK
  (пул на момент прогона: 30/140/139), детерминированный shuffle (seed 42).
- Промпт — **1-в-1 из продового `enrichCandidate`**, скоринг результата —
  продовый `atsScoreFields` (knockout-кэп, округление 0.5, PASS≥7 / REVIEW≥5).
- Две руки, обе через лестницу с `agent-tokens/llm-ladder/token`:
  - **free** = `model: free-ladder`
  - **standard** = `model: deepseek` (alias `service` — то, что шлёт
    `service-llm.js`)
- 2 прогона на кандидата × 30 × 2 руки = **120 вызовов**, `temperature: 0.7`
  (намеренно с дисперсией; в проде 0.1), `max_tokens: 600`,
  `response_format: json_object`.
- Эталон — продовые оценки gemini (incumbent, не истина в последней инстанции).

## Результаты

| | free | standard |
|---|---|---|
| Успех | **60/60** | 50/60 (**10 фейлов**: «every rung failed», таймауты) |
| Модель-исполнитель | `opencode-go/deepseek-v4-flash` (60/60) | `opencode-go/space-bunny-free` (45), `nemotron-3-super:free` (5) |
| score mean ± sd | 4.67 ± 2.90 | 4.55 ± 2.49 |
| Дисперсия между репами \|Δ\| | 0.47 (макс 4.0) | 0.40 (макс 1.5) |
| Latency p50 / p90 | 12.5 с / 20.3 с | 22.0 с / 60.6 с |
| Δ от прода (gemini) | −0.67 (mean\|Δ\| 1.00) | −1.22 (mean\|Δ\| 1.24) |
| knockout-флаг | 26/60 | 16/50 |

**Совпадение тега PASS/REVIEW/WEAK (26 сопоставимых пар):**

| пара | совпадений |
|---|---|
| free ↔ standard | 17/26 = **65%** |
| free ↔ прод (gemini) | 19/26 = **73%** |
| standard ↔ прод (gemini) | 15/26 = **58%** |

**Переходы тегов (прод → оценка):**

- free: PASS→PASS **10/10**, REVIEW→REVIEW 3/10 (+5 в WEAK, 2 в PASS),
  WEAK→WEAK 9/10
- standard: PASS→PASS **4/10** (6 переведены в REVIEW), REVIEW→REVIEW 4/10,
  WEAK→WEAK 7/10

## Выводы

1. **Гипотеза «фрии косячат» не подтвердилась** — на этом прогоне free была
   лучше стандартной: больше совпадений с продом (73% vs 58%), меньше
   систематическое смещение, ноль фейлов против 10.
2. Смещение «жёстче gemini» (−0.67…−1.22) — **общее для обеих лестниц**, а не
   специфика фри-рангов: обе нашли knockout'ы, которых не ставил gemini
   (REVIEW→WEAK на середине шкалы). Максимальный разброс — кандидат
   `2cbbcc9a`: free=PASS, standard=WEAK, прод=REVIEW.
3. Надёжность: free выиграла с запасом — первый ранг standard
   (`space-bunny-free`) был медленный/сбойный → 10 таймаутов.
   **Отдельно проверить health `opencode-go/space-bunny-free` в лестнице.**
4. Дисперсия temp=0.7 терпимая (mean 0.47, один выброс 4.0 на кандидате
   `6ded7646`); в проде — temp 0.1.

## Оговорки

n=30, одна вакансия, 2 репа; эталон — продовый gemini, сам не безошибочный.
Это направление (free не хуже), не точечная оценка.

## Артефакты

- `ladder-enrichment-ab-2026-09-30.js` — скрипт прогона (запускается на GCP
  VM: там токен лестницы и данные кандидатов; `node <script>` →
  `/tmp/ladder-eval-results.json`).
- `ladder-enrichment-ab-2026-09-30.results.json` — сырые 120 вызовов.
- Построчная таблица по кандидатам — в комментарии к issue #59.

## Follow-ups

- [ ] enrichment → через `service-llm` (ladder), temp 0.1, фолбэк на прямой
      OpenRouter при отсутствии токена;
- [ ] логировать фактическую модель-исполнитель в enrichment-лог;
- [ ] health `space-bunny-free` в ladders worker.
