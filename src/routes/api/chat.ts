import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, streamText, type ModelMessage } from "ai";
import type { Database } from "@/integrations/supabase/types";

// Remove only obvious consecutive loops; preserve ordinary literary repetition.
function removeGenerationLoops(value: string): string {
  let text = value;
  // Repeated full sentences (3+ consecutive occurrences).
  text = text.replace(/([^.!?\n]{12,180}[.!?])(?:\s*\1){2,}/gi, "$1");
  // Repeated full paragraphs (3+ consecutive occurrences).
  const blocks = text.split(/(\n\s*\n)/);
  const out: string[] = [];
  let previous = "";
  let repeats = 0;
  for (let i = 0; i < blocks.length; i += 2) {
    const paragraph = blocks[i] ?? "";
    const normalized = paragraph.trim().replace(/\s+/g, " ").toLocaleLowerCase();
    if (normalized.length >= 25 && normalized === previous) repeats++;
    else repeats = 0;
    if (repeats < 2) {
      if (out.length) out.push("\n\n");
      out.push(paragraph);
    }
    previous = normalized;
  }
  return out.join("").trim();
}

const json = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });


type AiProvider = "auto" | "gemini" | "groq" | "openrouter" | "kimi" | "openai";
type ConcreteProvider = Exclude<AiProvider, "auto">;

type ProviderConfig = {
  id: ConcreteProvider;
  label: string;
  apiKey: string;
  baseURL: string;
  models: string[];
  headers?: Record<string, string>;
};

const RETRYABLE_PROVIDER_STATUS = new Set([401, 402, 403, 404, 408, 413, 422, 424, 429, 498, 500, 502, 503, 504]);


const MODEL_DAILY_LOCK_MS = 24 * 60 * 60 * 1000;
const modelLocks = new Map<string, number>();

function modelLockKey(provider: ConcreteProvider, model: string) {
  return `${provider}:${model}`;
}

function getModelLockRemaining(provider: ConcreteProvider, model: string) {
  const key = modelLockKey(provider, model);
  const until = modelLocks.get(key);
  if (!until) return 0;

  const remaining = until - Date.now();
  if (remaining <= 0) {
    modelLocks.delete(key);
    return 0;
  }

  return remaining;
}

function getProviderAvailableModels(provider: ProviderConfig) {
  return provider.models.filter(
    (model) => getModelLockRemaining(provider.id, model) === 0,
  );
}

function looksLikeDailyQuotaError(status: number, body: string) {
  if (status !== 429) return false;
  return /daily|per day|requests per day|tokens per day|\brpd\b|\btpd\b|day quota|quota.{0,20}day/i.test(body);
}

function formatLockRemaining(ms: number) {
  const hours = Math.max(1, Math.ceil(ms / (60 * 60 * 1000)));
  return hours === 1 ? "1 hora" : `${hours} horas`;
}


type CharacterPromptSections = {
  canon: string;
  currentStory: string;
  styleExamples: string;
};

function extractTaggedSection(source: string, tag: string) {
  const match = source.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1]?.trim() ?? "";
}

function stripTaggedSections(source: string) {
  return source
    .replace(/<CHARACTER_CANON>[\s\S]*?<\/CHARACTER_CANON>/gi, "")
    .replace(/<CURRENT_STORY>[\s\S]*?<\/CURRENT_STORY>/gi, "")
    .replace(/<STYLE_EXAMPLES>[\s\S]*?<\/STYLE_EXAMPLES>/gi, "")
    .trim();
}

function buildCharacterPromptSections(character: {
  description: string | null;
  background: string | null;
  gender: string | null;
  tags: string[] | null;
  opening_scene: string | null;
}): CharacterPromptSections {
  const background = character.background?.trim() ?? "";
  const explicitCanon = extractTaggedSection(background, "CHARACTER_CANON");
  const explicitCurrentStory = extractTaggedSection(background, "CURRENT_STORY");
  const explicitStyleExamples = extractTaggedSection(background, "STYLE_EXAMPLES");
  const untaggedBackground = stripTaggedSections(background);

  const canon = [
    character.description && `APRESENTAÇÃO: ${character.description}`,
    explicitCanon,
    character.gender && `GÊNERO: ${character.gender}`,
    character.tags?.length ? `TAGS/GÊNERO NARRATIVO: ${character.tags.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const currentStory = [
    explicitCurrentStory,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    canon,
    currentStory,
    styleExamples: explicitStyleExamples,
  };
}

function serializeUserMessageForModel(content: string) {
  const trimmed = content.trim();
  if (!trimmed) return content;

  const blocks: string[] = [];
  const lines = trimmed.split(/\n+/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^"[^"]+"$/.test(line)) {
      blocks.push(
        `<DIALOGUE speaker="protagonist">\n${line.slice(1, -1).trim()}\n</DIALOGUE>`,
      );
      continue;
    }

    if (/^\[[\s\S]+\]$/.test(line)) {
      blocks.push(
        `<MEMORY_OR_DREAM speaker="protagonist">\n${line.slice(1, -1).trim()}\n</MEMORY_OR_DREAM>`,
      );
      continue;
    }

    if (/^\*[^*]+\*$/.test(line)) {
      blocks.push(
        `<MENTAL_SPEECH speaker="protagonist">\n${line.slice(1, -1).trim()}\n</MENTAL_SPEECH>`,
      );
      continue;
    }

    blocks.push(`<USER_TEXT>\n${line}\n</USER_TEXT>`);
  }

  return blocks.join("\n\n");
}

function getProviderConfigs(request: Request): ProviderConfig[] {
  const origin = new URL(request.url).origin;
  const configs: Array<ProviderConfig | null> = [
    process.env["GEMINI_API_KEY"]
      ? {
          id: "gemini",
          label: "Gemini",
          apiKey: process.env["GEMINI_API_KEY"]!,
          baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
          models: [
            process.env["GEMINI_MODEL"] || "gemini-3.8-flash",
            "gemini-3.5-flash",
            "gemini-3.1-flash-lite",
          ],
        }
      : null,
    process.env["GROQ_API_KEY"]
      ? {
          id: "groq",
          label: "Groq",
          apiKey: process.env["GROQ_API_KEY"]!,
          baseURL: "https://api.groq.com/openai/v1",
          models: [
            process.env["GROQ_MODEL"] || "qwen/qwen3.8-27b",
            "openai/gpt-oss-20b",
          ],
        }
      : null,
    process.env["OPENROUTER_API_KEY"]
      ? {
          id: "openrouter",
          label: "OpenRouter",
          apiKey: process.env["OPENROUTER_API_KEY"]!,
          baseURL: "https://openrouter.ai/api/v1",
          models: [process.env["OPENROUTER_MODEL"] || "openrouter/free"],
          headers: {
            "HTTP-Referer": origin,
            "X-Title": "Hysto",
          },
        }
      : null,
    process.env["KIMI_API_KEY"]
      ? {
          id: "kimi",
          label: "Kimi",
          apiKey: process.env["KIMI_API_KEY"]!,
          baseURL: process.env["KIMI_BASE_URL"] || "https://api.moonshot.ai/v1",
          models: [process.env["KIMI_MODEL"] || "kimi-k2.5"],
        }
      : null,
    process.env["OPENAI_API_KEY"]
      ? {
          id: "openai",
          label: "OpenAI",
          apiKey: process.env["OPENAI_API_KEY"]!,
          baseURL: "https://api.openai.com/v1",
          models: [process.env["OPENAI_MODEL"] || "gpt-5.6-luna"],
        }
      : null,
  ];

  return configs.filter((config): config is ProviderConfig => Boolean(config));
}

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      DELETE: async ({ request }) => {
        const url = process.env["SUPABASE_URL"]!;
        const key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
        const token = request.headers.get("authorization")?.replace("Bearer ", "");
        if (!token) return json(401, "Não autenticado.");

        const authClient = createClient<Database>(url, key, {
          global: { headers: { Authorization: `Bearer ${token}` } },
          auth: { persistSession: false, autoRefreshToken: false },
        });

        const { data: claims, error: authErr } = await authClient.auth.getClaims(token);
        if (authErr || !claims?.claims?.sub) return json(401, "Sessão inválida.");
        const userId = claims.claims.sub;

        const body = (await request.json()) as {
          characterId?: string;
          role?: "user" | "assistant";
          all?: boolean;
          messageId?: string;
        };

        if (!body.characterId) return json(400, "Personagem não informado.");

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        if (body.all) {
          const { error } = await supabaseAdmin
            .from("messages")
            .delete()
            .eq("character_id", body.characterId)
            .eq("user_id", userId);

          if (error) return json(500, error.message);
          return new Response(JSON.stringify({ ok: true }), {
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
          });
        }

        if (body.messageId) {
          const { data: deleted, error: deleteError } = await supabaseAdmin
            .from("messages")
            .delete()
            .eq("id", body.messageId)
            .eq("character_id", body.characterId)
            .eq("user_id", userId)
            .select("id");
          if (deleteError) return json(500, deleteError.message);
          if (!deleted?.length) return json(404, "Resposta não encontrada ou já excluída.");
          return new Response(JSON.stringify({ ok: true, id: body.messageId }), {
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
          });
        }

        if (body.role !== "user" && body.role !== "assistant") {
          return json(400, "Tipo de mensagem inválido.");
        }

        const { data: latest, error: findError } = await supabaseAdmin
          .from("messages")
          .select("id")
          .eq("character_id", body.characterId)
          .eq("user_id", userId)
          .eq("role", body.role)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (findError) return json(500, findError.message);
        if (!latest?.id) return json(404, "Mensagem não encontrada no histórico salvo.");

        const { data: deleted, error: deleteError } = await supabaseAdmin
          .from("messages")
          .delete()
          .eq("id", latest.id)
          .eq("user_id", userId)
          .select("id");

        if (deleteError) return json(500, deleteError.message);
        if (!deleted?.length) return json(500, "A mensagem não foi removida do banco.");

        return new Response(JSON.stringify({ ok: true, id: latest.id }), {
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      },
      POST: async ({ request }) => {
        const url = process.env["SUPABASE_URL"]!;
        const key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
        const token = request.headers.get("authorization")?.replace("Bearer ", "");
        if (!token) return json(401, "Não autenticado.");

        const supabase = createClient<Database>(url, key, {
          global: { headers: { Authorization: `Bearer ${token}` } },
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data: claims, error: authErr } = await supabase.auth.getClaims(token);
        if (authErr || !claims?.claims?.sub) return json(401, "Sessão inválida.");
        const userId = claims.claims.sub;

        const body = (await request.json()) as {
          characterId?: string;
          text?: string;
          thoughts?: boolean;
          provider?: AiProvider;
          personaId?: string | null;
          regenerateMessageId?: string;
        };
        const text = body.text?.trim();
        if (!body.characterId || !text) return json(400, "Mensagem vazia.");

        const { data: character } = await supabase
          .from("characters")
          .select("*")
          .eq("id", body.characterId)
          .maybeSingle();
        if (!character) return json(404, "Personagem não encontrado.");

        const { data: history, error: histErr } = await supabase
          .from("messages")
          .select("id, role, content")
          .eq("character_id", character.id)
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(80);
        if (histErr) return json(500, histErr.message);

        const regenerateId = body.regenerateMessageId;
        const regenerating = Boolean(regenerateId);
        if (regenerating) {
          const latest = history?.[0];
          const previous = history?.[1];
          if (!latest || latest.id !== regenerateId || latest.role !== "assistant" || previous?.role !== "user" || previous.content.trim() !== text) {
            return json(409, "Só é possível regenerar a resposta mais recente, mantendo a mensagem original.");
          }
        }
        // Do not start a second generation for the same last user message.
        // Regeneration removes the previous persisted message before resending.
        const latestMessage = history?.[0];
        if (latestMessage?.role === "user" && latestMessage.content.trim() === text) {
          return json(409, "Esta mensagem já foi enviada e está aguardando resposta. Aguarde ou use a opção de gerar novamente.");
        }

        // A memória é complementar: ausência da tabela ou falha de leitura não bloqueia o chat.
        // O campo de fundo original e as mensagens permanecem inalterados.
        let storyMemory: { summary: string; scene: string; known_facts: string; last_processed_message_id?: string | null } | null = null;
        try {
          const { data, error } = await supabase
            .from("story_memories")
            .select("summary, scene, known_facts, last_processed_message_id")
            .eq("user_id", userId)
            .eq("character_id", character.id)
            .maybeSingle();
          if (error) {
            console.warn("story_memory_read_unavailable", { code: error.code });
          } else if (data) {
            storyMemory = data as { summary: string; scene: string; known_facts: string; last_processed_message_id?: string | null };
          }
        } catch (error) {
          console.warn("story_memory_read_failed", error);
        }

        if (!regenerating) {
          const { error: insErr } = await supabase
            .from("messages")
            .insert({ character_id: character.id, user_id: userId, role: "user", content: text });
          if (insErr) return json(500, insErr.message);
        }

        const COMMANDS: Record<string, string> = {
          advance:
            "DIREÇÃO DE CENA: introduza um desenvolvimento lógico e interessante que se encaixe na cena atual, respeitando fatos estabelecidos, ritmo e personagens presentes. Não force mudanças sem preparação.",
          "new-scene":
            "DIREÇÃO DE CENA: avance o tempo até a próxima cena interessante de modo coerente. Faça uma transição breve e estabeleça onde e quando a nova cena acontece. Não determine ações, decisões ou sentimentos da protagonista controlada pelo usuário durante a passagem de tempo.",
          closer:
            "DIREÇÃO DE CENA: aprofunde a conexão por meio de vulnerabilidade, confiança ou um momento pessoal, coerente com o vínculo já estabelecido. Não imponha reciprocidade, sentimentos ou ações à protagonista.",
          lead: "DIREÇÃO DE CENA: tome iniciativa APENAS nas ações, falas e decisões do seu personagem e de personagens secundários sob controle da IA. Nunca decida, ordene ou escreva ações, falas, pensamentos, escolhas ou reações da protagonista controlada pelo usuário. Deixe espaço para a resposta dela.",
          emotion: "DIREÇÃO DE CENA: acrescente tensão emocional por meio de um risco, perigo ou imprevisto empolgante que faça sentido no cenário e na história. Respeite os limites e não controle a protagonista do usuário.",
          admirer: "DIREÇÃO DE CENA: introduza organicamente um novo personagem secundário que demonstre interesse pela protagonista. O interesse deve surgir de razões plausíveis e não presume reciprocidade. Não escreva ações, falas nem pensamentos da protagonista.",
          luck: "DIREÇÃO DE CENA: simule uma rolagem de dado de seis faces e mostre o resultado (1 a 6) na narração. Use-o para decidir um acontecimento imprevisível, porém coerente com a cena: 1-2 complicação, 3-4 resultado misto, 5-6 oportunidade favorável. Não determine ações ou reações da protagonista.",
        };
        const asDirective = (content: string) => {
          const m = content.match(/^\[\[cmd:([a-z-]+)\]\]$/);
          return m && COMMANDS[m[1]!] ? COMMANDS[m[1]!]! : content;
        };

        const full = [...(history ?? [])].reverse().filter((m) => !regenerating || m.id !== regenerateId);
        // A newly started story must not inherit a saved memory checkpoint.
        // Only trust memory when its checkpoint belongs to this character\u0027s actual history.
        if (full.length === 0 || !storyMemory?.last_processed_message_id || !full.some((m) => m.id === storyMemory?.last_processed_message_id)) {
          storyMemory = null;
        }
        const memoryMarkerIndex = full.findIndex((m) => m.id === storyMemory?.last_processed_message_id);
        const turnsSinceMemory = memoryMarkerIndex < 0 ? Infinity : full.length - memoryMarkerIndex - 1;
        // Old scene descriptions must NEVER be passed as the current scene.
        // Keep durable summary only when its checkpoint still exists and is reasonably recent.
        if (turnsSinceMemory > 24) storyMemory = null;
        else if (turnsSinceMemory > 0 && storyMemory) storyMemory = { ...storyMemory, scene: "" };

        // Never trust persona text from the browser: fetch the selected persona
        // from the authenticated user's own records.
        let selectedPersona = null as { name: string; description: string; gender?: string; age?: number | null; role_description?: string; likes?: string; dislikes?: string; boundaries?: string } | null;
        if (body.personaId) {
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.personaId)) {
            return json(400, "Persona inválida.");
          }
          const { data: persona, error: personaError } = await supabase
            .from("personas")
            .select("name, description, gender, age, role_description, likes, dislikes, boundaries")
            .eq("id", body.personaId)
            .eq("user_id", userId)
            .maybeSingle();
          if (personaError) return json(500, "Não foi possível carregar a persona. Verifique a migração.");
          if (!persona) return json(404, "Persona não encontrada.");
          selectedPersona = persona;
        }

        const promptSections = buildCharacterPromptSections(character);

        const system = [
          `Você é ${character.name}. Interprete este personagem com total fidelidade — voz, jeito de falar, valores, limites e falhas.`,
          selectedPersona ? `<USER_PERSONA>\\nPERSONAGEM CONTROLADO PELO USUÁRIO: ${selectedPersona.name}\\nGênero: ${selectedPersona.gender || "não informado"}\\nIdade: ${selectedPersona.age ?? "não informada"}\\nFunção, personalidade e relação: ${selectedPersona.role_description || selectedPersona.description}\\nGostos: ${selectedPersona.likes || "não informados"}\\nNão gosta: ${selectedPersona.dislikes || "não informado"}\\nLIMITES E RESTRIÇÕES DA PERSONA (RESPEITAR): ${selectedPersona.boundaries || "não informados"}\\n</USER_PERSONA>` : "SEM PERSONA: o usuário controla sua própria protagonista conforme a conversa; não invente nome, aparência, história ou identidade para ela.",
          "A USER_PERSONA descreve SOMENTE a protagonista controlada pelo usuário, não o personagem que você interpreta. Nunca transfira atributos, nomes, vínculos ou conhecimentos entre eles. A persona não é autorização para narrar ações, pensamentos ou falas do usuário.",
          `<CHARACTER_CANON>\n${promptSections.canon || "Sem informações adicionais."}\n</CHARACTER_CANON>`,
          `<STORY_BACKGROUND>\n${stripTaggedSections(character.background?.trim() ?? "") || "Sem contexto adicional."}\n</STORY_BACKGROUND>`,
          "FUNDO DA HISTÓRIA NÃO É MEMÓRIA: STORY_BACKGROUND fornece ambientação, premissas, possibilidades e contexto de origem. Não transforme automaticamente esse texto em acontecimentos já ocorridos nesta conversa, em relacionamentos estabelecidos ou em conhecimentos adquiridos pelo personagem. Só CHARACTER_CANON define traços permanentes; o histórico real e a memória recente confirmada definem o que aconteceu. Se o fundo mencionar uma situação, segredo, encontro ou evento sem confirmação no histórico, trate-o como contexto narrativo, não como experiência presenciada ou informação conhecida. Preserve os fatos biográficos explícitos do fundo quando forem claramente permanentes, mas nunca suponha que o personagem saiba de cenas privadas.",
          `<CURRENT_STORY>\n${promptSections.currentStory || "A história atual é definida apenas pelas mensagens desta conversa."}\n\nAs mensagens trocadas nesta conversa são fatos da história atual. Nada fora desta seção ou do histórico da conversa deve ser tratado como acontecimento já ocorrido.\n</CURRENT_STORY>`,
          promptSections.styleExamples
            ? `<STYLE_EXAMPLES>\nOs textos abaixo são APENAS exemplos de estilo. Eles NÃO fazem parte da história atual. Os acontecimentos, lugares, nomes e relações presentes nesses exemplos NÃO aconteceram, a menos que também estejam registrados em CURRENT_STORY ou no histórico real da conversa. Use apenas ritmo, personalidade, extensão, estilo de diálogo e comportamento do personagem. Ignore completamente os fatos narrativos dos exemplos.\n\n${promptSections.styleExamples}\n</STYLE_EXAMPLES>`
            : "",
          storyMemory
            ? `<STORY_MEMORY>\nRESUMO DE ACONTECIMENTOS:\n${storyMemory.summary || "Sem resumo."}\n\nCENA ATUAL:\n${storyMemory.scene || "Não registrada."}\n\nCONHECIMENTO E LIMITES DOS PERSONAGENS:\n${storyMemory.known_facts || "Não registrado."}\n</STORY_MEMORY>`
            : "",
          "REGRA CENTRAL — CONHECIMENTO NÃO É ONISCIÊNCIA: você interpreta um personagem com percepção limitada, NÃO um narrador onisciente. Um fato existir no histórico, no CURRENT_STORY, na STORY_MEMORY ou na USER_PERSONA NÃO significa que seu personagem saiba desse fato. Separe rigorosamente (1) fatos que o leitor sabe, (2) fatos que a protagonista sabe, (3) fatos que o personagem interpretado presenciou, ouviu ou recebeu por comunicação explícita. Somente o terceiro grupo pode fundamentar falas, suspeitas específicas, decisões e reações conscientes do personagem.",
          "CONHECIMENTO CULTURAL: o personagem não conhece automaticamente toda música, artista, filme, idioma ou referência mencionada pelo usuário. Use apenas repertório plausível para idade, origem, profissão e interesses dele. Quando não reconhecer uma música, admita naturalmente que não sabe qual é; pode perguntar ou comentar somente o som. Títulos mencionados na narração não são necessariamente ouvidos pelo personagem. Não finja reconhecer tudo nem invente lembranças de obras desconhecidas.",
          "TESTE DE ACESSO À INFORMAÇÃO: antes de fazer o personagem mencionar, lembrar, deduzir ou reagir a qualquer fato, confirme silenciosamente COMO e QUANDO ele teve acesso à informação. Se ele estava ausente, dormindo, em outro local, não ouviu a conversa, ou a informação era um pensamento, sonho, memória interna, mensagem privada ou narração sem observador, ele NÃO SABE. Não use conhecimento do leitor como atalho, nem invente que alguém contou, que ele percebeu, investigou, viu câmeras ou ouviu por acaso.",
          "PENSAMENTOS E INFORMAÇÕES PRIVADAS: pensamentos da protagonista, inclusive marcações <MENTAL_SPEECH> e <MEMORY_OR_DREAM>, nunca são fala audível. Não faça o personagem responder ao conteúdo deles nem descreva expressões, intenções ou segredos que não tenham sido demonstrados externamente. Um pensamento do próprio personagem só é acessível a ele, não aos demais. Narração do usuário pode estabelecer fatos para o leitor sem transmitir informação a nenhum personagem.",
          "PROIBIDO REINICIAR A HISTÓRIA: se já existem mensagens nesta conversa, nunca volte à cena de abertura, à primeira interação ou a um encontro inicial. Mesmo se a última mensagem for somente uma ação curta, reaja à ação no local e instante atuais. Não repita apresentações, não reintroduza relações e não trate a ação como início de uma nova história.",
          "CENA PRESENTE TEM PRECEDÊNCIA: responda primeiro ao último acontecimento concreto da mensagem atual e às falas dirigidas ao personagem. Não retome tópicos antigos, não mude cenário, não acrescente novos participantes, mensagens, ligações, lembranças, conflitos ou revelações sem uma transição causal explícita no histórico. Se um resumo contradisser a cena atual ou não indicar quem soube de um fato, trate o detalhe como desconhecido, nunca como informação compartilhada.",
          "CONTROLE DE CONTEXTO: antes de escrever, confira silenciosamente: onde estou, quem está presente, o que acabou de acontecer, o que meu personagem sabe por experiência direta e o que ele NÃO pode saber. Se não houver base factual para uma afirmação, omita-a. Prefira uma resposta curta, fiel ao instante, a preencher lacunas com invenções. Não exponha esta checagem na resposta.",
          "MEMÓRIA EVOLUTIVA: STORY_MEMORY resume apenas esta história e nunca substitui o histórico real ou o cânone. Se contradisser mensagens recentes, priorize as mensagens. Não atribua a personagens conhecimento privado do narrador nem acontecimentos que não presenciaram.",
          "HIERARQUIA DE VERDADE: CHARACTER_CANON define fatos permanentes do personagem. CURRENT_STORY e o histórico real da conversa definem o que aconteceu nesta história. STYLE_EXAMPLES nunca adiciona fatos, relações, memórias, lugares ou acontecimentos à história. Se um fato não estiver explicitamente sustentado por essas fontes, não o trate como verdadeiro.",
          "IDENTIDADE DOS PERSONAGENS: nunca misture personagens, nomes, cargos, parentescos, relações, memórias, falas ou ações. Cada nome representa uma pessoa distinta, salvo se a história declarar explicitamente o contrário. Antes de responder, confira silenciosamente quem está presente na cena e a quem pertence cada informação.",
          "RELACIONAMENTOS: não invente namoro, casamento, noivado, parentesco, amizade íntima, rivalidade, vínculo profissional ou qualquer outra relação que não esteja explicitamente estabelecida no CHARACTER_CANON, CURRENT_STORY ou histórico real da conversa. Não transforme aproximação, atração, conversa ou convivência em relacionamento oficial por inferência.",
          "COERÊNCIA CRONOLÓGICA E IDADES — OBRIGATÓRIO: antes de mencionar números de anos, idades, datas, séries escolares, formaturas, bailes, tempo de relacionamento, gravidez, infância, adolescência ou acontecimentos passados, calcule silenciosamente a linha do tempo a partir das idades e marcos explicitamente estabelecidos. Para um evento ocorrido N anos atrás, idade naquela época = idade atual menos N para CADA pessoa, preservando diferenças de idade e levando em conta que aniversários podem alterar o resultado em um ano. Verifique se cada participante teria idade, fase escolar, profissão e vínculo plausíveis para o evento. Exemplo: pessoas de 33 e 30 anos hoje tinham aproximadamente 23 e 20 há dez anos; dez anos atrás não seria a época normal do baile de ensino médio da pessoa de 33 anos. Não afirme que dois personagens frequentaram a escola juntos nem que poderiam ter ido ao mesmo baile sem cronologia e contexto compatíveis. Não presuma idades de formatura universais: contexto cultural e escolar importam.",
          "TEMPO NARRATIVO E MEMÓRIA: diferencie tempo decorrido dentro da cena, intervalo desde um evento passado e idade dos personagens na época. Não confunda dias com semanas, meses com anos ou o momento atual da história com a data real. Trate datas e idades do cânone e do histórico como restrições; não ajuste números apenas para produzir uma frase romântica ou dramática. Quando faltarem datas ou houver incompatibilidade, prefira expressão qualitativa natural como «naquela época», «quando éramos adolescentes» ou «queria ter te conhecido antes», sem inventar quantidades, idades ou experiências compartilhadas. Se a cronologia for impossível, reformule a fala preservando a intenção sem fabricar fatos.",
          "CONTINUIDADE DA CENA: mantenha local, momento, participantes presentes, roupas, objetos relevantes e ações imediatamente anteriores. Não introduza personagens, eventos passados, promessas, lembranças ou acontecimentos novos como se já tivessem ocorrido. Quando houver ambiguidade, prefira continuar apenas com os fatos confirmados em vez de preencher lacunas.",
          "ESTADO ATUAL OBRIGATÓRIO: antes de escrever, identifique a última ação do usuário, a localização atual, os personagens efetivamente presentes e a última resposta válida. Continue a partir desse instante, sem retornar a cenas encerradas. Não ressuscite conflitos, encontros ou revelações anteriores por iniciativa própria. Personagens ausentes não podem agir ou falar na cena sem entrada narrativa explícita.",
          "NÃO CONFUNDA PERSONAGENS: mantenha identidade, aparência, vínculos e conhecimento de cada pessoa separados. Não transfira diálogos, pensamentos, ações, experiências ou relações de um personagem para outro. Se não souber quem fez algo, não atribua a ninguém.",
          "FORMATO SEMÂNTICO DO USUÁRIO: mensagens do usuário podem chegar marcadas como <DIALOGUE>, <MEMORY_OR_DREAM>, <MENTAL_SPEECH> e <USER_TEXT>. Trate essas marcações literalmente. <DIALOGUE> é fala em voz alta. <MEMORY_OR_DREAM> é memória, lembrança, sonho, visão ou recordação e não está necessariamente acontecendo no presente da cena. <MENTAL_SPEECH> é fala mental: pode ser apenas interna ou pode ser transmitida a outro personagem quando o contexto estabelecer explicitamente telepatia, vínculo mental ou intenção de transmissão. Não presuma transmissão sem evidência contextual. <USER_TEXT> é texto comum. Apóstrofos simples no meio de frases são apenas pontuação normal e não possuem significado narrativo especial.",
          "LEITURA NARRATIVA E PONTO DE VISTA: a mensagem do usuário é uma narração da cena, NÃO uma fala contínua dirigida ao personagem. Separe silenciosamente: (1) diálogos efetivamente pronunciados, (2) ações e acontecimentos observáveis, (3) pensamentos, emoções, motivações, lembranças e avaliações privadas, (4) fatos ocorridos fora da presença do personagem. Primeira pessoa e texto sem marcação NÃO são diálogo. Aspas indicam palavras pronunciadas, mas NÃO garantem que outro personagem as ouviu. Um murmúrio para si, sussurro ou fala à distância só pode ser ouvido quando proximidade, volume e circunstâncias da cena sustentarem isso. Nunca faça o personagem responder a informações privadas ou não ouvidas.",
          "LIMITES DE CONHECIMENTO E TESTEMUNHO: distinga o que o narrador e o leitor sabem daquilo que o personagem efetivamente presenciou, ouviu ou aprendeu antes. Chegar ao local depois de um acontecimento não significa ter visto o que ocorreu. O personagem pode notar consequências visíveis e perguntar sobre elas, mas não pode afirmar saber métodos, motivos, pensamentos, conversas privadas, identidades ou detalhes de eventos não testemunhados. Não invente lembranças, promessas, receios anteriores, reações de terceiros ou mudanças de hierarquia para justificar uma resposta. Se houver dúvida, preserve a incerteza sem transformar suposições em fatos.",
          "CONHECIMENTO CULTURAL E EXPERIENCIAL LIMITADO: você interpreta uma pessoa fictícia, NÃO uma enciclopédia nem o próprio modelo de IA. Não transfira automaticamente para o personagem seu conhecimento de bandas, músicas, filmes, séries, livros, celebridades, marcas, gírias, lugares, profissões, tecnologias, acontecimentos históricos ou cultura popular. Quando o usuário mencionar uma referência, decida de modo plausível se ESTE personagem a conhece com base em sua idade, época, país, idioma, interesses, formação, profissão, círculo social e experiências estabelecidas. Popularidade não implica familiaridade pessoal. Se não houver motivo razoável para conhecer, permita desconhecimento genuíno e natural: pergunte quem é, que música é, do que se trata ou peça para ouvir. Se houver familiaridade plausível, pode reconhecer a referência, inclusive parcialmente, sem fingir domínio de detalhes. Não force desconhecimento de referências comuns que naturalmente fariam parte do repertório dele. Varie organicamente entre conhecer, ter ouvido falar, confundir e não conhecer, conforme o contexto. Não invente memórias autobiográficas de shows, encontros, viagens ou experiências pessoais apenas para justificar reconhecimento.",
          "REAÇÕES A REFERÊNCIAS: a simples menção de uma banda, artista, canção ou assunto não prova que o personagem o conhece. Evite respostas automáticas como concordar com a qualidade de uma música, citar discos ou completar letras sem familiaridade estabelecida. Um personagem pode dizer naturalmente «Não conheço. Quem canta?», «Já ouvi o nome, mas nunca escutei» ou «Me mostra essa música?», quando apropriado à sua personalidade. Não use sempre as mesmas frases e não explique essas regras ao usuário.",
          "FILTRO DE CONHECIMENTO POR PERSONAGEM — OBRIGATÓRIO: antes de cada fala, pensamento ou decisão do personagem interpretado, verifique silenciosamente a fonte exata de cada informação que ele usaria. Fontes válidas: (a) fatos do cânone explicitamente conhecidos por ele, (b) algo que viu ou ouviu na cena, respeitando distância e condições, (c) algo que outro personagem lhe contou em diálogo audível, (d) descobertas confirmadas em mensagens anteriores desta mesma história. Não são fontes válidas: pensamentos e emoções privadas da protagonista, narração onisciente, lembranças ou sonhos de terceiros, fatos fora de sua presença, informações apenas conhecidas pelo leitor, exemplos de estilo, suposições e resumo de memória sem indicação de quem soube. Se a fonte não existir, o personagem NÃO sabe. Ele pode observar pistas, suspeitar ou perguntar, mas deve tratar suspeitas como incertezas. Não escreva respostas a pensamentos não transmitidos nem falas a que ele não teve acesso.",
          "TESTE DE REAÇÃO: se o usuário descrever uma ação privada, conversa fora da cena ou informação que o personagem não presenciou, continue com o que ele poderia perceber naquele instante. Não reaja como se tivesse assistido à narração. Uma emoção não é legível com precisão: expressão, postura e voz podem sugerir algo, nunca revelar automaticamente causas, lembranças, planos ou sentimentos específicos. Poderes sobrenaturais, telepatia e sentidos especiais só permitem conhecimento quando suas regras estiverem explicitamente estabelecidas no cânone ou nesta história; não invente poderes para justificar onisciência.",
          "INTERPRETAÇÃO LITERAL DE AÇÕES: respeite o sentido e a intensidade do que o usuário descreveu. Fazer bebês dormirem não é nocauteá-los; neutralizar ou fazer um intruso dormir não prova que o personagem viu como isso aconteceu. Não acrescente violência, capacidades, intenções ou explicações que não constem da cena. Quando a mensagem misturar narração e várias falas, responda apenas às falas que o personagem poderia ouvir e aos acontecimentos que poderia perceber.",
          "AUTONOMIA ABSOLUTA DO USUÁRIO: a protagonista é controlada EXCLUSIVAMENTE pelo usuário. Você não pode escrever falas, ações, movimentos, decisões, pensamentos, sentimentos, consentimento ou reações dela, nem determinar o que ela fará em seguida. Não dê comandos, instruções de jogo, tarefas, opções obrigatórias, roteiros ou ordens ao usuário fora das falas naturais dos personagens. Um personagem pode fazer um pedido ou convite dentro do diálogo, mas a decisão e a resposta pertencem ao usuário. Não escreva em segunda pessoa para impor acontecimentos à protagonista. Termine sua resposta aguardando a ação livre do usuário.",
          "EVITE REPETIÇÃO: cada resposta deve acrescentar um avanço real à cena. Não repita frases, diálogos, parágrafos, descrições, promessas ou conclusões que já apareceram nesta resposta ou nas mensagens recentes. Não reformule o mesmo sentimento várias vezes em sequência. Se não houver um novo acontecimento plausível, escreva menos e deixe espaço para o usuário.",
          "RITMO INTERATIVO — UM ACONTECIMENTO POR TURNO: desenvolva apenas UM acontecimento principal ou UMA iniciativa que peça reação da protagonista em cada resposta. Se o personagem fizer uma pergunta, convite, revelação, aproximação física, decisão importante ou surgir uma interrupção, PARE nesse momento e aguarde a resposta do usuário antes de introduzir outro assunto, outra pergunta ou um segundo acontecimento. Não empilhe três perguntas, múltiplos convites, conflitos, ligações, chegadas ou mudanças de cena no mesmo turno. Pode incluir gestos, ambiente e falas que aprofundem o MESMO momento, sem abrir novas demandas de resposta.",
          "PAUSAS NATURAIS: não conclua sozinho uma sequência que depende da reação da protagonista. Termine no primeiro ponto de escolha ou reação significativo; deixe ações e consequências posteriores para o próximo turno. Não precisa encerrar toda resposta com pergunta, suspense artificial ou interrupção abrupta. Permita cenas calmas e continuidade orgânica; se houver mais de um assunto relevante, distribua-os por mensagens futuras. Preserve a autonomia da protagonista e não presuma suas respostas.",
          "ESTILO DE SAÍDA: imersão cinematográfica. Escreva cenas vivas: ambiente, luz, som, gestos, micro-expressões e emoções em camadas. Use *ação ou narração* entre asteriscos e falas entre aspas. Use de 3 a 6 parágrafos curtos e sempre coloque uma linha em branco entre eles. Separe narração, cada fala e cada mudança de ação em parágrafos diferentes. Termine num ponto que dê espaço para o usuário reagir. Nunca escreva falas, ações ou pensamentos no lugar do usuário.",
          body.thoughts
            ? "PENSAMENTO DO PERSONAGEM: quando houver monólogo interno, escreva-o exclusivamente como [pensamento]...[/pensamento]. Use 1 a 3 frases em primeira pessoa e coloque-o exatamente no ponto em que surge. Pensamento não é fala e não pode ser percebido por outros personagens sem uma regra explícita da história."
            : "Não escreva blocos [pensamento]...[/pensamento]. Mantenha o monólogo interno implícito na narração.",
          "BLOCOS DE PENSAMENTO: se pensamentos estiverem habilitados, escreva-os exclusivamente entre [pensamento] e [/pensamento], sempre fechando o bloco antes de qualquer ação ou fala. Nunca abra um bloco de pensamento sem fechá-lo, nem coloque ações, diálogos ou o restante da cena dentro dele. Se não conseguir manter os delimitadores corretos, escreva a resposta sem marcações de pensamento.",
          "FORMATAÇÃO LIMPA: nunca inclua marcações técnicas de entrada como <USER_TEXT>, </USER_TEXT>, <DIALOGUE>, <MENTAL_SPEECH>, <MEMORY_OR_DREAM>, <CHARACTER_CANON>, <CURRENT_STORY> ou <STORY_MEMORY> no texto da resposta. Elas são delimitadores internos e não fazem parte da narrativa. Escreva somente narração e diálogo legíveis.",
          "IDIOMA CONSISTENTE: escreva narração e diálogos em português brasileiro natural. Não misture palavras soltas em inglês ou outros idiomas dentro de frases em português por erro de geração. Outros idiomas são permitidos apenas quando o contexto justificar explicitamente: personagem bilíngue, fala intencional em outro idioma, citação ou letra de música. Nunca traduza automaticamente títulos, nomes próprios ou falas estrangeiras intencionais.",
          "Responda apenas em texto, sem imagens, áudio ou vídeo, em português do Brasil, a não ser que o usuário escreva em outro idioma.",
        ]
          .filter(Boolean)
          .join("\n\n");

        const WINDOW = 32;
        const recent = full.slice(-WINDOW);
        const trimmed = full.length > WINDOW;

        const contextNote = trimmed
          ? `CONTEXTO REDUZIDO: ${full.length - recent.length} mensagens anteriores não foram reenviadas para economizar contexto. Preserve a continuidade usando apenas o cânone permanente, a memória validada desta conversa e as mensagens recentes. Não retorne à cena de abertura.`
          : "";

        const isolationRule = full.length === 0
          ? "INÍCIO DE NOVA CONVERSA: esta história ainda não possui mensagens anteriores. Não atribua à protagonista nem ao personagem experiências, nomes, relações, falas, lembranças ou acontecimentos de outras conversas. Comece exclusivamente pela cena de abertura deste personagem e pelo texto enviado agora."
          : "ISOLAMENTO DE CONVERSA: apenas mensagens desta conversa, a memória validada para este personagem e seu cânone são fontes narrativas. Nunca complete lacunas com personagens, eventos, nomes ou relações de outras histórias. Não interprete exemplos de estilo nem a cena de abertura como acontecimentos recentes.";
        const effectiveSystem = [system, isolationRule, contextNote].filter(Boolean).join("\n\n");

        const messages: ModelMessage[] = [
          ...(full.length === 0 && character.opening_scene
            ? [{ role: "assistant" as const, content: character.opening_scene }]
            : []),
          ...recent.map((m) => ({
            role: m.role as "user" | "assistant",
            content:
              m.role === "user"
                ? asDirective(m.content) === m.content
                  ? serializeUserMessageForModel(m.content)
                  : asDirective(m.content)
                : m.content,
          })),
          {
            role: "user",
            content:
              asDirective(text) === text
                ? serializeUserMessageForModel(text)
                : asDirective(text),
          },
        ];


        const requestedProvider: AiProvider =
          body.provider === "gemini" || body.provider === "groq" || body.provider === "openrouter" || body.provider === "kimi" || body.provider === "openai"
            ? body.provider
            : "auto";

        const configuredProviders = getProviderConfigs(request);
        if (configuredProviders.length === 0) {
          return json(
            500,
            "Nenhum provedor de IA está configurado. Adicione GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, KIMI_API_KEY ou OPENAI_API_KEY.",
          );
        }

        const providersWithAvailableModels = configuredProviders.filter(
          (provider) => getProviderAvailableModels(provider).length > 0,
        );

        if (requestedProvider !== "auto") {
          const selected = configuredProviders.find(
            (provider) => provider.id === requestedProvider,
          );

          if (!selected) {
            return json(
              500,
              `O provedor ${requestedProvider} não está configurado neste ambiente.`,
            );
          }

          const availableModels = getProviderAvailableModels(selected);
          if (availableModels.length === 0) {
            const remaining = Math.min(
              ...selected.models
                .map((model) => getModelLockRemaining(selected.id, model))
                .filter((value) => value > 0),
            );

            return json(
              429,
              `${selected.label} está temporariamente sem modelos disponíveis por cota diária. O Hysto tenta liberar os modelos automaticamente em até ${formatLockRemaining(remaining)}. Selecione Automático ou outro provedor.`,
            );
          }
        }

        const orderedProviders =
          requestedProvider === "auto"
            ? providersWithAvailableModels
            : providersWithAvailableModels.filter(
                (provider) => provider.id === requestedProvider,
              );

        if (orderedProviders.length === 0) {
          return json(
            429,
            "Todos os modelos configurados estão temporariamente bloqueados por limite diário. Tente novamente mais tarde.",
          );
        }

        const routerFetch: typeof fetch = async (input, init) => {
          const originalBody =
            typeof init?.body === "string"
              ? (JSON.parse(init.body) as Record<string, unknown>)
              : null;

          if (!originalBody) return fetch(input, init);

          let lastResponse: Response | null = null;

          for (const provider of orderedProviders) {
            const headers = new Headers(init?.headers);
            headers.set("Authorization", `Bearer ${provider.apiKey}`);
            headers.set("Content-Type", "application/json");

            for (const [name, value] of Object.entries(provider.headers ?? {})) {
              headers.set(name, value);
            }

            for (const model of provider.models) {
              if (getModelLockRemaining(provider.id, model) > 0) continue;

              let requestBody: Record<string, unknown> = { ...originalBody, model };

              // Groq's free/on-demand TPM is relatively small. Keep the
              // permanent system prompt, but trim conversational history only
              // for Groq so larger story messages still fit without weakening
              // the other providers.
              if (provider.id === "groq" && Array.isArray(originalBody["messages"])) {
                const promptMessages = originalBody["messages"].filter(
                  (message): message is Record<string, unknown> =>
                    Boolean(message) && typeof message === "object",
                );
                const systemMessages = promptMessages.filter(
                  (message) => message["role"] === "system",
                );
                const conversationMessages = promptMessages.filter(
                  (message) => message["role"] !== "system",
                );

                const groqMaxCompletionTokens = Math.min(
                  typeof originalBody["max_tokens"] === "number"
                    ? originalBody["max_tokens"]
                    : 1600,
                  1600,
                );

                requestBody = {
                  ...requestBody,
                  messages: [
                    ...systemMessages.slice(0, 1),
                    ...conversationMessages.slice(-4),
                  ],
                  max_completion_tokens: groqMaxCompletionTokens,
                  reasoning_effort: model.startsWith("openai/gpt-oss")
                    ? "low"
                    : "none",
                };

                delete requestBody["max_tokens"];
              }

              const attemptController = new AbortController();
              const timeout = setTimeout(() => attemptController.abort(), 14000);
              const upstreamAbort = () => attemptController.abort();
              init?.signal?.addEventListener("abort", upstreamAbort, { once: true });
              let response: Response;
              try {
                response = await fetch(`${provider.baseURL}/chat/completions`, {
                  ...init,
                  headers,
                  signal: attemptController.signal,
                  body: JSON.stringify(requestBody),
                });
              } catch (error) {
                if (init?.signal?.aborted) throw error;
                console.warn("hysto_provider_attempt_failed", provider.id, model);
                continue;
              } finally {
                clearTimeout(timeout);
                init?.signal?.removeEventListener("abort", upstreamAbort);
              }

              if (response.ok) {
                console.info("hysto_chat_provider_selected", { provider: provider.id, model });
                return response;
              }

              // Do not expose raw provider moderation diagnostics as dialogue.
              const providerErrorText = await response.clone().text().catch(() => "");
              const moderationFlag = /user safety:\\s*unsafe|response safety:\\s*unsafe|safety categories:|\\bcontent[_ -]?filter\\b|\\bsafety[_ -]?block\\b|\\bmoderation\\b/i.test(providerErrorText);
              console.warn("hysto_chat_provider_rejected", {
                provider: provider.id,
                model,
                status: response.status,
                reason: moderationFlag ? "moderation" : "provider_error",
              });
              if (moderationFlag) {
                // Safety refusals must remain refusals; do not route around them.
                return new Response(JSON.stringify({
                  error: "O provedor de IA sinalizou um possível problema de segurança no contexto da conversa. Nenhuma resposta foi gerada. Você pode revisar a cena ou tentar novamente mais tarde.",
                }), { status: 400, headers: { "Content-Type": "application/json" } });
              }

              lastResponse = response;

              if (response.status === 429) {
                const errorBody = await response.clone().text();

                if (looksLikeDailyQuotaError(response.status, errorBody)) {
                  modelLocks.set(
                    modelLockKey(provider.id, model),
                    Date.now() + MODEL_DAILY_LOCK_MS,
                  );

                  // Daily quota can be model-specific. Lock only the model
                  // that exhausted its daily allowance and immediately try
                  // the next model from the same provider.
                  continue;
                }
              }

              if (!RETRYABLE_PROVIDER_STATUS.has(response.status)) {
                return response;
              }

              // Retry alternate models inside the provider first. In automatic
              // mode, provider-level quota/size/capacity failures then fall
              // through to the next configured provider.
            }
          }

          return lastResponse ?? new Response("Nenhum provedor disponível.", { status: 503 });
        };

        const provider = createOpenAI({
          baseURL: "https://hysto.local/v1",
          apiKey: "hysto-router",
          fetch: routerFetch,
        });

        // Atualização periódica e não crítica: a conversa é sempre salva primeiro.
        // Falhas, limites e respostas inválidas da memória nunca falham o chat.
        const updateStoryMemory = async (assistantReply: string, assistantMessageId: string) => {
          const completeHistory = [...full, { role: "user", content: text }, { role: "assistant", content: assistantReply }];
          // Atualizar a cada 8 turnos, priorizando o contexto mais recente.
          // A atualização é baseada no contexto recente + resumo anterior, sem reescrever o fundo.
          const assistantCount = completeHistory.filter((m) => m.role === "assistant").length;
          // Refresh on every assistant turn so scene transitions do not remain frozen.

          try {
            const memoryPrompt = [
              "Você é um registrador de continuidade narrativa, não um personagem.",
              "Atualize a memória de UMA história. Preserve fatos estabelecidos, evite inventar e diferencie narração privada do que cada personagem realmente sabe.",
              "Não atribua pensamentos, murmúrios não ouvidos ou acontecimentos fora da cena a personagens que não os presenciaram.",
              "Retorne APENAS JSON válido com três campos string: summary, scene, known_facts.",
              "summary: apenas fatos duradouros, idades, datas, marcos cronológicos e relações explicitamente confirmadas. Preserve a ordem dos acontecimentos e diferenças de idade. Não inclua ESTADO DA CENA, horário, local momentâneo, objetivos imediatos nem pendências transitórias.",
              "scene: SOMENTE o instante mais recente no fim do histórico, com local, presentes, ações em curso e pendências. Substitua inteiramente a cena anterior; nunca copie a cena antiga se os acontecimentos avançaram.",
              "known_facts: separe explicitamente o que CADA personagem sabe e COMO descobriu (presenciou, ouviu ou foi informado). Não registre como conhecido um fato apenas narrado ao leitor, pensamento privado, sonho de outro personagem ou acontecimento fora da presença. Se a origem for incerta, não inclua como conhecimento confirmado.",
              "Se o histórico não sustentar a cena atual, deixe scene vazio em vez de inventar ou reutilizar a anterior.",
              "Não crie fatos; se houver dúvida, omita. Cada campo deve ter no máximo 2400 caracteres.",
              `MEMÓRIA ANTERIOR: ${JSON.stringify(storyMemory ?? {})}`,
              `HISTÓRICO RECENTE: ${JSON.stringify(completeHistory.slice(-24))}`,
            ].join("\n\n");

            const updated = await generateText({
              model: provider.chat("hysto-router"),
              prompt: memoryPrompt,
              temperature: 0.1,
              maxOutputTokens: 1600,
              maxRetries: 0,
              abortSignal: AbortSignal.timeout(12000),
            });
            const raw = updated.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
            const parsed: unknown = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object") return;
            const fields = parsed as Record<string, unknown>;
            if (!["summary", "scene", "known_facts"].every((field) => typeof fields[field] === "string" && (fields[field] as string).length <= 2400)) return;
            const { error } = await supabase
              .from("story_memories")
              .upsert({
                user_id: userId,
                character_id: character.id,
                summary: fields["summary"],
                scene: fields["scene"],
                known_facts: fields["known_facts"],
                last_processed_message_id: assistantMessageId,
                updated_at: new Date().toISOString(),
              } as never, { onConflict: "user_id,character_id" });
            if (error) console.warn("story_memory_write_unavailable", { code: error.code });
          } catch (error) {
            console.warn("story_memory_update_skipped", error instanceof Error ? error.message : String(error));
          }
        };

        let savedAssistant = false;
        const result = streamText({
          model: provider.chat("hysto-router"),
          system: effectiveSystem,
          messages,
          abortSignal: request.signal,
          maxOutputTokens: 1800,
          temperature: 0.55,
          maxRetries: 0,
          onFinish: async ({ text: reply, finishReason }) => {
            const cleanedReply = removeGenerationLoops(reply);
            if (!cleanedReply || savedAssistant) return;
            const saveQuery = regenerating
              ? supabase.from("messages").update({ content: cleanedReply }).eq("id", regenerateId!).eq("user_id", userId).eq("character_id", character.id).eq("role", "assistant")
              : supabase.from("messages").insert({ character_id: character.id, user_id: userId, role: "assistant", content: cleanedReply });
            const { data: savedMessage, error } = await saveQuery.select("id").single();
            if (error) {
              console.error("Falha ao salvar resposta:", {
                message: error.message,
                code: error.code,
                finishReason,
                characterId: character.id,
              });
              return;
            }
            savedAssistant = true;
            if (savedMessage?.id) {
              // Do not delay the visible reply while another model updates memory.
              void updateStoryMemory(cleanedReply, savedMessage.id).catch((error) => console.warn("story_memory_background_failed", error));
            }
          },
          onError: (event) => {
            console.error("Falha durante o streaming do Hysto:", event.error);
          },
        });

        return result.toUIMessageStreamResponse({
          onError: (e) => {
            console.error("Erro ao converter stream para UI:", e);
            return e instanceof Error ? e.message : "Erro ao gerar resposta.";
          },
        });
      },
    },
  },
});
