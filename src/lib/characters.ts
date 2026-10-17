import { queryOptions } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

export type Character = Database["public"]["Tables"]["characters"]["Row"];

export const SCENE_COMMANDS = [
  { id: "advance", label: "/Algo Acontece", description: "Introduza um desenvolvimento lógico que se encaixe na cena atual.", icon: "💗" },
  { id: "new-scene", label: "/Pular adiante", description: "Avance o tempo até a próxima cena interessante.", icon: "💗" },
  { id: "closer", label: "/Aproxime a gente", description: "Aprofunde a conexão por meio da vulnerabilidade, da confiança ou de um momento pessoal.", icon: "💗" },
  { id: "lead", label: "/Você lidera", description: "Inicie o que acontece em seguida.", icon: "💗" },
  { id: "emotion", label: "/Adicione uma emoção", description: "Introduza um risco ou perigo empolgante que se encaixe na cena atual.", icon: "💗" },
  { id: "admirer", label: "/Conheça um admirador", description: "Alguém novo aparece e se interessa por você.", icon: "💗" },
  { id: "luck", label: "/Rolagem da Sorte", description: "Role os dados — a sorte decide o que acontece em seguida.", icon: "💗" },
] as const;

export type SceneCommandId = (typeof SCENE_COMMANDS)[number]["id"];

export const commandMarker = (id: SceneCommandId) => `[[cmd:${id}]]`;

export function parseCommand(text: string) {
  const m = text.match(/^\[\[cmd:([a-z-]+)\]\]$/);
  if (!m) return null;
  return SCENE_COMMANDS.find((c) => c.id === m[1]) ?? null;
}

// Model-facing structure tags must never be shown as narrative text.
export function stripNarrativeControlTags(value: string): string {
  return value
    .replace(/<\/?(?:USER_TEXT|DIALOGUE|MENTAL_SPEECH|MEMORY_OR_DREAM|CHARACTER_CANON|CURRENT_STORY|STORY_BACKGROUND|STYLE_EXAMPLES|USER_PERSONA|STORY_MEMORY)(?:\s+[^<>]*?)?\s*\/?>/gi, "")
    .replace(/<\/?(?:thought|thinking)\s*>/gi, (tag) => tag.toLowerCase().startsWith("</") ? "</thought>" : "<thought>");
}

export type NarrativeSegment = { type: "body" | "thought"; text: string };

export function parseNarrativeSegments(text: string): NarrativeSegment[] {
  // Only a *closed* thought block can affect styling. A missing closing
  // marker must never turn all subsequent dialogue into a thought.
  const normalized = stripNarrativeControlTags(text)
    .replace(/\[pensamento\]([\s\S]*?)\[\/pensamento\]/gi, "<thought>$1</thought>")
    .replace(/\[\/?pensamento\]/gi, "")
    .replace(/<thought>(?![\s\S]*?<\/thought>)/gi, "")
    .replace(/<\/thought>/gi, (tag, offset, source) =>
      source.slice(0, offset).includes("<thought>") ? tag : "");

  const segments: NarrativeSegment[] = [];
  const thoughtPattern = /<thought>([\s\S]*?)<\/thought>/gi;
  let cursor = 0;

  for (const match of normalized.matchAll(thoughtPattern)) {
    const start = match.index ?? 0;
    const body = normalized.slice(cursor, start).trim();
    const thought = (match[1] ?? "").trim();
    if (body) segments.push({ type: "body", text: body });
    if (thought) segments.push({ type: "thought", text: thought });
    cursor = start + match[0].length;
  }

  const remaining = normalized.slice(cursor).replace(/<\/?thought>/gi, "").trim();
  if (remaining) segments.push({ type: "body", text: remaining });
  return segments.length ? segments : [{ type: "body", text: normalized.trim() }];
}

export const charactersQuery = queryOptions({
  queryKey: ["characters"],
  queryFn: async () => {
    const { data, error } = await supabase
      .from("characters")
      .select("*")
      .order("user_id", { nullsFirst: false })
      .order("created_at");
    if (error) throw error;
    return data;
  },
});

export const characterQuery = (id: string) =>
  queryOptions({
    queryKey: ["character", id],
    queryFn: async () => {
      const { data, error } = await supabase.from("characters").select("*").eq("id", id).single();
      if (error) throw error;
      return data;
    },
  });

export const messagesQuery = (characterId: string) =>
  queryOptions({
    queryKey: ["messages", characterId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("messages")
        .select("id, role, content")
        .eq("character_id", characterId)
        // Supabase returns at most 1,000 rows by default. Fetch newest first,
        // otherwise long stories display only old messages and appear to lose history.
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(100);
      if (error) throw error;
      return [...(data ?? [])].reverse();
    },
    staleTime: 0,
  });
