import { BaseAgent } from "./base.js";
import type { GenreProfile } from "../models/genre-profile.js";
import type { BookRules } from "../models/book-rules.js";
import type { LengthSpec } from "../models/length-governance.js";
import type { AuditIssue } from "./continuity.js";
import type { ChapterIntent, ChapterMemo, ContextPackage, RuleStack } from "../models/input-governance.js";
import { readGenreProfile, readBookLanguage, readBookRules } from "./rules-reader.js";
import { countChapterLength } from "../utils/length-metrics.js";
import { buildGovernedMemoryEvidenceBlocks } from "../utils/governed-context.js";
import { filterSummaries } from "../utils/context-filter.js";
import {
  buildGovernedCharacterMatrixWorkingSet,
  buildGovernedHookWorkingSet,
} from "../utils/governed-working-set.js";
import { applySpotFixPatches, parseSpotFixPatches } from "../utils/spot-fix-patches.js";
import {
  buildNarrativeIntentBrief,
  renderMemoAsNarrativeBlock,
  renderNarrativeSelectedContext,
  sanitizeNarrativeEvidenceBlock,
} from "../utils/narrative-control.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  readStoryFrame,
  readVolumeMap,
  readCharacterContext,
  readCurrentStateWithFallback,
} from "../utils/outline-paths.js";

export type ReviseMode = "auto" | "polish" | "rewrite" | "rework" | "anti-detect" | "spot-fix";

export const DEFAULT_REVISE_MODE: ReviseMode = "auto";

export interface ReviseOutput {
  readonly revisedContent: string;
  readonly wordCount: number;
  readonly fixedIssues: ReadonlyArray<string>;
  readonly tokenUsage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

type AutoOutputMode = "patch-only" | "rewrite-only" | "allow-full";

function buildTieredIssueList(
  issues: ReadonlyArray<AuditIssue>,
  language: "zh" | "en" | "ru",
): string {
  const isEnglish = language === "en";
  const isRussian = language === "ru";
  const criticalLabel = isEnglish
    ? "## Critical — Must Fix"
    : isRussian
      ? "## Critical — Обязательно исправить"
      : "## Critical（必须解决）";
  const highLabel = isEnglish
    ? "## High — Should Improve"
    : isRussian
      ? "## High — Стоит улучшить"
      : "## High（应当改善）";
  const mediumLabel = isEnglish
    ? "## Medium — Reference"
    : isRussian
      ? "## Medium — Для справки"
      : "## Medium（参考建议）";

  const critical: string[] = [];
  const high: string[] = [];
  const medium: string[] = [];

  for (const issue of issues) {
    const line = `- ${issue.category}: ${issue.description}`;
    if (issue.severity === "critical") {
      critical.push(line);
    } else if (issue.severity === "warning") {
      high.push(line);
    } else {
      medium.push(line);
    }
  }

  const parts: string[] = [];
  if (critical.length > 0) {
    parts.push(`${criticalLabel}\n${critical.join("\n")}`);
  }
  if (high.length > 0) {
    parts.push(`${highLabel}\n${high.join("\n")}`);
  }
  if (medium.length > 0) {
    parts.push(`${mediumLabel}\n${medium.join("\n")}`);
  }

  return parts.join("\n\n");
}

const MODE_DESCRIPTIONS: Record<ReviseMode, string> = {
  auto: "", // auto mode uses buildAutoSystemPrompt instead
  polish: "润色：只改表达、节奏、段落呼吸，不改事实与剧情结论。禁止：增删段落、改变人名/地名/物品名、增加新情节或新对话、改变因果关系。只允许：替换用词、调整句序、修改标点节奏",
  rewrite: "改写：允许重组问题段落、调整画面和叙述力度，但优先保留原文的绝大部分句段。除非问题跨越整章，否则禁止整章推倒重写；只能围绕问题段落及其直接上下文改写，同时保留核心事实与人物动机",
  rework: "重写：可重构场景推进和冲突组织，但不改主设定和大事件结果",
  "anti-detect": `反检测改写：在保持剧情不变的前提下，降低AI生成可检测性。

改写手法（附正例）：
1. 打破句式规律：连续短句 → 长短交替，句式不可预测
2. 口语化替代：✗"然而事情并没有那么简单" → ✓"哪有那么便宜的事"
3. 减少"了"字密度：✗"他走了过去，拿了杯子" → ✓"他走过去，端起杯子"
4. 转折词降频：✗"虽然…但是…" → ✓ 用角色内心吐槽或直接动作切换
5. 情绪外化：✗"他感到愤怒" → ✓"他捏碎了茶杯，滚烫的茶水流过指缝"
6. 删掉叙述者结论：✗"这一刻他终于明白了力量" → ✓ 只写行动，让读者自己感受
7. 群像反应具体化：✗"全场震惊" → ✓"老陈的烟掉在裤子上，烫得他跳起来"
8. 段落长度差异化：不再等长段落，有的段只有一句话，有的段七八行
9. 消灭"不禁""仿佛""宛如"等AI标记词：换成具体感官描写`,
  "spot-fix": "定点修复：只修改审稿意见指出的具体句子或段落，其余所有内容必须原封不动保留。修改范围限定在问题句子及其前后各一句。禁止改动无关段落",
};

export class ReviserAgent extends BaseAgent {
  get name(): string {
    return "reviser";
  }

  async reviseChapter(
    bookDir: string,
    chapterContent: string,
    chapterNumber: number,
    issues: ReadonlyArray<AuditIssue>,
    mode: ReviseMode = DEFAULT_REVISE_MODE,
    genre?: string,
    options?: {
      chapterIntent?: string;
      chapterMemo?: ChapterMemo;
      chapterIntentData?: ChapterIntent;
      contextPackage?: ContextPackage;
      ruleStack?: RuleStack;
      lengthSpec?: LengthSpec;
      baselineChapter?: number;
    },
  ): Promise<ReviseOutput> {
    const baselineStoryDir = options?.baselineChapter === undefined
      ? join(bookDir, "story")
      : join(bookDir, "story", "snapshots", String(options.baselineChapter));
    const [currentState, ledger, hooks, styleGuideRaw, volumeOutline, storyBible, characterMatrix, chapterSummaries, parentCanon, fanficCanon] = await Promise.all([
      options?.baselineChapter === undefined
        ? readCurrentStateWithFallback(bookDir, "(文件不存在)")
        : this.readFileSafe(join(baselineStoryDir, "current_state.md")),
      this.readFileSafe(join(baselineStoryDir, "particle_ledger.md")),
      this.readFileSafe(join(baselineStoryDir, "pending_hooks.md")),
      this.readFileSafe(join(bookDir, "story/style_guide.md")),
      readVolumeMap(bookDir, "(文件不存在)"),
      readStoryFrame(bookDir, "(文件不存在)"),
      options?.baselineChapter === undefined
        ? readCharacterContext(bookDir, "(文件不存在)")
        : this.readSnapshotCharacterContext(bookDir, baselineStoryDir),
      this.readFileSafe(join(baselineStoryDir, "chapter_summaries.md")),
      this.readFileSafe(join(bookDir, "story/parent_canon.md")),
      this.readFileSafe(join(bookDir, "story/fanfic_canon.md")),
    ]);

    // Load genre profile and book rules
    const genreId = genre ?? "other";
    const [{ profile: gp }, bookLanguage] = await Promise.all([
      readGenreProfile(this.ctx.projectRoot, genreId),
      readBookLanguage(bookDir),
    ]);
    const parsedRules = await readBookRules(bookDir);
    const bookRules = parsedRules?.rules ?? null;

    // Fallback: use book_rules body when style_guide.md doesn't exist.
    // Phase 5 hotfix 2: parsedRules.body is only populated for legacy
    // book_rules.md sources — story_frame.md frontmatter yields an empty
    // body, and an empty string is NOT a usable style guide. Treat
    // missing/empty body as "no fallback available".
    const legacyRulesBody = parsedRules?.body?.trim();
    const styleGuide = styleGuideRaw !== "(文件不存在)"
      ? styleGuideRaw
      : (legacyRulesBody || "(无文风指南)");

    const resolvedLanguage = bookLanguage ?? gp.language;
    const isEnglish = resolvedLanguage === "en";
    const isRussian = resolvedLanguage === "ru";

    const issueList = mode === "auto"
      ? buildTieredIssueList(issues, resolvedLanguage)
      : issues
          .map((i) => `- [${i.severity}] ${i.category}: ${i.description}\n  ${isEnglish ? "Suggestion" : isRussian ? "Предложение" : "建议"}: ${i.suggestion}`)
          .join("\n");

    const numericalRule = gp.numericalSystem
      ? (isEnglish
          ? "\n3. Numerical errors must be fixed precisely — cross-check before and after"
          : isRussian
            ? "\n3. Числовые ошибки обязаны исправляться точно — сверяй до и после"
            : "\n3. 数值错误必须精确修正，前后对账")
      : "";
    const protagonistBlock = bookRules?.protagonist
      ? (isEnglish
          ? `\n\nProtagonist lock: ${bookRules.protagonist.name} — ${bookRules.protagonist.personalityLock.join(", ")}. Revisions must not violate the protagonist profile.`
          : isRussian
            ? `\n\nЗаблокирован протагонист: ${bookRules.protagonist.name} — ${bookRules.protagonist.personalityLock.join(", ")}. Исправления не должны нарушать профиль протагониста.`
            : `\n\n主角人设锁定：${bookRules.protagonist.name}，${bookRules.protagonist.personalityLock.join("、")}。修改不得违反人设。`)
      : "";
    // Length guardrail only used by legacy modes (manual CLI revise).
    // Auto mode delegates length to normalize, not reviser.
    const lengthGuardrail = mode !== "auto" && options?.lengthSpec
      ? (isEnglish
          ? "\n8. Keep the chapter word count within the target range; only allow minor deviation when fixing critical issues truly requires it"
          : isRussian
            ? "\n8. Держи объём главы в целевом диапазоне; допускай незначительное отклонение только если исправление критичных проблем это действительно требует"
            : "\n8. 保持章节字数在目标区间内；只有在修复关键问题确实需要时才允许轻微偏离")
      : "";
    const langPrefix = isEnglish
      ? `【LANGUAGE OVERRIDE】ALL output (FIXED_ISSUES, PATCHES, REVISED_CONTENT) MUST be in English.\n\n`
      : isRussian
        ? `【ПЕРЕОПРЕДЕЛЕНИЕ ЯЗЫКА】Весь вывод (FIXED_ISSUES, PATCHES, REVISED_CONTENT) ОБЯЗАН быть на русском языке.\n\n`
        : "";
    const governedMode = Boolean(options?.chapterIntent && options?.contextPackage && options?.ruleStack);
    const hooksWorkingSet = governedMode && options?.contextPackage
      ? buildGovernedHookWorkingSet({
          hooksMarkdown: hooks,
          contextPackage: options.contextPackage,
          chapterNumber,
          language: resolvedLanguage,
        })
      : hooks;
    const chapterSummariesWorkingSet = governedMode
      ? filterSummaries(chapterSummaries, chapterNumber)
      : chapterSummaries;
    const characterMatrixWorkingSet = governedMode
      ? buildGovernedCharacterMatrixWorkingSet({
          matrixMarkdown: characterMatrix,
          chapterIntent: options?.chapterIntent ?? volumeOutline,
          contextPackage: options!.contextPackage!,
          protagonistName: bookRules?.protagonist?.name,
        })
      : characterMatrix;

    const autoOutputMode = mode === "auto" ? resolveAutoOutputMode(issues) : "allow-full";
    const systemPromptBase = mode === "auto"
      ? this.buildAutoSystemPrompt({ langPrefix, gp, protagonistBlock, numericalRule, lengthGuardrail, resolvedLanguage, lengthSpec: options?.lengthSpec, autoOutputMode })
      : this.buildLegacySystemPrompt({ langPrefix, gp, protagonistBlock, numericalRule, lengthGuardrail, mode, resolvedLanguage });
    const systemPrompt = await this.withPromptPackGuidance(systemPromptBase, "longform.reviser");

    const ledgerBlock = gp.numericalSystem
      ? isEnglish
        ? `\n## Resource Ledger\n${ledger}`
        : isRussian
          ? `\n## Смета ресурсов\n${ledger}`
          : `\n## 资源账本\n${ledger}`
      : "";
    const governedMemoryBlocks = options?.contextPackage
      ? buildGovernedMemoryEvidenceBlocks(options.contextPackage, resolvedLanguage)
      : undefined;
    const hookDebtBlock = governedMemoryBlocks?.hookDebtBlock ?? "";
    const hooksBlock = governedMemoryBlocks?.hooksBlock
      ?? (isEnglish
        ? `\n## Pending Hooks\n${hooksWorkingSet}\n`
        : isRussian
          ? `\n## Ожидающие крючки\n${hooksWorkingSet}\n`
          : `\n## 伏笔池\n${hooksWorkingSet}\n`);
    const outlineBlock = volumeOutline !== "(文件不存在)"
      ? (isEnglish
        ? `\n## Volume Outline\n${volumeOutline}\n`
        : isRussian
          ? `\n## Карта тома\n${volumeOutline}\n`
          : `\n## 卷纲\n${volumeOutline}\n`)
      : "";
    const bibleBlock = !governedMode && storyBible !== "(文件不存在)"
      ? (isEnglish
        ? `\n## Story Bible\n${storyBible}\n`
        : isRussian
          ? `\n## Библия мира\n${storyBible}\n`
          : `\n## 世界观设定\n${storyBible}\n`)
      : "";
    const matrixBlock = characterMatrixWorkingSet !== "(文件不存在)"
      ? (isEnglish
        ? `\n## Character Interaction Matrix\n${characterMatrixWorkingSet}\n`
        : isRussian
          ? `\n## Матрица взаимодействия персонажей\n${characterMatrixWorkingSet}\n`
          : `\n## 角色交互矩阵\n${characterMatrixWorkingSet}\n`)
      : "";
    const summariesBlock = governedMemoryBlocks?.summariesBlock
      ?? (chapterSummariesWorkingSet !== "(文件不存在)"
        ? (isEnglish
          ? `\n## Chapter Summaries\n${chapterSummariesWorkingSet}\n`
          : isRussian
            ? `\n## Сводки глав\n${chapterSummariesWorkingSet}\n`
            : `\n## 章节摘要\n${chapterSummariesWorkingSet}\n`)
        : "");
    const volumeSummariesBlock = governedMemoryBlocks?.volumeSummariesBlock ?? "";

    const hasParentCanon = parentCanon !== "(文件不存在)";
    const hasFanficCanon = fanficCanon !== "(文件不存在)";

    const canonBlock = hasParentCanon
      ? (isEnglish
        ? `\n## Mainline Canon Reference (revision only)\nThis book is a spinoff. Revisions must respect the canon constraints; canon facts cannot be changed.\n${parentCanon}\n`
        : isRussian
          ? `\n## Канон основной линии (только для исправлений)\nЭта книга — спин-офф. При исправлениях соблюдай канонические ограничения; канонические факты менять нельзя.\n${parentCanon}\n`
          : `\n## 正传正典参照（修稿专用）\n本书为番外作品。修改时参照正典约束，不可改变正典事实。\n${parentCanon}\n`)
      : "";

    const fanficCanonBlock = hasFanficCanon
      ? (isEnglish
        ? `\n## Fanfic Canon Reference (revision only)\nThis book is fan fiction. Revisions must respect the canon character sheets and world rules; canon facts cannot be violated. Character dialogue must keep the source work's speech tics.\n${fanficCanon}\n`
        : isRussian
          ? `\n## Канон фанфика (только для исправлений)\nЭта книга — фанфик. При исправлениях соблюдай канонические карточки персонажей и правила мира; канонические факты нарушать нельзя. Диалоги персонажей обязаны сохранять речевые особенности оригинала.\n${fanficCanon}\n`
          : `\n## 同人正典参照（修稿专用）\n本书为同人作品。修改时参照正典角色档案和世界规则，不可违反正典事实。角色对话必须保留原作语癖。\n${fanficCanon}\n`)
      : "";
    const reducedControlBlock = options?.contextPackage && options.ruleStack
      ? this.buildReducedControlBlock(options.chapterMemo, options.chapterIntentData, options.chapterIntent, options.contextPackage, options.ruleStack, resolvedLanguage)
      : "";
    // Length guardrail only in legacy modes — auto mode delegates length to normalize.
    const lengthGuidanceBlock = mode !== "auto" && options?.lengthSpec
      ? (isEnglish
        ? `\n## Length Guardrail\nTarget word count: ${options.lengthSpec.target}\nAllowed range: ${options.lengthSpec.softMin}-${options.lengthSpec.softMax}\nExtreme range: ${options.lengthSpec.hardMin}-${options.lengthSpec.hardMax}\nIf the revision exceeds the allowed range, prioritize compressing redundant exposition, repeated actions and weak-information sentences; do not add subplots or remove core facts.\n`
        : isRussian
          ? `\n## Ограничение по объёму\nЦелевой объём: ${options.lengthSpec.target}\nДопустимый диапазон: ${options.lengthSpec.softMin}-${options.lengthSpec.softMax}\nПредельный диапазон: ${options.lengthSpec.hardMin}-${options.lengthSpec.hardMax}\nЕсли после исправления объём выходит за допустимый диапазон, сначала сжимай избыточные описания, повторяющиеся действия и слабоинформативные предложения; не добавляй подсюжеты и не удаляй ключевые факты.\n`
          : `\n## 字数护栏\n目标字数：${options.lengthSpec.target}\n允许区间：${options.lengthSpec.softMin}-${options.lengthSpec.softMax}\n极限区间：${options.lengthSpec.hardMin}-${options.lengthSpec.hardMax}\n如果修正后超出允许区间，请优先压缩冗余解释、重复动作和弱信息句，不得新增支线或删掉核心事实。\n`)
      : "";
    const styleGuideBlock = reducedControlBlock.length === 0
      ? (isEnglish
        ? `\n## Style Guide\n${styleGuide}`
        : isRussian
          ? `\n## Стилевой гид\n${styleGuide}`
          : `\n## 文风指南\n${styleGuide}`)
      : "";

    const userPrompt = isEnglish
      ? `Revise chapter ${chapterNumber}.

## Review Issues
${issueList}

## Current State Card
${currentState}
${ledgerBlock}
${sanitizeNarrativeEvidenceBlock(hookDebtBlock, resolvedLanguage) ?? ""}${sanitizeNarrativeEvidenceBlock(hooksBlock, resolvedLanguage) ?? ""}${sanitizeNarrativeEvidenceBlock(volumeSummariesBlock, resolvedLanguage) ?? ""}${reducedControlBlock || outlineBlock}${bibleBlock}${matrixBlock}${sanitizeNarrativeEvidenceBlock(summariesBlock, resolvedLanguage) ?? ""}${canonBlock}${fanficCanonBlock}${styleGuideBlock}${lengthGuidanceBlock}

## Chapter to Revise
${chapterContent}`
      : isRussian
        ? `Исправь главу ${chapterNumber}.

## Проблемы из рецензии
${issueList}

## Текущая карточка состояния
${currentState}
${ledgerBlock}
${sanitizeNarrativeEvidenceBlock(hookDebtBlock, resolvedLanguage) ?? ""}${sanitizeNarrativeEvidenceBlock(hooksBlock, resolvedLanguage) ?? ""}${sanitizeNarrativeEvidenceBlock(volumeSummariesBlock, resolvedLanguage) ?? ""}${reducedControlBlock || outlineBlock}${bibleBlock}${matrixBlock}${sanitizeNarrativeEvidenceBlock(summariesBlock, resolvedLanguage) ?? ""}${canonBlock}${fanficCanonBlock}${styleGuideBlock}${lengthGuidanceBlock}

## Глава на исправление
${chapterContent}`
        : `请修正第${chapterNumber}章。

## 审稿问题
${issueList}

## 当前状态卡
${currentState}
${ledgerBlock}
${sanitizeNarrativeEvidenceBlock(hookDebtBlock, resolvedLanguage) ?? ""}${sanitizeNarrativeEvidenceBlock(hooksBlock, resolvedLanguage) ?? ""}${sanitizeNarrativeEvidenceBlock(volumeSummariesBlock, resolvedLanguage) ?? ""}${reducedControlBlock || outlineBlock}${bibleBlock}${matrixBlock}${sanitizeNarrativeEvidenceBlock(summariesBlock, resolvedLanguage) ?? ""}${canonBlock}${fanficCanonBlock}${styleGuideBlock}${lengthGuidanceBlock}

## 待修正章节
${chapterContent}`;

    const response = await this.chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      { temperature: 0.3 },
    );

    const output = this.parseOutput(
      response.content,
      mode,
      chapterContent,
      autoOutputMode,
    );
    const wordCount = options?.lengthSpec
      ? countChapterLength(output.revisedContent, options.lengthSpec.countingMode)
      : output.wordCount;
    return { ...output, wordCount, tokenUsage: response.usage };
  }

  private parseOutput(
    content: string,
    mode: ReviseMode,
    originalChapter: string,
    autoOutputMode: AutoOutputMode = "allow-full",
  ): ReviseOutput {
    const extract = (tag: string): string => {
      const regex = new RegExp(
        `=== ${tag} ===\\s*([\\s\\S]*?)(?==== [A-Z_]+ ===|$)`,
      );
      const match = content.match(regex);
      return match?.[1]?.trim() ?? "";
    };

    const fixedRaw = extract("FIXED_ISSUES");
    const fixedIssues = fixedRaw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const makeResult = (revisedContent: string, applied: boolean): ReviseOutput => ({
      revisedContent,
      wordCount: revisedContent.length,
      fixedIssues: applied ? fixedIssues : [],
    });

    // Auto mode obeys the auditor's structured repair scope. It never infers
    // semantic intent from issue prose.
    if (mode === "auto") {
      if (autoOutputMode === "patch-only") {
        const patchesRaw = extract("PATCHES");
        if (patchesRaw) {
          const patches = parseSpotFixPatches(patchesRaw);
          if (patches.length > 0) {
            const patchResult = applySpotFixPatches(originalChapter, patches);
            if (patchResult.applied && patchResult.appliedPatchCount / patches.length >= 0.5) {
              return makeResult(patchResult.revisedContent, true);
            }
          }
        }
        return makeResult(originalChapter, false);
      }

      if (autoOutputMode === "rewrite-only") {
        const revisedContent = extract("REVISED_CONTENT");
        if (revisedContent) {
          return makeResult(revisedContent, true);
        }
        // No rewrite produced — don't fall back to patches; structural issues
        // cannot be safely patched. Return original unchanged.
        return makeResult(originalChapter, false);
      }

      const revisedContent = extract("REVISED_CONTENT");
      if (revisedContent) {
        return makeResult(revisedContent, true);
      }
      const patchesRaw = extract("PATCHES");
      if (patchesRaw) {
        const patches = parseSpotFixPatches(patchesRaw);
        if (patches.length > 0) {
          const patchResult = applySpotFixPatches(originalChapter, patches);
          if (patchResult.applied && patchResult.appliedPatchCount / patches.length >= 0.5) {
            return makeResult(patchResult.revisedContent, true);
          }
        }
      }
      // Both empty — no fix
      return makeResult(originalChapter, false);
    }

    // Legacy spot-fix mode: patches only
    if (mode === "spot-fix") {
      const patches = parseSpotFixPatches(extract("PATCHES"));
      const patchResult = applySpotFixPatches(originalChapter, patches);
      return makeResult(patchResult.revisedContent, patchResult.applied);
    }

    // Legacy rewrite/polish/rework/anti-detect: full content
    const revisedContent = extract("REVISED_CONTENT");
    return makeResult(revisedContent || originalChapter, revisedContent.length > 0);
  }

  private buildAutoSystemPrompt(params: {
    langPrefix: string;
    gp: GenreProfile;
    protagonistBlock: string;
    numericalRule: string;
    lengthGuardrail: string;
    resolvedLanguage: "zh" | "en" | "ru";
    lengthSpec?: LengthSpec;
    autoOutputMode: AutoOutputMode;
  }): string {
    const { langPrefix, gp, protagonistBlock, numericalRule, resolvedLanguage, lengthSpec, autoOutputMode } = params;
    // lengthGuardrail intentionally not used in auto mode — length constraint is embedded in REVISED_CONTENT description
    const en = resolvedLanguage === "en";
    const ru = resolvedLanguage === "ru";
    const rewriteLengthConstraint = lengthSpec
      ? (en
          ? `\n  HARD CONSTRAINT: The revised chapter must stay within ${lengthSpec.softMin}-${lengthSpec.softMax} characters (target: ${lengthSpec.target}, ±25%). This is non-negotiable — do not exceed this range.`
          : ru
            ? `\n  ЖЁСТКОЕ ОГРАНИЧЕНИЕ: исправленная глава обязана уместиться в ${lengthSpec.softMin}-${lengthSpec.softMax} (цель: ${lengthSpec.target}, ±25%). Это жёсткое ограничение — не выходи за этот диапазон.`
            : `\n  硬性约束：重写后的章节必须控制在 ${lengthSpec.softMin}-${lengthSpec.softMax} 字以内（目标 ${lengthSpec.target} 字，±25%）。这是不可突破的底线。`)
      : "";

    const routingDirectiveEn = autoOutputMode === "rewrite-only"
      ? "\n\nROUTING: The reviewer's blocking issues are structural / semantic (character collapse, mainline drift, missing payoff, timeline break, unpaid hook, memo drift, etc.). You MUST output REVISED_CONTENT — do not emit PATCHES, they cannot fix this class of problem. If you cannot safely rewrite, say so in FIXED_ISSUES and leave REVISED_CONTENT empty."
      : autoOutputMode === "patch-only"
        ? "\n\nROUTING: The reviewer's blocking issues are local (wording, paragraph shape, fatigue word, information boundary, knowledge pollution). You MUST output PATCHES only — do not rewrite the whole chapter. If patches are not possible, leave PATCHES empty."
        : "";
    const routingDirectiveZh = autoOutputMode === "rewrite-only"
      ? "\n\n分流指令：reviewer 报告的阻塞问题属于结构/语义错（人设崩、主线偏、爽点缺、时间线错、伏笔未收、memo 偏离等）。你必须输出 REVISED_CONTENT——禁止输出 PATCHES，这类问题不能靠补丁修复。如果无法安全重写，在 FIXED_ISSUES 里说明并留空 REVISED_CONTENT。"
      : autoOutputMode === "patch-only"
        ? "\n\n分流指令：reviewer 报告的阻塞问题属于局部错（措辞、段落形状、疲劳词、信息越界、知识污染）。你必须只输出 PATCHES——不要整章改写。如果做不出补丁，留空 PATCHES。"
        : "";
    const routingDirectiveRu = autoOutputMode === "rewrite-only"
      ? "\n\nМАРШРУТИЗАЦИЯ: блокирующие проблемы рецензента — структурные/семантические (обрухновение персонажа, дрейф основной линии, отсутствие награды, разрыв таймлайна, нераскрытый крючок, дрейф мему и т.д.). Ты ОБЯЗАН вывести REVISED_CONTENT — не выдавай PATCHES, они не чинят этот класс проблем. Если не можешь безопасно переписать, об этом в FIXED_ISSUES, а REVISED_CONTENT оставь пустым."
      : autoOutputMode === "patch-only"
        ? "\n\nМАРШРУТИЗАЦИЯ: блокирующие проблемы рецензента — локальные (формулировки, форма абзацев, усталые слова, граница информации, загрязнение знаний). Ты ОБЯЗАН вывести ТОЛЬКО PATCHES — не переписывай целую главу. Если патчи невозможны, оставь PATCHES пустым."
        : "";

    if (ru) {
      return `${langPrefix}Ты — профессиональный редактор веб-новелл в жанре ${gp.name}. Исправляй главу по замечаниям рецензии.${protagonistBlock}${routingDirectiveRu}

PATCHES и REVISED_CONTENT решают разные типы проблем — выбирай по типу проблемы, а не по предпочтению:

PATCHES — для локальных текстовых проблем (формулировки, диалоги, AI-следы, мелкие ошибки связности).
  Каждый PATCH цитирует отрывок, который нужно изменить (предложение, абзац или несколько абзацев), и даёт замену. Непривлечённый текст остаётся ровно как есть.

REVISED_CONTENT — для проблем целой главы (сжатие объёма, структурная переработка, перестройка ритма, серьёзное выравнивание сюжета).
  Выводит полностью исправленную главу. Если в Critical есть проблемы объёма или структуры, ты ОБЯЗАН использовать REVISED_CONTENT — PATCHES не могут сжать или перестроить главу.${rewriteLengthConstraint}

Если в Critical есть и локальные, и глобальные проблемы — используй REVISED_CONTENT (он решает всё за один проход).

Принципы редактирования:
1. Чини корневые причины — не делай поверхностную полировку${numericalRule}
2. Статус крючков обязан оставаться синхронным с доской крючков. Если предоставлены брифы долга крючков, сохраняй сцены раскрытия
3. Не меняй направление сюжета и ключевые конфликты
4. Сохраняй оригинальный язык, стиль, ритм и дыхание — не сжимай переходные сцены и не убирай места для пауз
5. Эмоции через действие (никогда не «он почувствовал гнев» — показывай). Ценности через поведение, а не лозунги
6. Разные персонажи говорят по-разному. Запрещено «все ахнули хором»
7. Эскалация: плохое складывается на плохое, каждое хуже предыдущего

Редактор с учётом цикла:
- Если эта глава должна быть «последствиями», но всё ещё наращивает напряжение — переписывай самый плотный конфликтный отрывок в отрывок, показывающий изменение: кто что потерял, чья позиция сдвинулась, что стало новой нормой
- Если эта глава должна быть «кульминацией», но нет чёткой награды — найди ближайшую к награде сцену и усишь её — обещанное разрешение должно превзойти ожидания читателя
- Повседневные отрывки, не служащие основной линии: переписывай как «наживку» — добавь деталь, указывающую в будущее, намёк, реакцию персонажа, сеющую любопытство

Формат вывода:

=== FIXED_ISSUES ===
(Каждое исправление отдельной строкой; если безопасное локальное исправление невозможно — объясни здесь)

=== PATCHES ===
(Локальные патчи, если применимо. При использовании REVISED_CONTENT пропусти этот блок целиком)
--- PATCH 1 ---
TARGET_TEXT:
(Точная цитата из оригинала, определяющая отрывок для изменения)
REPLACEMENT_TEXT:
(Заменяющий текст для этого отрывка)
--- END PATCH ---

=== REVISED_CONTENT ===
(Полный исправленный текст главы — только когда PATCHES не решают проблему. При использовании PATCHES пропусти этот блок)`;
    }

    return en
      ? `${langPrefix}You are a professional ${gp.name} web-fiction revision editor. Fix the chapter according to the review notes.${protagonistBlock}${routingDirectiveEn}

PATCHES and REVISED_CONTENT serve different problems — choose by problem type, not preference:

PATCHES — for local text issues (wording, dialogue, AI-tell phrases, small continuity errors).
  Each PATCH quotes the passage to change (a sentence, a paragraph, or multiple paragraphs) and provides a replacement. Untouched text stays exactly as-is.

REVISED_CONTENT — for whole-chapter issues (length compression, structural rewrite, pacing restructure, major plot realignment).
  Outputs the full revised chapter. When Critical issues include length or structural problems, you must use REVISED_CONTENT — patches cannot compress or restructure a chapter.${rewriteLengthConstraint}

If Critical issues include both local and whole-chapter problems, use REVISED_CONTENT (it addresses everything in one pass).

Revision principles:
1. Fix root causes — do not apply superficial polish${numericalRule}
2. Hook status must stay in sync with the hooks board. If hook debt briefs are provided, preserve hook payoff scenes
3. Do not alter the plot direction or core conflicts
4. Preserve the original language style, rhythm, and pacing — do not compress transitional scenes or remove breathing room
5. Emotion through action (never "he felt angry" — show it). Values through behavior, not slogans
6. Different characters speak differently. No "everyone gasped in unison"
7. Escalate: bad things stack, each worse than the last

Cycle-aware revision:
- If this chapter should be "aftermath" but is still escalating tension, rewrite the densest conflict passage into a change-showing passage — who lost what, whose attitude shifted, what the new normal is
- If this chapter should be "climax" but has no clear payoff, find the closest scene to a reward and amplify it — make the promised release exceed reader expectations
- Daily passages that don't serve the main line: rewrite as "bait" — add a detail pointing to the future, a hint, a character reaction that seeds curiosity

Output format:

=== FIXED_ISSUES ===
(List each fix on its own line; if a safe local fix is not possible, explain here)

=== PATCHES ===
(Output local patches if applicable. Omit this section entirely if using REVISED_CONTENT)
--- PATCH 1 ---
TARGET_TEXT:
(Exact quote from the original that identifies the passage to change)
REPLACEMENT_TEXT:
(Replacement text for this passage)
--- END PATCH ---

=== REVISED_CONTENT ===
(Full revised chapter content — only when PATCHES cannot solve the problem. Omit this section if using PATCHES)`
      : `${langPrefix}你是一位专业的${gp.name}网络小说修稿编辑。你的任务是根据审稿意见对章节进行修正。${protagonistBlock}${routingDirectiveZh}

PATCHES 和 REVISED_CONTENT 分别处理不同类型的问题——按问题类型选择，不是按偏好：

PATCHES——处理局部文字问题（措辞、对话、AI痕迹、小的连续性错误）。
  每个 PATCH 引用要修改的原文段落（一句、一段或多段皆可），给出替换文本。未涉及的内容保持原样。

REVISED_CONTENT——处理全章级问题（字数压缩、结构重组、节奏重排、重大剧情偏离）。
  输出修正后的完整正文。当 Critical 问题包含字数或结构性问题时，必须使用 REVISED_CONTENT——PATCHES 无法压缩或重构整章。${rewriteLengthConstraint}

如果 Critical 同时包含局部问题和全章问题，使用 REVISED_CONTENT（一次性解决所有问题）。

修稿原则：
1. 修根因，不做表面润色${numericalRule}
2. 伏笔状态必须与伏笔池同步。如果提供了 Hook Debt 简报，必须保留伏笔兑现段落
3. 不改变剧情走向和核心冲突
4. 保持原文的语言风格、节奏和呼吸——不要压缩过渡段、不要删掉减速段
5. 情绪用动作外化（不写"他感到愤怒"，写动作）。价值观通过行为传达
6. 不同角色说话方式必须不同。禁止"众人齐声惊呼"
7. 坏事叠坏事，每层比上一层过分

小目标周期修稿指引：
- 如果本章应该是"后效"阶段但仍在加压，把最密集的冲突段落改写为展示改变的段落——谁失去了什么、谁的态度变了、新的常态是什么
- 如果本章应该是"爆发"阶段但没有明确兑现，找到最接近回报的场景并放大它——让承诺的释放超过读者预期
- 日常段落如果不服务主线，改写为"饵"：加入一个指向未来的细节、一句暗示、一个角色反应

输出格式：

=== FIXED_ISSUES ===
(逐条说明修正了什么)

=== PATCHES ===
(局部补丁——仅用于局部文字问题。有全章级问题时省略此区块)
--- PATCH 1 ---
TARGET_TEXT:
(从原文中精确引用要修改的段落)
REPLACEMENT_TEXT:
(替换后的文本)
--- END PATCH ---

=== REVISED_CONTENT ===
(修正后的完整正文——用于字数/结构/节奏等全章级问题。仅局部问题时省略此区块)`;
  }

  private buildLegacySystemPrompt(params: {
    langPrefix: string;
    gp: GenreProfile;
    protagonistBlock: string;
    numericalRule: string;
    lengthGuardrail: string;
    mode: ReviseMode;
    resolvedLanguage: "zh" | "en" | "ru";
  }): string {
    const { langPrefix, gp, protagonistBlock, numericalRule, lengthGuardrail, mode } = params;
    const modeDesc = MODE_DESCRIPTIONS[mode];
    const outputFormat = mode === "spot-fix"
      ? `=== FIXED_ISSUES ===
(逐条说明修正了什么，一行一条；如果无法安全定点修复，也在这里说明)

=== PATCHES ===
--- PATCH 1 ---
TARGET_TEXT:
(必须从原文中精确复制、且能唯一命中的原句或原段)
REPLACEMENT_TEXT:
(替换后的局部文本)
--- END PATCH ---`
      : `=== FIXED_ISSUES ===
(逐条说明修正了什么，一行一条)

=== REVISED_CONTENT ===
(修正后的完整正文)`;

    return `${langPrefix}你是一位专业的${gp.name}网络小说修稿编辑。你的任务是根据审稿意见对章节进行修正。${protagonistBlock}

修稿模式：${modeDesc}

修稿原则：
1. 按模式控制修改幅度
2. 修根因，不做表面润色${numericalRule}
4. 正文必须服从既有事实和伏笔约束，但不要输出或重写状态文件；宿主会根据修订正文重新结算
5. 不改变剧情走向和核心冲突
6. 保持原文的语言风格和节奏
${lengthGuardrail}
${mode === "spot-fix" ? "\n9. spot-fix 只能输出局部补丁，禁止输出整章改写；TARGET_TEXT 必须能在原文中唯一命中\n10. 如果需要大面积改写，说明无法安全 spot-fix，并让 PATCHES 留空" : ""}

输出格式：

${outputFormat}`;
  }

  private async readFileSafe(path: string): Promise<string> {
    try {
      return await readFile(path, "utf-8");
    } catch {
      return "(文件不存在)";
    }
  }

  private async readSnapshotCharacterContext(
    bookDir: string,
    snapshotStoryDir: string,
  ): Promise<string> {
    const snapshotMatrix = await this.readFileSafe(join(snapshotStoryDir, "character_matrix.md"));
    if (snapshotMatrix !== "(文件不存在)") return snapshotMatrix;
    return readCharacterContext(bookDir, "(文件不存在)");
  }

  private buildReducedControlBlock(
    memo: ChapterMemo | undefined,
    intent: ChapterIntent | undefined,
    chapterIntent: string | undefined,
    contextPackage: ContextPackage,
    ruleStack: RuleStack,
    language: "zh" | "en" | "ru" = "zh",
  ): string {
    const selectedContext = renderNarrativeSelectedContext(contextPackage.selectedContext, language)
      .replace(/^### /gm, "- ");
    const overrides = ruleStack.activeOverrides.length > 0
      ? ruleStack.activeOverrides
        .map((override) => `- ${override.from} -> ${override.to}: ${override.reason} (${override.target})`)
        .join("\n")
      : (language === "ru" ? "- нет" : "- none");
    // Prefer memo-based narrative block; fall back to legacy intent markdown
    const narrativeBlock = memo
      ? renderMemoAsNarrativeBlock(memo, intent, language)
      : chapterIntent
        ? buildNarrativeIntentBrief(chapterIntent, language)
        : (language === "ru" ? "(нет)" : "(无)");

    if (language === "ru") {
      return `\n## Управляющие входы главы (составлено Planner/Composer)
${narrativeBlock}

### Выбранный контекст
${selectedContext || "- нет"}

### Стек правил
- Жёсткие ограждения: ${ruleStack.sections.hard.join(", ") || "(нет)"}
- Мягкие ограничения: ${ruleStack.sections.soft.join(", ") || "(нет)"}
- Диагностические правила: ${ruleStack.sections.diagnostic.join(", ") || "(нет)"}

### Активные переопределения
${overrides}\n`;
    }

    return `\n## 本章控制输入（由 Planner/Composer 编译）
${narrativeBlock}

### 已选上下文
${selectedContext || "- none"}

### 规则栈
- 硬护栏：${ruleStack.sections.hard.join("、") || "(无)"}
- 软约束：${ruleStack.sections.soft.join("、") || "(无)"}
- 诊断规则：${ruleStack.sections.diagnostic.join("、") || "(无)"}

### 当前覆盖
${overrides}\n`;
  }
}

function resolveAutoOutputMode(issues: ReadonlyArray<AuditIssue>): AutoOutputMode {
  if (issues.length === 0) {
    return "allow-full";
  }
  const scopedBlocking = issues.filter((issue) => issue.severity !== "info" && issue.repairScope);
  if (scopedBlocking.length > 0) {
    if (scopedBlocking.some((issue) => issue.repairScope === "structural")) {
      return "rewrite-only";
    }
    if (
      scopedBlocking.length === issues.filter((issue) => issue.severity !== "info").length
      && scopedBlocking.every((issue) => issue.repairScope === "local")
    ) {
      return "patch-only";
    }
  }

  const blocking = issues.filter((issue) => issue.severity !== "info");
  if (blocking.length === 0) {
    return "patch-only"; // only hints / info — at most local polish
  }
  // Unknown scope is intentionally not guessed from natural-language labels.
  // The reviser may choose the safest representation from the actual issue text.
  return "allow-full";
}
