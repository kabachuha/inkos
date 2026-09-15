import { BaseAgent } from "./base.js";
import type { ArchitectOutput } from "./architect.js";

export interface FoundationReviewResult {
  readonly passed: boolean;
  readonly totalScore: number;
  readonly dimensions: ReadonlyArray<{
    readonly name: string;
    readonly score: number;
    readonly feedback: string;
  }>;
  readonly overallFeedback: string;
}

export class FoundationReviewParseError extends Error {
  constructor(readonly missingDimensions: ReadonlyArray<number>) {
    super(`Foundation review output is missing dimension${missingDimensions.length === 1 ? "" : "s"}: ${missingDimensions.join(", ")}`);
    this.name = "FoundationReviewParseError";
  }
}

const PASS_THRESHOLD = 80;
const DIMENSION_FLOOR = 60;

export class FoundationReviewerAgent extends BaseAgent {
  get name(): string {
    return "foundation-reviewer";
  }

  async review(params: {
    readonly foundation: ArchitectOutput;
    readonly mode: "original" | "fanfic" | "series";
    readonly sourceCanon?: string;
    readonly styleGuide?: string;
    readonly language: "zh" | "en" | "ru";
    readonly targetChapters?: number;
  }): Promise<FoundationReviewResult> {
    const canonLabel = params.language === "en"
      ? "Source canon reference"
      : params.language === "ru"
        ? "Референс канона первоисточника"
        : "原作正典参照";
    const styleLabel = params.language === "en"
      ? "Source style reference"
      : params.language === "ru"
        ? "Референс стиля первоисточника"
        : "原作风格参照";
    const canonBlock = params.sourceCanon
      ? `\n## ${canonLabel}\n${params.sourceCanon}\n`
      : "";
    const styleBlock = params.styleGuide
      ? `\n## ${styleLabel}\n${params.styleGuide}\n`
      : "";

    const dimensions = params.mode === "original"
      ? this.originalDimensions(params.language, params.targetChapters)
      : this.derivativeDimensions(params.language, params.mode);

    const systemPrompt = params.language === "en"
      ? this.buildEnglishReviewPrompt(dimensions, canonBlock, styleBlock)
      : params.language === "ru"
        ? this.buildRussianReviewPrompt(dimensions, canonBlock, styleBlock)
        : this.buildChineseReviewPrompt(dimensions, canonBlock, styleBlock);

    const userPrompt = this.buildFoundationExcerpt(params.foundation, params.language);

    const response = await this.chat([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ], { temperature: 0.3 });

    return this.parseReviewResult(response.content, dimensions);
  }

  private originalDimensions(language: "zh" | "en" | "ru", targetChapters?: number): ReadonlyArray<string> {
    const target = Number.isFinite(targetChapters) && targetChapters && targetChapters > 0
      ? Math.round(targetChapters)
      : 40;
    const openingWindow = Math.min(5, target);
    const repeatWindow = Math.min(10, Math.max(3, target));
    return language === "en"
      ? [
          `Core Conflict (Is there a clear, compelling central conflict that can sustain the requested ${target} chapters?)`,
          `Opening Momentum (Can the first ${openingWindow} chapters create a page-turning hook?)`,
          "World Coherence (Is the worldbuilding internally consistent and specific?)",
          "Character Differentiation (Are the main characters distinct in voice and motivation?)",
          `Pacing Feasibility (Does the outline fit the requested ${target} chapters and avoid repeating the same beat for ${repeatWindow} chapters?)`,
        ]
      : language === "ru"
        ? [
            `Центральный конфликт (есть ли ясное, цепляющее центральное напряжение, способное удержать требуемые ${target} глав?)`,
            `Драйвер начала (создают ли первые ${openingWindow} глав эффект «хочется листать дальше»?)`,
            "Целостность мира (внутренне согласована ли и конкретна ли система мира?)",
            "Различимость героев (отличаются ли основные персонажи по голосу и мотивации?)",
            `Фактичность темпа (вписывается ли план в требуемые ${target} глав и избегает одного и того же бита ${repeatWindow} глав подряд?)`,
          ]
        : [
            `核心冲突（是否有清晰且有足够张力的核心冲突支撑用户要求的${target}章？）`,
            `开篇节奏（前${openingWindow}章能否形成翻页驱动力？）`,
            "世界一致性（世界观是否内洽且具体？）",
            "角色区分度（主要角色的声音和动机是否各不相同？）",
            `节奏可行性（大纲是否适配用户要求的${target}章，并避免连续${repeatWindow}章同一种节拍？）`,
          ];
  }

  private derivativeDimensions(language: "zh" | "en" | "ru", mode: "fanfic" | "series"): ReadonlyArray<string> {
    const modeLabel = mode === "fanfic"
      ? (language === "en" ? "Fan Fiction" : language === "ru" ? "фанфик" : "同人")
      : (language === "en" ? "Series" : language === "ru" ? "серия" : "系列");

    return language === "en"
      ? [
          `Source DNA Preservation (Does the ${modeLabel} respect the original's world rules, character personalities, and established facts?)`,
          `New Narrative Space (Is there a clear divergence point or new territory that gives the story room to be ORIGINAL, not a retelling?)`,
          "Core Conflict (Is the new story's central conflict compelling and distinct from the original?)",
          "Opening Momentum (Can the first 5 chapters create a page-turning hook without requiring 3 chapters of setup?)",
          `Pacing Feasibility (Does the outline avoid the trap of re-walking the original's plot beats?)`,
        ]
      : language === "ru"
        ? [
            `Сохранение ДНК первоисточника (уважает ли ${modeLabel} правила мира, характеры персонажей и установленные факты оригинала?)`,
            "Новое нарративное пространство (есть ли ясная точка разветвления или новая территория, дающая истории право быть ОРИГИНАЛЬНОЙ, а не пересказом?)",
            "Центральный конфликт (напряжён ли конфликт новой истории и отличается ли он от оригинала?)",
            "Драйвер начала (создают ли первые 5 глав эффект «хочется листать дальше» без 3 глав завязки?)",
            "Фактичность темпа (избегает ли план ловушки повторного прохода по битам сюжета оригинала?)",
          ]
        : [
            `原作DNA保留（${modeLabel}是否尊重原作的世界规则、角色性格、已确立事实？）`,
            `新叙事空间（是否有明确的分岔点或新领域，让故事有原创空间，而非复述原作？）`,
            "核心冲突（新故事的核心冲突是否有足够张力且区别于原作？）",
            "开篇节奏（前5章能否形成翻页驱动力，不需要3章铺垫？）",
            `节奏可行性（卷纲是否避免了重走原作剧情节拍的陷阱？）`,
          ];
  }

  private buildChineseReviewPrompt(
    dimensions: ReadonlyArray<string>,
    canonBlock: string,
    styleBlock: string,
  ): string {
    return `你是一位资深小说编辑，正在审核一本新书的基础设定（世界观 + 大纲 + 规则）。

你需要从以下维度逐项打分（0-100），并给出具体意见：

${dimensions.map((dim, i) => `${i + 1}. ${dim}`).join("\n")}

## 评分标准
- 80+ 通过，可以开始写作
- 60-79 有明显问题，需要修改
- <60 方向性错误，需要重新设计

## 输出格式（严格遵守）
=== DIMENSION: 1 ===
分数：{0-100}
意见：{具体反馈}

=== DIMENSION: 2 ===
分数：{0-100}
意见：{具体反馈}

...（每个维度一个 block）

=== OVERALL ===
总分：{加权平均}
通过：{是/否}
总评：{1-2段总结，指出最大的问题和最值得保留的优点}
${canonBlock}${styleBlock}

审核时要严格。不要因为"还行"就给高分。80分意味着"可以直接开写，不需要改"。`;
  }

  private buildEnglishReviewPrompt(
    dimensions: ReadonlyArray<string>,
    canonBlock: string,
    styleBlock: string,
  ): string {
    return `You are a senior fiction editor reviewing a new book's foundation (worldbuilding + outline + rules).

Score each dimension (0-100) with specific feedback:

${dimensions.map((dim, i) => `${i + 1}. ${dim}`).join("\n")}

## Scoring
- 80+ Pass — ready to write
- 60-79 Needs revision
- <60 Fundamental direction problem

## Output format (strict)
=== DIMENSION: 1 ===
Score: {0-100}
Feedback: {specific feedback}

=== DIMENSION: 2 ===
Score: {0-100}
Feedback: {specific feedback}

...

=== OVERALL ===
Total: {weighted average}
Passed: {yes/no}
Summary: {1-2 paragraphs — biggest problem and best quality}
${canonBlock}${styleBlock}

Be strict. 80 means "ready to write without changes."`;
  }

  private buildRussianReviewPrompt(
    dimensions: ReadonlyArray<string>,
    canonBlock: string,
    styleBlock: string,
  ): string {
    return `Вы — опытный редактор-профессионал, рецензирующий фундамент новой книги (система мира + план + правила).

Оцените каждое измерение (0-100) с конкретным фидбеком:

${dimensions.map((dim, i) => `${i + 1}. ${dim}`).join("\n")}

## Критерии оценки
- 80+ Прошло — можно начинать писать
- 60-79 Нужна доработка
- <60 Фундаментальная проблема направления

## Формат вывода (строго)
=== DIMENSION: 1 ===
Оценка: {0-100}
Отзыв: {конкретный фидбек}

=== DIMENSION: 2 ===
Оценка: {0-100}
Отзыв: {конкретный фидбек}

...

=== OVERALL ===
Итог: {взвешенное среднее}
Принят: {да/нет}
Общий вывод: {1-2 абзаца — главная проблема и лучшее качество}
${canonBlock}${styleBlock}

Будьте строги. 80 означает «можно писать без правок».`;
  }

  private buildFoundationExcerpt(foundation: ArchitectOutput, language: "zh" | "en" | "ru"): string {
    return language === "en"
      ? `## Story Bible\n${foundation.storyBible}\n\n## Volume Outline\n${foundation.volumeOutline}\n\n## Book Rules\n${foundation.bookRules}\n\n## Initial State\n${foundation.currentState}\n\n## Initial Hooks\n${foundation.pendingHooks}`
      : language === "ru"
        ? `## Библия истории\n${foundation.storyBible}\n\n## План по томам\n${foundation.volumeOutline}\n\n## Правила книги\n${foundation.bookRules}\n\n## Начальное состояние\n${foundation.currentState}\n\n## Начальные крючки\n${foundation.pendingHooks}`
        : `## 世界设定\n${foundation.storyBible}\n\n## 卷纲\n${foundation.volumeOutline}\n\n## 规则\n${foundation.bookRules}\n\n## 初始状态\n${foundation.currentState}\n\n## 初始伏笔\n${foundation.pendingHooks}`;
  }

  private parseReviewResult(
    content: string,
    dimensions: ReadonlyArray<string>,
  ): FoundationReviewResult {
    const parsedDimensions: Array<{ readonly name: string; readonly score: number; readonly feedback: string }> = [];
    const missingDimensions: number[] = [];

    for (let i = 0; i < dimensions.length; i++) {
      const regex = new RegExp(
        `=== DIMENSION: ${i + 1} ===\\s*[\\s\\S]*?(?:分数|Score|Оценка)[：:]\\s*(\\d+)[\\s\\S]*?(?:意见|Feedback|Отзыв)[：:]\\s*([\\s\\S]*?)(?==== |$)`,
      );
      const match = content.match(regex);
      if (!match) {
        missingDimensions.push(i + 1);
        continue;
      }
      parsedDimensions.push({
        name: dimensions[i]!,
        score: parseInt(match[1]!, 10),
        feedback: match[2]!.trim(),
      });
    }

    if (missingDimensions.length > 0) {
      throw new FoundationReviewParseError(missingDimensions);
    }

    const totalScore = parsedDimensions.length > 0
      ? Math.round(parsedDimensions.reduce((sum, d) => sum + d.score, 0) / parsedDimensions.length)
      : 0;
    const anyBelowFloor = parsedDimensions.some((d) => d.score < DIMENSION_FLOOR);
    const passed = totalScore >= PASS_THRESHOLD && !anyBelowFloor;

    const overallMatch = content.match(
      /=== OVERALL ===[\s\S]*?(?:总评|Summary|Общий вывод)[：:]\s*([\s\S]*?)$/,
    );
    const overallFeedback = overallMatch ? overallMatch[1]!.trim() : "(parse failed)";

    return { passed, totalScore, dimensions: parsedDimensions, overallFeedback };
  }
}
