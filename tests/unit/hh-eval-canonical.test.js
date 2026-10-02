// #120 — контракт канонической оценки: адаптеры приводят четыре разные схемы к
// одному CandidateEvaluation. Контрактные тесты на ФАКТИЧЕСКИХ JSON из fixtures/,
// а не на объектах нужной формы — иначе тест проходит, даже если схема источника
// разъехалась.
//
// Проверяем ровно то, что ломалось раньше: veto boolean vs string[], coverage.missing
// как массив объектов, строки из двух разных оценок, legacy 0 и ATS-only без строк.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const canonical = require('../../src/hh-eval-canonical.js');
const adapters = require('../../src/hh-eval-adapters.js');
const v2 = require('../../src/hh-eval-docs-v2.js');

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'evals');
const load = (name) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));

const interviewJson = load('interview-eval-89.json');
const jobJson = load('job-eval-90.json');
const legacyJson = load('legacy-hr-stalker-v0.json');
const atsJson = load('ats-only.json');

const DOCS = [
  { doc_id: 'cv', type: 'resume', role: 'source', sha256: 'a'.repeat(64) },
  { doc_id: 'cl', type: 'cover_letter', role: 'source', sha256: 'b'.repeat(64) },
  { doc_id: 'pt', type: 'portfolio', role: 'source', sha256: 'c'.repeat(64) },
  { doc_id: 'iv', type: 'interview', role: 'source', sha256: 'd'.repeat(64) },
];

const REQS = { revision: 'r3', source: 'portrait' };

function build(overrides = {}) {
  return v2.buildReportDataV2({
    candidateId: 'ivanov',
    vacancyId: 'v-node-1',
    interviewEval: interviewJson,
    job: jobJson,
    requirements: REQS,
    docs: DOCS,
    ...overrides,
  });
}

describe('адаптеры приводят схемы #89 / #90 к одним rows', () => {
  it('#89: строки читаются, coverage.missing — объекты, а не [object Object]', () => {
    const a = adapters.adaptInterviewEval(interviewJson);
    expect(a.rows).toHaveLength(5);
    expect(a.rows[0]).toMatchObject({ criterion_id: 'req-1', label: 'Node.js', must_have: true, weight: 2, score: 5 });
    expect(a.coverage.missing.map(m => m.label)).toEqual(['Образование: высшее техническое', 'Kafka']);
    expect(a.coverage.missing.every(m => typeof m === 'object')).toBe(true);
    // Подпись kinds/personality доезжает до канона как отдельная ось.
    expect(a.rows[4].kind).toBe('personality');
  });

  it('#90: строки из job читаются, must/nice — из klass', () => {
    const a = adapters.adaptJobEval(jobJson);
    expect(a.rows).toHaveLength(3);
    expect(a.rows.map(r => r.must_have)).toEqual([true, true, false]);
    expect(a.rows.every(r => r.basis === 'documents')).toBe(true);
  });

  it('veto нормализуется из bool+списка (#89) и из string[] (#90) в один вид', () => {
    const from89 = adapters.normalizeVeto(interviewJson);
    const from90 = adapters.normalizeVeto(jobJson);
    for (const v of [from89, from90]) {
      expect(v.triggered).toBe(true);
      expect(Array.isArray(v.items)).toBe(true);
      expect(v.items.length).toBeGreaterThan(0);
    }
    expect(from89.items[0]).toMatchObject({ criterion_id: 'req-2', label: 'PostgreSQL', score: 2 });
    expect(from90.items[0]).toMatchObject({ label: 'PostgreSQL' });
  });

  it('veto не сработавшее — это triggered:false, а не пустой массив без флага', () => {
    expect(adapters.normalizeVeto({ veto: false })).toEqual({ triggered: false, items: [] });
    expect(adapters.normalizeVeto({})).toEqual({ triggered: false, items: [] });
  });
});

describe('buildCanonical: итоги считаются из своих строк', () => {
  it('один evaluation_id и согласованные totals на интервью-фикстуре', () => {
    const { evaluation: e } = build();
    expect(e.evaluation_id).toMatch(/^[a-f0-9]{12}$/);
    expect(e.rows).toHaveLength(5);

    // Σ(s×w)/Σ(5×w): 5·2 + 2·2 + 4·1 + 3·1 = 21; Σ(5w) = 30 → 70%
    // (требование req-4 без балла не входит ни в числитель, ни в знаменатель).
    expect(e.totals.overall.percent).toBe(70);
    expect(e.totals.overall.score10).toBe(7);
    expect(canonical.validateCanonical(e)).toEqual([]);
  });

  it('личностные — отдельное число и в общий итог не входят (R6)', () => {
    const { evaluation: e } = build();
    // Personality-строка одна (req-5, вес 1, балл 3) → 3/5 = 60%.
    expect(e.totals.personality.percent).toBe(60);
    // Профессиональные без неё: 5·2+2·2+4·1 = 18 из 25 → 72%.
    expect(e.totals.professional.percent).toBe(72);
    // Общий итог — по всем строкам: 21 из 30 → 70%. Личностная строка входит
    // как обычная строка со своим весом, а не «приплюсовывается» поверх процента.
    expect(e.totals.overall.percent).toBe(70);
  });

  it('покрытие считается по строкам: не обсуждалось не повышает и не роняет итог', () => {
    const { evaluation: e } = build();
    expect(e.coverage).toMatchObject({ evaluated: 4, not_discussed: 1, no_data: 0, total: 5, percent: 80 });
    expect(e.coverage.missing).toEqual([{ criterion_id: 'req-4', label: 'Образование: высшее техническое', status: 'not_discussed' }]);
  });

  it('вердикт учитывает veto: must-have 2 балла → ОТКЛОНИТЬ независимо от суммы', () => {
    const { evaluation: e } = build();
    expect(e.totals.veto.triggered).toBe(true);
    expect(e.totals.veto.items.map(i => i.label)).toEqual(['PostgreSQL']);
    expect(e.totals.verdict).toBe('ОТКЛОНИТЬ');
  });

  it('смена вакансии / версии требований / набора документов даёт другой id', () => {
    const base = build().evaluation.evaluation_id;
    // Для другой вакансии нужен и набор оценок другой вакансии, иначе срабатывает
    // проверка привязки — а это отдельный тест выше.
    const otherVacancy = build({
      vacancyId: 'v-go-1',
      interviewEval: { ...interviewJson, vacancy_id: 'v-go-1' },
      job: { ...jobJson, vacancy_id: 'v-go-1' },
    }).evaluation.evaluation_id;
    const otherRev = build({ requirements: { revision: 'r4', source: 'portrait' } }).evaluation.evaluation_id;
    const otherDocs = build({ docs: DOCS.slice(0, 2) }).evaluation.evaluation_id;
    const otherCandidate = build({ candidateId: 'ivanov-2' }).evaluation.evaluation_id;

    expect(new Set([base, otherVacancy, otherRev, otherDocs, otherCandidate]).size).toBe(5);
    // Один и тот же вход — тот же id (идемпотентность).
    expect(build().evaluation.evaluation_id).toBe(base);
  });
});

describe('итог рядом со строкой из чужой оценки невозможен', () => {
  it('vacancy_id mismatch → ошибка с текстом «пересчитай», а не тихая подмена', () => {
    const res = build({ vacancyId: 'v-other' });
    expect(res.error).toMatch(/оценка для вакансии v-node-1, запрошена v-other/);
    expect(res.error).toMatch(/пересчитай/);
    expect(res.evaluation).toBeUndefined();
  });

  it('строки берутся ровно из одного источника: prefer задаёт выбор, смеси не бывает', () => {
    const fromInterview = build().evaluation;
    expect(fromInterview.rows_from).toBe('interview');
    expect(fromInterview.rows.every(r => String(r.criterion_id).startsWith('req-'))).toBe(true);

    const fromJob = build({ prefer: 'job' }).evaluation;
    expect(fromJob.rows_from).toBe('job');
    expect(fromJob.rows.every(r => String(r.criterion_id).startsWith('job-'))).toBe(true);

    // Ни при каком prefer в строках нет смеси: все id принадлежат одному источнику.
    const ids = fromJob.rows.map(r => r.criterion_id);
    expect(ids.some(id => String(id).startsWith('req-'))).toBe(false);
  });

  it('job-only даёт непустую таблицу требований, а не процент без строк', () => {
    const { evaluation: e } = build({ interviewEval: null });
    expect(e.rows_from).toBe('job');
    expect(e.rows).toHaveLength(3);
    // Итог пересчитан из строк на шкале 1–5: (5·2+2·2+4·1)/Σ(5w)=(18)/(25) = 72%.
    // В job-файле лежит 73% — это чужое число, посчитанное старым кодом #90.
    // Если бы мы скопировали его, получили бы 73; здесь честный пересчёт — 72.
    expect(e.totals.overall.percent).toBe(72);
    expect(jobJson.percent).toBe(73);
  });

  it('два одноимённых кандидата на разных вакансиях получают разные id и разные строки', () => {
    const a = build({ candidateId: 'ivanov' }).evaluation;
    const b = build({ candidateId: 'ivanov-2', vacancyId: 'v-go-1', interviewEval: null, job: null }).evaluation;
    expect(a.evaluation_id).not.toBe(b.evaluation_id);
    expect(a.rows).toHaveLength(5);
    expect(b.rows).toHaveLength(0);
  });
});

describe('legacy HR-Stalker: score 0 — это «не обсуждалось»', () => {
  it('ноль старой схемы становится not_discussed, а не отказом', () => {
    const a = adapters.adaptLegacyHrStalker(legacyJson, { warnings: [] });
    const zero = a.rows.filter(r => r.score === null);
    expect(zero.map(r => r.criterion_id)).toEqual(['h-2', 'h-3']);
    expect(zero.every(r => r.score_reason.includes('не обсуждалось'))).toBe(true);

    const { evaluation: e } = v2.buildReportDataV2({
      candidateId: 'ivanov', vacancyId: 'v-node-1', legacy: legacyJson, requirements: REQS, docs: DOCS,
    });
    const byId = Object.fromEntries(e.rows.map(r => [r.criterion_id, r]));
    expect(byId['h-2'].status).toBe('not_discussed');
    expect(byId['h-2'].score).toBeNull();
    expect(byId['h-1'].status).toBe('scored');
    expect(byId['h-1'].score).toBe(4);
    // Отказ не навешивается на пустые строки: must-have не обсуждался — это не veto.
    expect(e.totals.veto.triggered).toBe(false);
    expect(canonical.validateCanonical(e)).toEqual([]);
  });

  it('адаптер версионный: legacy подключается только если нет интервью и job', () => {
    const only = v2.buildReportDataV2({ candidateId: 'x', legacy: legacyJson, requirements: REQS });
    expect(only.evaluation.rows_from).toBe('legacy');

    const withInterview = v2.buildReportDataV2({
      candidateId: 'x', legacy: legacyJson, interviewEval: interviewJson, requirements: REQS,
    });
    expect(withInterview.evaluation.rows_from).toBe('interview');
    expect(withInterview.evaluation.rows.every(r => String(r.criterion_id).startsWith('req-'))).toBe(true);
  });
});

describe('ATS-only: отдельный показатель, а не пустая таблица с процентом', () => {
  it('строк нет, totals пустые, ATS виден и помечен как оценка по документам HH', () => {
    const { evaluation: e } = v2.buildReportDataV2({
      candidateId: 'petrov', vacancyId: 'v-node-1', ats: atsJson, requirements: REQS, docs: DOCS,
    });
    expect(e.rows).toHaveLength(0);
    expect(e.totals.overall.percent).toBeNull();
    expect(e.totals.verdict).toBeNull();
    expect(e.ats).toMatchObject({ score: 7.2, verdict: 'УТОЧНИТЬ' });
    expect(e.ats.reasoning).toMatch(/распределёнными системами/);
  });

  it('ATS не подмешивается в rows даже когда строки есть', () => {
    const { evaluation: e } = build({ ats: atsJson });
    expect(e.rows.every(r => r.score <= 5)).toBe(true);
    expect(e.totals.overall.percent).toBe(70); // ATS 7.2/10 не участвует в сумме
    expect(e.ats.score).toBe(7.2);
  });
});

describe('сравнение недоступно — с причиной, а не числом', () => {
  it('available:false обязан нести причину (валидатор)', () => {
    // buildCanonical сам подставляет причину по умолчанию, поэтому проверяем
    // валидатор на сыром объекте — иначе баг «пустой comparison без причины»
    // проскочил бы незамеченным.
    const raw = { comparison: { available: false } };
    const broken = { ...canonical.buildCanonical({ candidateId: 'x', rows: [] }), ...raw };
    expect(canonical.validateCanonical(broken).join(' ')).toMatch(/comparison.available=false обязан нести причину/);
  });

  it('без comparison показывается «не рассчитывалось»', () => {
    const { evaluation: e } = build({ job: null });
    expect(e.comparison).toEqual({ available: false, reason: 'сравнение не рассчитывалось' });
  });

  it('доступное сравнение сохраняет срез и размер пула', () => {
    const { evaluation: e } = build();
    expect(e.comparison).toMatchObject({
      available: true, place: 3, total: 9, avg: 64, min: 38, max: 91, snapshot_at: '2026-10-01',
    });
  });
});

describe('B9: документы вне скоринга не теряются молча', () => {
  it('portfolio попадает в provenance и в warnings списком', () => {
    const { evaluation: e } = build();
    expect(e.provenance.docs.map(d => d.type)).toEqual(['resume', 'cover_letter', 'portfolio', 'interview']);
    const warned = e.warnings.find(w => w.includes('в оценку не вошли'));
    expect(warned).toBeTruthy();
    expect(warned).toContain('portfolio');
  });
});

describe('экспертная проверка и правило потолка', () => {
  it('«неверно» опускает балл до 2, «частично верно» — до 3', () => {
    const { evaluation: e } = build({
      expertChecks: [
        { criterion_id: 'req-1', status: 'incorrect', basis: 'нет такого проекта в портфолио', checked_at: '2026-10-02' },
        { criterion_id: 'req-3', status: 'partial', basis: 'подтверждено частично', checked_at: '2026-10-02' },
      ],
    });
    const byId = Object.fromEntries(e.rows.map(r => [r.criterion_id, r]));
    expect(byId['req-1'].score).toBe(2);
    expect(byId['req-3'].score).toBe(3);
    expect(byId['req-2'].expert_check.status).toBe('cannot_verify'); // проверки не было
    expect(byId['req-2'].score).toBe(2); // потолок не действует без проверки
    expect(e.warnings.join(' ')).toMatch(/req-1.*понижен до 2/);
  });

  it('без проверки статус честно «нельзя проверить», а не «верно»', () => {
    const { evaluation: e } = build();
    expect(e.rows.every(r => r.expert_check.status === 'cannot_verify')).toBe(true);
    expect(e.expert_checks).toEqual([]);
  });

  it('экспертная проверка без criterion_id не молча теряется', () => {
    const { evaluation: e } = build({ expertChecks: [{ status: 'verified', basis: 'x' }] });
    expect(e.warnings.join(' ')).toMatch(/экспертная проверка без criterion_id/);
  });
});

describe('шкала 1–5: ноль не валиден, «не обсуждалось» — не балл', () => {
  it('балл вне 1–5 приводится к допустимому с предупреждением', () => {
    const { evaluation: e } = v2.buildReportDataV2({
      candidateId: 'x', requirements: REQS,
      job: { rows: [{ name: 'A', klass: 'must', weight: 1, score: 0 }, { name: 'B', klass: 'nice', weight: 1, score: 7 }] },
    });
    const byId = Object.fromEntries(e.rows.map(r => [r.label, r]));
    // 0 из новой схемы — это ошибка LLM, а не «не обсуждалось»: поднимаем до 1 с записью.
    expect(byId.A.score).toBe(1);
    expect(byId.B.score).toBe(5);
    expect(e.warnings.join(' ')).toMatch(/вне шкалы 1–5/);
  });

  it('валидатор ловит строку со статусом scored и баллом вне диапазона', () => {
    const bad = canonical.buildCanonical({
      candidateId: 'x',
      rows: [{ criterion_id: 'a', label: 'A', status: 'scored', score: 9 }],
    });
    // buildCanonical чинит и пишет warning, поэтому проверяем сам валидатор на сыром объекте.
    const broken = { ...bad, rows: [{ criterion_id: 'a', label: 'A', status: 'scored', score: 9 }] };
    expect(canonical.validateCanonical(broken).join(' ')).toMatch(/вне 1–5/);
  });

  it('score обязан быть null при статусе не-scored', () => {
    const broken = {
      evaluation_id: 'x', candidate_id: 'x', rows: [{ criterion_id: 'a', label: 'A', status: 'not_discussed', score: 3, kind: 'professional' }],
      totals: { veto: { triggered: false }, verdict: null },
    };
    expect(canonical.validateCanonical(broken).join(' ')).toMatch(/score обязан быть null/);
  });
});

describe('buildCanonical требует кандидата', () => {
  it('без candidate_id — исключение, а не объект без id', () => {
    expect(() => canonical.buildCanonical({})).toThrow(/candidate_id обязателен/);
    expect(() => canonical.buildCanonical({ candidateId: '' })).toThrow(/candidate_id обязателен/);
  });
});