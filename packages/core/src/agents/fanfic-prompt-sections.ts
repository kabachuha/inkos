import type { FanficMode } from "../models/book.js";

export type FanficPromptLanguage = "zh" | "en" | "ru";

const MODE_PREAMBLES: Record<FanficMode, string> = {
  canon: `你正在写**原作向同人**。严格遵守正典：
- 角色的语癖、说话风格、行为模式必须与原作一致
- 世界规则不可违反
- 关键事件时间线不可矛盾
- 可以填充原作空白、探索未详述的角度`,

  au: `你正在写**AU（平行世界）同人**：
- 世界规则可以改变（已在 allowedDeviations 中声明的偏离）
- 角色的核心性格和说话方式应保持辨识度——读者要能认出是谁
- AU 设定偏离必须内部一致（改了一条规则，相关的都要跟着变）`,

  ooc: `你正在写**OOC 同人**：
- 角色在极端情境下可以偏离性格底色
- 但偏离必须有情境驱动，不能无缘无故变性格
- 保留角色的语癖和说话特征——即使性格变了，说话方式也应有辨识度`,

  cp: `你正在写**CP 同人**，以角色互动和关系发展为核心：
- 配对双方每章必须有有效互动
- 互动风格要有化学反应——不是两个人在同一个场景各干各的
- 关系发展应有节奏感：推进、试探、阻碍、突破`,
};

const MODE_PREAMBLES_RU: Record<FanficMode, string> = {
  canon: `Ты пишешь **канон-фейтфил**. Строго соблюдай канон:
- Речевые тики, стиль речи и поведенческие паттерны персонажей должны совпадать с оригиналом
- Правила мира нарушать нельзя
- Хронология ключевых событий не должна противоречить оригиналу
- Допустимо заполнять пробелы оригинала и исследовать недетализированные стороны`,

  au: `Ты пишешь **AU (параллельный мир) фанфик**:
- Правила мира можно менять (отклонения, объявленные в allowedDeviations)
- Ядро характера и манера речи персонажей должны оставаться узнаваемыми — читатель должен понять, кто это
- Отклонения AU-сеттинга должны быть внутренне непротиворечивы (поменял одно правило — меняй все связанные)`,

  ooc: `Ты пишешь **OOC-фанфик**:
- В экстремальных обстоятельствах персонаж может отклоняться от ядра характера
- Но отклонение должно иметь ситуативную причину, нельзя менять характер просто так
- Сохраняй речевые тики и речевые особенности персонажа — даже если характер изменился, манера речи должна оставаться узнаваемой`,

  cp: `Ты пишешь **CP-фанфик**, в центре — взаимодействие персонажей и развитие отношений:
- Обе стороны пары должны иметь содержательное взаимодействие в каждой главе
- Во взаимодействии должна быть химия — не два человека, каждый занят своим в одной сцене
- Развитие отношений должно иметь ритм: продвижение, пробы, препятствия, прорыв`,
};

export function buildFanficCanonSection(
  fanficCanon: string,
  mode: FanficMode,
  language: FanficPromptLanguage = "zh",
): string {
  if (language === "ru") {
    return `
## Справочный канон фанфика

${MODE_PREAMBLES_RU[mode]}

Ниже — каноническая информация оригинала, на которую обязательно опираться при написании:

${fanficCanon}`;
  }
  return `
## 同人正典参照

${MODE_PREAMBLES[mode]}

以下是原作正典信息，写作时必须参照：

${fanficCanon}`;
}

export function buildCharacterVoiceProfiles(
  fanficCanon: string,
  language: FanficPromptLanguage = "zh",
): string {
  const isRu = language === "ru";
  // Extract character table from fanfic_canon.md (zh and RU canon layouts)
  const tableMatch = fanficCanon.match(
    isRu
      ? /## Досье персонажей[\s\S]*?\n(\|[^\n]+\|\n\|[-|\s]+\|\n(?:\|[^\n]+\|\n)*)/
      : /## 角色档案[\s\S]*?\n(\|[^\n]+\|\n\|[-|\s]+\|\n(?:\|[^\n]+\|\n)*)/,
  );
  if (!tableMatch) return "";

  const headerSkip = isRu ? "| Персонаж" : "| 角色";
  const none = isRu ? "(в материале не упомянуто)" : "（素材未提及）";

  const rows = tableMatch[1]!
    .split("\n")
    .filter((line) => line.startsWith("|") && !line.startsWith("|--") && !line.startsWith(headerSkip))
    .map((line) =>
      line
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean),
    )
    .filter((cells) => cells.length >= 5);

  if (rows.length === 0) return "";

  const profiles = rows.map((cells) => {
    const [name, , , catchphrases, speakingStyle, behavior] = cells;
    const parts: string[] = [`### ${name}`];
    if (catchphrases && catchphrases !== none) {
      parts.push(`- ${isRu ? "Речевые тики:" : "口头禅/语癖："}${catchphrases}`);
    }
    if (speakingStyle && speakingStyle !== none) {
      parts.push(`- ${isRu ? "Стиль речи:" : "说话风格："}${speakingStyle}`);
    }
    if (behavior && behavior !== none) {
      parts.push(`- ${isRu ? "Типичное поведение:" : "典型行为："}${behavior}`);
    }
    return parts.join("\n");
  });

  return isRu
    ? `
## Голоса персонажей (только для фанфик-написания)

Диалоги и поведение перечисленных ниже персонажей должны опираться на черты оригинала. Прежде чем писать реплику, сначала подумай: «как этот персонаж сказал бы это в оригинале?».

${profiles.join("\n\n")}`
    : `
## 角色语音参照（同人写作专用）

以下角色的对话和行为必须参照原作特征。写对话时，先想"这个角色在原作里会怎么说"。

${profiles.join("\n\n")}`;
}

const MODE_CHECKS: Record<FanficMode, string> = {
  canon: `- 正典合规检查：本章是否违反原作设定？角色对话是否符合原作语癖？
- 信息边界检查：角色是否引用了不该知道的信息？`,

  au: `- AU 偏离清单：本章改变了哪些世界规则？改变是否内部一致？
- 角色辨识度检查：读者能否从对话中认出角色？`,

  ooc: `- OOC 偏离记录：角色在哪些方面偏离了性格底色？偏离驱动力是什么？
- 语癖保留检查：即使 OOC，说话方式是否还有原作特征？`,

  cp: `- CP 互动检查：配对双方本章是否有有效互动？关系发展是否推进？
- 互动质量检查：互动是否有化学反应（不是各干各的）？`,
};

const MODE_CHECKS_RU: Record<FanficMode, string> = {
  canon: `- Проверка канон-соответствия: нарушает ли глава сеттинг оригинала? Соответствуют ли реплики персонажей их речевым тикам из оригинала?
- Проверка границ информации: не использует ли персонаж сведения, которые он знать не должен?`,

  au: `- Список AU-отклонений: какие правила мира изменены в этой главе? Изменения внутренне непротиворечивы?
- Проверка узнаваемости: сможет ли читатель узнать персонажа по репликам?`,

  ooc: `- Запись OOC-отклонений: в чём персонаж отклонился от ядра характера? Какова причина отклонения?
- Проверка сохранения речевых тиков: даже при OOC сохраняет ли манера речи черты оригинала?`,

  cp: `- Проверка CP-взаимодействия: было ли содержательное взаимодействие обеих сторон пары в этой главе? Продвинулись ли отношения?
- Проверка качества взаимодействия: есть ли химия (а не два человека каждый в своей жизни)?`,
};

export function buildFanficModeInstructions(
  mode: FanficMode,
  allowedDeviations: ReadonlyArray<string>,
  language: FanficPromptLanguage = "zh",
): string {
  if (language === "ru") {
    const deviationsBlock = allowedDeviations.length > 0
      ? `\nДопустимые отклонения (не считаются нарушением):\n${allowedDeviations.map((d) => `- ${d}`).join("\n")}\n`
      : "";
    return `
## Самопроверка фанфика (дополнительные проверки в PRE_WRITE_CHECK)

${MODE_CHECKS_RU[mode]}${deviationsBlock}`;
  }
  const deviationsBlock = allowedDeviations.length > 0
    ? `\n允许的偏离（不视为违规）：\n${allowedDeviations.map((d) => `- ${d}`).join("\n")}\n`
    : "";

  return `
## 同人写作自检（在 PRE_WRITE_CHECK 中额外检查）

${MODE_CHECKS[mode]}${deviationsBlock}`;
}
