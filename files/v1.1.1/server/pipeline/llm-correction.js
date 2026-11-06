// llm-correction.js
//
// Whisper 인식 결과 전체(문맥)를 Claude에게 한 번에 보내서:
//   1) 자연스러운 문맥에 맞게 맞춤법/띄어쓰기를 교정하고
//   2) 고유명사이거나 AI 자신도 확신할 수 없는 부분에는 flag를 붙이게 한다.
// 반환된 flag가 true인 구간만 나중에 마커로 찍힌다 (whisper 신뢰도 점수와는 별개 기준).

const https = require("https");

const CORRECTION_MODEL = "claude-haiku-5-5"; // 인식 교정용: 비용 절감을 위해 가벼운 모델 사용 (Haiku 4.5 대비 약 1/10 가격).
const TRANSLATION_MODEL = "claude-sonnet-5-5"; // 번역용: 등록해둔 고유명사 표기를 정확히 지키는 게 중요해서, 더 지시 순응도가 높은 모델 사용.

function callClaude(apiKey, model, systemPrompt, userPrompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: model,
      // Haiku 5.5 / Sonnet 5.5는 thinking이 기본으로 켜져 있고, thinking 토큰도 max_tokens에 포함된다.
      // 8000이면 thinking 뒤에 JSON 답이 잘릴 수 있어서 여유 있게 올렸다 (스트리밍 없이 쓰는 권장 상한).
      max_tokens: 16000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }]
    });

    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
    let chunks = [];
    res.on("data", (chunk) => { chunks.push(chunk); });
    res.on("end", () => {
      const data = Buffer.concat(chunks).toString("utf8"); // 청크 단위로 문자열 변환하면 멀티바이트 한글이 경계에서 깨질 수 있어, 전부 모은 뒤 한 번에 디코딩
      if (res.statusCode !== 200) {
        return reject(new Error(`Claude API 오류 (${res.statusCode}): ${data.slice(0, 500)}`));
      }
      try {
        const parsed = JSON.parse(data);
        if (parsed.stop_reason === "refusal") {
          const cat = parsed.stop_details && parsed.stop_details.category;
          return reject(new Error("Claude가 이 요청을 거절했습니다" + (cat ? ` (분류: ${cat})` : "") + ". 영상 설명이나 고유명사 입력 내용을 확인해 주세요."));
        }
        // thinking 블록이 text 블록 앞에 올 수 있으므로 위치가 아니라 type으로 text 블록을 찾는다.
        const textBlock = Array.isArray(parsed.content)
          ? parsed.content.find((b) => b && b.type === "text" && typeof b.text === "string")
          : null;
        if (!textBlock) {
          return reject(new Error("Claude API 응답에 텍스트 콘텐츠가 없습니다: " + data.slice(0, 500)));
        }
        resolve(textBlock.text);
      } catch (e) {
        reject(new Error("Claude API 응답 파싱 실패: " + data.slice(0, 500)));
      }
    });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Claude에게 "입력 구간 수와 정확히 같은 개수의 JSON 배열"을 요청하고, 개수가 안 맞으면
 * "정확히 N개로 다시 달라"고 재요청한다. 구간이 많을수록(특히 70개 이상) Claude가 문맥을
 * 자연스럽게 이어붙이려다 몇 개를 합치거나 생략하는 경우가 있어, 이를 보정하기 위함.
 */
async function callClaudeJsonArray(apiKey, model, systemPrompt, userPrompt, expectedLength, maxAttempts) {
  maxAttempts = maxAttempts || 3;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptPrompt = attempt === 1
      ? userPrompt
      : userPrompt +
        `\n\n[재시도 ${attempt}] 방금 전 시도가 실패했습니다 (사유: ${lastError ? lastError.message : "알 수 없음"}). ` +
        "다시 한번 명확히 안내합니다: 절대 사과, 설명, 안내 문구를 붙이지 말고 오직 JSON 배열만 출력하세요. " +
        `입력은 정확히 ${expectedLength}개 구간입니다. 절대 두 구간을 합치거나, 하나를 생략하거나, 새 구간을 추가하지 말고, ` +
        `반드시 정확히 ${expectedLength}개의 결과를 순서대로, JSON 배열 형식으로만 출력하세요.`;
    try {
      const responseText = await callClaude(apiKey, model, systemPrompt, attemptPrompt);
      const cleaned = responseText.replace(/```json\s*|```\s*/g, "").trim();
      const results = JSON.parse(cleaned);
      if (!Array.isArray(results)) {
        throw new Error("Claude 응답이 JSON 배열 형식이 아닙니다.");
      }
      if (results.length !== expectedLength) {
        throw new Error(`Claude가 반환한 구간 수(${results.length})가 입력 구간 수(${expectedLength})와 다릅니다.`);
      }
      return results;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

/**
 * segments: [{index, rawText, startSec, endSec}, ...]  (whisper 인식 직후, 사전 치환 이전)
 * apiKey: Anthropic API 키 (sk-ant-...)
 *
 * 반환: [{index, correctedText, flagged, reason}, ...]
 */
// 구간이 너무 많으면 한 번의 요청/응답이 max_tokens에 걸려 JSON이 중간에 잘리는 문제가
// 생긴다(짧은 테스트 영상에선 안 드러나다가, 실제 긴 영상에서 발생). 이를 막기 위해 구간이
// 이 개수를 넘으면 여러 번으로 나눠 요청하고 순서대로 합친다.
const CORRECTION_CHUNK_SIZE = 50;
const TRANSLATION_CHUNK_SIZE = 60;

async function correctWithContext(segments, apiKey, knownTerms, videoContext, compoundSpacing) {
  if (segments.length > CORRECTION_CHUNK_SIZE) {
    let allResults = [];
    for (let i = 0; i < segments.length; i += CORRECTION_CHUNK_SIZE) {
      const chunk = segments.slice(i, i + CORRECTION_CHUNK_SIZE);
      const chunkResults = await correctWithContext(chunk, apiKey, knownTerms, videoContext, compoundSpacing);
      allResults = allResults.concat(chunkResults);
    }
    return allResults;
  }
  let knownTermsInstruction = "";
  if (knownTerms && knownTerms.length) {
    knownTermsInstruction =
      `다음은 이 채널/영상에서 자주 등장하는 정확한 고유명사 목록입니다: ${knownTerms.join(", ")}. ` +
      "STT 결과 중 발음이 이 목록의 단어들과 비슷하게 들리는 부분이 있다면, 최우선으로 이 목록의 정확한 표기를 사용해 교정하세요 (flagged 처리하지 말고 바로 고치세요). ";
  }

  let videoContextInstruction = "";
  if (videoContext && videoContext.trim()) {
    videoContextInstruction =
      `이 영상의 배경/주제는 다음과 같습니다: "${videoContext.trim()}". ` +
      "이 배경 지식을 참고해서, 발음이 비슷한 여러 후보 중 이 문맥에 맞는 단어를 판단하세요. ";
  }

  let compoundSpacingInstruction = "";
  if (compoundSpacing) {
    compoundSpacingInstruction =
      "이 프로젝트는 두 개 이상의 명사가 결합된 복합어를 붙여 쓰지 않고 띄어 쓰는 스타일을 따릅니다 " +
      "(예: '주차공간'→'주차 공간', '공조시스템'→'공조 시스템', '마감품질'→'마감 품질'). 이런 일반 복합명사를 " +
      "발견하면 띄어 쓰세요. 다만 이미 하나의 확립된 고유명사·브랜드명(예: 회사명, 프로젝트명, 상품명)까지 " +
      "띄어 쓰지는 마세요 - 그런 이름은 원래 표기 그대로 두세요. ";
  }

  const systemPrompt =
    "당신은 한국어 영상 자막 편집자입니다. 음성인식(STT) 결과를 받아서, 전체 맥락을 참고해 " +
    "자연스러운 문장으로 맞춤법과 띄어쓰기를 교정합니다. " +
    videoContextInstruction +
    knownTermsInstruction +
    compoundSpacingInstruction +
    "맞춤법 교정에는 다음이 포함됩니다: 조사 오류(예: '등에'를 문맥상 맞는 '등의'로), 어미 오류, " +
    (compoundSpacing
      ? "위에서 안내한 복합명사 띄어쓰기 스타일, "
      : "표준 띄어쓰기 규칙(합성어는 붙여쓰기, 예: '분양대행사'처럼 같은 단어는 문서 전체에서 일관되게 표기), ") +
    "명백한 오타. 이런 명백한 문법/맞춤법 오류는 자신 있게 바로 고치세요 (이건 flagged 대상이 아닙니다). " +
    "특히 다음과 같은 '일반 단어의 명백한 오타'는 절대 flagged로 넘기지 말고 무조건 바로 고치세요: " +
    "발음이 비슷한 흔한 단어로의 오인식(예: '확출'→'확충', '조선'→'조성', '절강'→'절감', '인사번호'→'인사 한번', " +
    "'현대는'→'현재는', '이쁘라'→'인프라', '접근생'→'접근성'). " +
    "이런 사례들의 공통점은 '정답이 하나로 명확히 정해지는 흔한 단어'라는 것입니다 - 고유명사가 아니고, " +
    "문맥상 다른 해석의 여지가 없습니다. " +
    "flagged는 오직 '정답 후보가 여러 개이고 그중 뭐가 맞는지 진짜 판단이 안 서는 경우'에만 사용하세요 " +
    "(고유명사, 인명, 지명, 브랜드명, 또는 발음이 비슷한 여러 단어가 문맥상 모두 그럴듯한 경우). " +
    "각 구간에 대해 다음 네 가지를 판단하세요: " +
    "(1) 이 구간에 고유명사(회사명/제품명/인명 등)가 등장하거나, 문맥만으로는 정확한 단어를 확신할 수 없는 부분이 있다면 flagged를 true로. " +
    "특히 발음이 비슷한 여러 단어가 모두 그럴듯하게 들어맞을 수 있는 경우(동음이의어/유사 발음), " +
    "확신 없이 그중 하나를 임의로 골라 자연스럽게 다듬지 말고 반드시 flagged를 true로 표시하세요. " +
    "이런 경우 correctedText에는 원래 STT 텍스트를 최대한 그대로 두고, reason에 어떤 단어들이 후보인지 적으세요. " +
    "일반적인 대화 내용으로 자연스럽게 이어지는 경우는 flagged를 false로. " +
    "(2) isSentenceEnd: 이 구간에서 하나의 완전한 문장이 실제로 끝나는지 여부. " +
    "구간은 화면 컷 단위로 나뉜 것이라, 한 문장이 여러 구간에 걸쳐 이어지는 경우가 많습니다. " +
    "문장이 다음 구간으로 이어진다면 반드시 false로 표시하세요. " +
    "(3) endPunctuation: isSentenceEnd가 true일 때, 그 문장에 맞는 문장부호 하나 (평서문이면 \".\", 의문문이면 \"?\", 감탄문이면 \"!\"). " +
    "isSentenceEnd가 false이면 null로 두세요. " +
    "(4) correctedText에는 문장부호를 포함하지 마세요 (문장부호는 endPunctuation 값으로 별도로 붙입니다). " +
    `매우 중요: 입력은 정확히 ${segments.length}개 구간입니다. 반드시 이 구간 개수와 정확히 같은 개수(${segments.length}개)의 결과를 출력해야 합니다. 절대 구간을 합치거나 건너뛰지 마세요. ` +
    "반드시 JSON 배열만 출력하세요. 다른 설명은 절대 붙이지 마세요. " +
    "형식: [{\"index\": 0, \"correctedText\": \"...\", \"flagged\": false, \"reason\": null, \"isSentenceEnd\": true, \"endPunctuation\": \".\"}, ...]";

  const userPrompt = "다음은 순서대로 이어지는 자막 구간들입니다:\n\n" +
    segments.map(s => `[${s.index}] ${s.rawText}`).join("\n");

  return callClaudeJsonArray(apiKey, CORRECTION_MODEL, systemPrompt, userPrompt, segments.length);
}

/**
 * segments: [{index, text, isSentenceEnd}, ...] (최종 교정/문장부호까지 끝난 자막 텍스트)
 * targetLangLabel: "영어", "일본어", "중국어(간체)" 등 사람이 읽는 언어 이름
 * apiKey: Anthropic API 키
 * glossary: { "한국어 고유명사": "이 언어에서 고정할 표기", ... } - 이 언어용으로 미리 뽑아온 것
 *
 * 반환: [{index, translatedText}, ...]
 */
async function translateSegments(segments, targetLangLabel, apiKey, glossary, videoContext) {
  if (segments.length > TRANSLATION_CHUNK_SIZE) {
    let allResults = [];
    for (let i = 0; i < segments.length; i += TRANSLATION_CHUNK_SIZE) {
      const chunk = segments.slice(i, i + TRANSLATION_CHUNK_SIZE);
      const chunkResults = await translateSegments(chunk, targetLangLabel, apiKey, glossary, videoContext);
      allResults = allResults.concat(chunkResults);
    }
    return allResults;
  }
  let glossaryInstruction = "";
  if (glossary && Object.keys(glossary).length) {
    const lines = Object.entries(glossary).map(([ko, translated]) => `'${ko}' → '${translated}'`).join(", ");
    glossaryInstruction =
      `다음 고유명사는 절대로 스스로 번역하거나 의역하거나 줄여쓰지 말고, 반드시 지정된 표기를 한 글자도 빠짐없이 그대로 사용하세요: ${lines}. ` +
      "이 규칙은 '간결하게 번역하라'는 지침보다 항상 우선합니다 — 지정된 표기가 길거나 자막에서 어색해 보여도 절대 일부 단어(특히 앞부분 수식어/회사명 접두어)를 " +
      "생략하거나 축약하지 마세요. 예를 들어 '대명 소노그룹 → Daemyung Sono Group'으로 지정되어 있다면, 자막이 아무리 짧아도 'Sono Group'처럼 앞부분을 빼고 쓰면 안 됩니다. " +
      "원문에서 띄어쓰기가 다르게 나타나거나(예: '동원토건' vs '동원 토건') 조사가 붙어 나타나도(예: '동원토건은', '동원토건이') 같은 단어로 인식해서 동일하게 지정된 표기를 적용하세요. ";
  }

  let videoContextInstruction = "";
  if (videoContext && videoContext.trim()) {
    videoContextInstruction =
      `이 영상의 배경/주제는 다음과 같습니다: "${videoContext.trim()}". 번역 시 이 맥락을 참고하세요. `;
  }

  const systemPrompt =
    `당신은 영상 자막 번역가입니다. 한국어 자막을 ${targetLangLabel}로 번역합니다. ` +
    videoContextInstruction +
    glossaryInstruction +
    "전체 맥락을 참고해 자연스럽게 번역하되, 각 구간의 의미 단위는 최대한 유지하세요 (한 구간을 여러 구간으로 나누거나 합치지 마세요). " +
    "각 구간에는 isSentenceEnd 표시가 있습니다. isSentenceEnd가 false인 구간은 원래 한국어에서 문장이 다음 구간으로 이어지는 중간 부분입니다. " +
    "이런 구간을 번역할 때는 그 구간만으로 억지로 완결된 문장을 만들지 말고, 다음 구간과 자연스럽게 이어지는 '문장의 일부'로 번역하세요 " +
    "(예: 앞부분만 있는 경우 콤마로 끝나거나 절 형태로 끝나는 등). 같은 내용이나 질문을 여러 구간에 걸쳐 중복해서 다시 말하지 마세요. " +
    "isSentenceEnd가 true인 구간에서 비로소 그 문장이 문법적으로 완결되어야 합니다. " +
    "매우 중요: 어떤 구간(index)도 절대 translatedText를 빈 문자열로 남기면 안 됩니다. " +
    "두 구간의 내용이 자연스럽게 하나로 합쳐지려는 경우에도, 번역문을 적절히 나누어 각 구간에 텍스트를 배분하세요 " +
    "(한쪽에 다 몰아주고 다른 쪽을 비우지 마세요). " +
    `입력은 정확히 ${segments.length}개 구간입니다. 구간을 절대 합치거나 생략하지 말고, 반드시 이 개수와 정확히 같은 개수(${segments.length}개)의 결과를 출력하고, 각각 최소 한 단어 이상 포함해야 합니다. ` +
    "구어체 영상 자막에 맞게 간결하게 번역하세요. " +
    "번역 후 스스로 의미가 원문과 같은지 다시 확인하세요: 특히 부정문을 이중부정이나 반어법으로 옮겨서 의미가 반대로 읽히거나 헷갈리게 만들지 마세요 " +
    "(예: '~하지 않는 건 아니잖아' 같은 한국어를 직역해서 어색한 이중부정 영어 문장을 만들지 말고, 원래 뉘앙스를 살리는 가장 명확하고 자연스러운 표현을 쓰세요). " +
    (targetLangLabel && targetLangLabel.includes("일본") ?
      "일본어로 번역할 때 시행(施行)과 시공(施工)처럼 발음(せこう)은 같지만 의미가 다른 한자어를 특히 주의하세요 — 문맥상 '공사를 진행하다'라는 뜻이면 施工을, " +
      "'제도/법을 시행하다'라는 뜻이면 施行을 정확히 구분해서 쓰고, 같은 개념은 영상 전체에서 같은 한자로 통일하세요. " : "") +
    "반드시 JSON 배열만 출력하세요. 다른 설명은 절대 붙이지 마세요. " +
    "형식: [{\"index\": 0, \"translatedText\": \"...\"}, ...]";

  const userPrompt = "다음은 순서대로 이어지는 한국어 자막 구간들입니다:\n\n" +
    segments.map(s => `[${s.index}] (isSentenceEnd: ${s.isSentenceEnd !== false}) ${s.text}`).join("\n");

  return callClaudeJsonArray(apiKey, TRANSLATION_MODEL, systemPrompt, userPrompt, segments.length);
}

/**
 * 화자 여러 명(또는 소스 여러 개)의 대본을 합친 전체 텍스트를 보고, 번역 시 일관성이
 * 흔들릴 위험이 있는 고유명사(회사명/기관명/인명/지명/상품명 등)를 찾아, 이 영상 전체에서
 * 통일해서 쓸 하나의 번역 표기를 정해준다. 이미 정식으로 등록되어 번역 표기가 고정된
 * 단어는 alreadyKnownTerms로 알려주면 결과에서 제외한다(건드릴 필요 없으니까).
 *
 * fullKoreanText: 화자 전원의 최종 한국어 자막 텍스트를 이어붙인 문자열
 * targetLangLabel: "영어", "일본어", "중국어(간체)" 등
 *
 * 반환: [{ko, translation}, ...] (없으면 빈 배열)
 */
async function extractSessionGlossary(fullKoreanText, targetLangLabel, apiKey, alreadyKnownTerms, videoContext) {
  let knownInstruction = "";
  if (alreadyKnownTerms && alreadyKnownTerms.length) {
    knownInstruction = `다음 단어들은 이미 번역 표기가 정해져 있으니 결과에 포함하지 마세요: ${alreadyKnownTerms.join(", ")}. `;
  }
  let videoContextInstruction = "";
  if (videoContext && videoContext.trim()) {
    videoContextInstruction = `이 영상의 배경/주제는 다음과 같습니다: "${videoContext.trim()}". `;
  }

  const systemPrompt =
    "당신은 영상 자막 번역팀의 용어 정리 담당자입니다. 여러 화자의 대본을 합친 아래 한국어 " +
    `전체 대본을 보고, ${targetLangLabel}로 번역할 때 화자마다(또는 매번) 다르게 번역될 위험이 있는 ` +
    "고유명사(회사명, 기관명, 인명, 지명, 브랜드/상품명 등)를 찾아내세요. " +
    "또한 얼핏 일반 명사처럼 보여도 이 영상에서는 특정 장소/시설을 가리키는 고정된 명칭으로 반복해서 쓰이는 단어도 포함하세요 " +
    "(예: 분양 현장 영상에서 '갤러리'가 매번 특정 견본주택/홍보관을 가리키는 경우, 번역할 때마다 다른 단어로 옮겨질 위험이 있으므로 포함). " +
    videoContextInstruction + knownInstruction +
    "대본 전체에서 하나로 통일해서 쓸 표기를 정하세요. 문맥과 무관하게 매번 같은 뜻으로 쓰이는 순수한 일반 명사, 흔한 단어, 대명사는 포함하지 마세요. " +
    "고유명사가 없거나 전부 이미 알려진 단어라면 빈 배열을 반환하세요. " +
    "반드시 JSON 배열만 출력하세요. 다른 설명은 절대 붙이지 마세요. " +
    "형식: [{\"ko\": \"우리자산신탁\", \"translation\": \"Woori Asset Trust\"}, ...]";

  const userPrompt = "전체 대본:\n\n" + fullKoreanText;

  const responseText = await callClaude(apiKey, TRANSLATION_MODEL, systemPrompt, userPrompt);
  const cleaned = responseText.replace(/```json\s*|```\s*/g, "").trim();
  let results;
  try {
    results = JSON.parse(cleaned);
  } catch (e) {
    throw new Error("세션 글로서리 응답 파싱 실패: " + cleaned.slice(0, 300));
  }
  if (!Array.isArray(results)) {
    throw new Error("세션 글로서리 응답이 JSON 배열이 아닙니다.");
  }
  return results;
}

/**
 * 자막 파이프라인과 무관하게, 업로드된 일반 텍스트(줄 단위)를 통째로 맞춤법/문법 검사한다.
 * 캡션 파이프라인의 correctWithContext와 별개 함수로 둔 이유: 그쪽 프롬프트는 "화면 컷 단위로
 * 잘린 자막 구간(isSentenceEnd 등)"을 전제로 하는데, 일반 텍스트 파일에는 안 맞는 전제라서
 * 프로퍼티 정확도를 위해 전용 프롬프트를 쓴다. 청크 분할/재시도 인프라(callClaudeJsonArray)는
 * 그대로 재사용한다.
 *
 * lines: string[] (원문 줄 단위, 빈 줄 제외하고 넘길 것)
 * 반환: [{index, correctedText, flagged, reason}, ...]
 */
async function checkSpelling(lines, apiKey, knownTerms, videoContext, checkPeriod) {
  if (lines.length > CORRECTION_CHUNK_SIZE) {
    let allResults = [];
    for (let i = 0; i < lines.length; i += CORRECTION_CHUNK_SIZE) {
      const chunk = lines.slice(i, i + CORRECTION_CHUNK_SIZE);
      const chunkResults = await checkSpelling(chunk, apiKey, knownTerms, videoContext, checkPeriod);
      allResults = allResults.concat(chunkResults);
    }
    return allResults;
  }

  const segments = lines.map((text, i) => ({ index: i, rawText: text }));

  let knownTermsInstruction = "";
  if (knownTerms && knownTerms.length) {
    knownTermsInstruction =
      `다음은 이 문서에서 자주 등장하는 정확한 고유명사 목록입니다: ${knownTerms.join(", ")}. ` +
      "이 목록의 단어들과 발음/표기가 비슷한 부분이 있다면 이 표기를 우선 적용하세요. ";
  }
  let videoContextInstruction = "";
  if (videoContext && videoContext.trim()) {
    videoContextInstruction = `이 문서의 배경/주제는 다음과 같습니다: "${videoContext.trim()}". `;
  }
  let periodInstruction = "";
  if (!checkPeriod) {
    periodInstruction =
      "이 텍스트는 영상 자막에서 뽑은 것이라, 화면에서 깔끔해 보이도록 문장 끝에 마침표(온점)를 " +
      "의도적으로 넣지 않는 스타일입니다. 문장 끝에 마침표나 물음표, 느낌표가 없다는 것 자체는 " +
      "절대 오류로 보지 마세요 - 그것만으로는 correctedText를 바꾸거나 flagged를 true로 하지 마세요. ";
  }

  const systemPrompt =
    "당신은 한국어 교정 전문가입니다. 아래는 문서를 줄 단위로 나눈 것입니다(각 줄이 반드시 " +
    "하나의 완결된 문장은 아닐 수 있습니다). 각 줄의 맞춤법, 띄어쓰기, 조사·어미 오류, 명백한 오타를 " +
    "교정하세요. " +
    videoContextInstruction + knownTermsInstruction + periodInstruction +
    "명백한 오류는 자신 있게 바로 고치고 flagged를 false로 하세요. " +
    "반면 고유명사(인명/지명/회사명/브랜드명)이거나, 정답 후보가 여러 개라 어떤 게 맞는지 " +
    "판단이 안 서는 경우에만 flagged를 true로 하고, correctedText는 원문을 그대로 두고, " +
    "reason에 어떤 단어들이 후보인지 적으세요. 문제가 없는 줄은 correctedText를 원문과 " +
    "동일하게 반환하고 flagged를 false로 하세요. " +
    `매우 중요: 입력은 정확히 ${segments.length}개 줄입니다. 줄을 합치거나 나누지 말고, ` +
    `정확히 ${segments.length}개의 결과를 순서대로 출력하세요. ` +
    "반드시 JSON 배열만 출력하세요. 다른 설명은 절대 붙이지 마세요. " +
    "형식: [{\"index\": 0, \"correctedText\": \"...\", \"flagged\": false, \"reason\": null}, ...]";

  const userPrompt = "다음은 순서대로 이어지는 문서의 줄들입니다:\n\n" +
    segments.map(s => `[${s.index}] ${s.rawText}`).join("\n");

  return callClaudeJsonArray(apiKey, CORRECTION_MODEL, systemPrompt, userPrompt, segments.length);
}

module.exports = { correctWithContext, translateSegments, extractSessionGlossary, checkSpelling };
