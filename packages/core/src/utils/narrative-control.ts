import type { ChapterIntent, ChapterMemo, ContextPackage } from "../models/input-governance.js";

const HOOK_ID_PATTERN = /\bH\d+\b/gi;
const HOOK_SLUG_PATTERN = /\b[a-z]+(?:-[a-z]+){1,3}\b/g;
const CHAPTER_REF_PATTERNS: ReadonlyArray<RegExp> = [
  /\bch(?:apter)?\s*\d+\b/gi,
  /第\s*\d+\s*章/g,
];

const ZH_REPLACEMENTS: ReadonlyArray<[RegExp, string]> = [
  [/前几章/g, "此前"],
  [/本章要做的是/g, "眼下要处理的是"],
  [/本章要做的/g, "眼下要处理的"],
  [/仿佛/g, "像"],
  [/似乎/g, "像是"],
];

const EN_REPLACEMENTS: ReadonlyArray<[RegExp, string]> = [
  [/\bprevious chapters\b/gi, "earlier scenes"],
  [/\bthis chapter needs to\b/gi, "the current move is to"],
];

export function sanitizeNarrativeControlText(
  text: string,
  language: "zh" | "en" | "ru" = "zh",
): string {
  let result = text;
  const threadRef = language === "en" ? "this thread" : language === "ru" ? "эта линия" : "这条线索";
  const chapterRef = language === "en" ? "an earlier scene" : language === "ru" ? "ранняя сцена" : "此前";

  result = result.replace(HOOK_ID_PATTERN, threadRef);
  result = result.replace(HOOK_SLUG_PATTERN, threadRef);
  for (const pattern of CHAPTER_REF_PATTERNS) {
    result = result.replace(pattern, chapterRef);
  }

  for (const [pattern, replacement] of [...ZH_REPLACEMENTS, ...EN_REPLACEMENTS]) {
    result = result.replace(pattern, replacement);
  }

  return result;
}

/**
 * Render a ChapterMemo + optional ChapterIntent into a sanitized narrative
 * control block for the writer / reviser prompt.
 *
 * Phase 4: the memo body already contains the 7 required section headings
 * (当前任务 / 读者此刻在等什么 / 该兑现的 / 日常过渡 / 关键抉择 / 章尾 / 不要做)
 * produced by the planner LLM. We emit them at top level so the writer sees
 * each section as its own task-unit instead of one flattened "memo" block.
 */
export function renderMemoAsNarrativeBlock(
  memo: ChapterMemo,
  intent: ChapterIntent | undefined,
  language: "zh" | "en" | "ru" = "zh",
): string {
  const s = (text: string) => sanitizeNarrativeControlText(text, language);
  const isEn = language === "en";
  const isRu = language === "ru";
  const goalLabel = isEn ? "Goal" : isRu ? "Цель" : "目标";
  const arcLabel = isEn ? "Arc Context" : isRu ? "Контекст арки" : "弧线背景";
  const threadLabel = isEn ? "Thread Refs" : isRu ? "Связанные нити" : "关联线索";
  const goldenLabel = isEn ? "Golden Opening" : isRu ? "Золотое открытие" : "黄金开场";
  const goldenNote = isEn
    ? "This is a golden opening chapter — prioritize hook-dense, high-tempo pacing."
    : isRu
      ? "Это золотая открывающая глава — приоритет на плотные крючки и высокий темп."
      : "本章是黄金开场章——优先钩子密集、高节奏。";
  const sections: string[] = [];

  sections.push(`## ${goalLabel}\n- ${s(memo.goal)}`);

  if (intent?.arcContext) {
    sections.push(`## ${arcLabel}\n- ${s(intent.arcContext)}`);
  }

  if (memo.threadRefs.length > 0) {
    const threads = memo.threadRefs.map((id) => `- ${id}`).join("\n");
    sections.push(`## ${threadLabel}\n${threads}`);
  }

  if (memo.isGoldenOpening) {
    sections.push(`## ${goldenLabel}\n- ${goldenNote}`);
  }

  // Emit the 7-section memo body at top level so each heading is a task.
  if (memo.body.trim().length > 0) {
    sections.push(s(memo.body));
  }

  return sections.join("\n\n");
}

export function buildNarrativeIntentBrief(
  chapterIntent: string,
  language: "zh" | "en" | "ru" = "zh",
): string {
  const sections: ReadonlyArray<{ heading: string; label: string }> =
    language === "ru"
      ? [
          { heading: "## Цель", label: "Цель" },
          { heading: "## Узел плана", label: "Узел плана" },
          { heading: "## Обязательное сохранение", label: "Сохранить" },
          { heading: "## Чего избегать", label: "Избегать" },
          { heading: "## Стилевые акценты", label: "Стиль" },
          { heading: "## Структурные директивы", label: "Директивы" },
        ]
      : [
          { heading: "## Goal", label: language === "en" ? "Goal" : "目标" },
          { heading: "## Outline Node", label: language === "en" ? "Outline Node" : "当前节点" },
          { heading: "## Must Keep", label: language === "en" ? "Keep" : "保留" },
          { heading: "## Must Avoid", label: language === "en" ? "Avoid" : "避免" },
          { heading: "## Style Emphasis", label: language === "en" ? "Style" : "风格" },
          { heading: "## Structured Directives", label: language === "en" ? "Directives" : "指令" },
        ];

  const rendered = sections
    .map(({ heading, label }) => {
      const section = extractMarkdownSection(chapterIntent, heading);
      if (!section) return null;

      const lines = section
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !["- none", "- 无", "- 本轮无", "(not found)"].includes(line));
      if (lines.length === 0) return null;

      const normalized = lines
        .map((line) => line.startsWith("- ") ? line.slice(2) : line)
        .map((line) => sanitizeNarrativeControlText(line, language))
        .filter(Boolean)
        .map((line) => `- ${line}`)
        .join("\n");

      return `## ${label}\n${normalized}`;
    })
    .filter((section): section is string => Boolean(section));

  return rendered.join("\n\n");
}

export function renderNarrativeSelectedContext(
  entries: ReadonlyArray<ContextPackage["selectedContext"][number]>,
  language: "zh" | "en" | "ru" = "zh",
): string {
  const heading = language === "en" ? "Evidence" : language === "ru" ? "Доказательство" : "证据";
  const reasonLabel = language === "en" ? "reason" : language === "ru" ? "причина" : "原因";
  const detailLabel = language === "en" ? "detail" : language === "ru" ? "деталь" : "细节";

  return entries
    .map((entry, index) => {
      const lines = [
        `### ${heading} ${index + 1}`,
        `- ${reasonLabel}: ${sanitizeNarrativeControlText(entry.reason, language)}`,
        entry.excerpt ? `- ${detailLabel}: ${sanitizeNarrativeControlText(entry.excerpt, language)}` : "",
      ].filter(Boolean);
      return lines.join("\n");
    })
    .join("\n\n");
}

export function sanitizeNarrativeEvidenceBlock(
  block: string | undefined,
  language: "zh" | "en" | "ru" = "zh",
): string | undefined {
  if (!block) return undefined;
  const withoutSources = block.replace(
    /(^|\n)-\s+(?:story|runtime)\/[^:\n]+:\s*/g,
    (_match, prefix: string) => `${prefix}- evidence: `,
  );
  return sanitizeNarrativeControlText(withoutSources, language);
}

function extractMarkdownSection(content: string, heading: string): string | undefined {
  const lines = content.split("\n");
  let buffer: string[] | null = null;

  for (const line of lines) {
    if (line.trim() === heading) {
      buffer = [];
      continue;
    }

    if (buffer && line.startsWith("## ") && line.trim() !== heading) {
      break;
    }

    if (buffer) {
      buffer.push(line);
    }
  }

  const section = buffer?.join("\n").trim();
  return section && section.length > 0 ? section : undefined;
}
