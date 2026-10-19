import { createFileRoute, Link } from "@tanstack/react-router";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { Brain, ChevronLeft, Ellipsis, Info, Pencil, RotateCcw, Trash2, UserRound } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { PromptInput, PromptInputSubmit, PromptInputTextarea } from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { supabase } from "@/integrations/supabase/client";
import lunaPortrait from "@/assets/luna-portrait.jpg";
import rexPortrait from "@/assets/rex-portrait.jpg";
import helenaPortrait from "@/assets/helena-portrait.jpg";
import sherlockPortrait from "@/assets/sherlock-portrait.jpg";
import {
  characterQuery,
  messagesQuery,
  parseCommand,
  parseNarrativeSegments,
  commandMarker,
  SCENE_COMMANDS,
  type Character,
} from "@/lib/characters";

export const Route = createFileRoute("/_authenticated/chat/$id")({
  head: () => ({
    meta: [
      { title: "Conversa — Hysto" },
      { name: "description", content: "Converse em texto com seu personagem de IA." },
      { property: "og:title", content: "Conversa — Hysto" },
      { property: "og:description", content: "Converse em texto com seu personagem de IA." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(characterQuery(params.id)),
      context.queryClient.fetchQuery(messagesQuery(params.id)),
    ]);
  },
  component: ChatPage,
});

type AiProvider = "auto" | "gemini" | "groq" | "openrouter" | "kimi" | "openai";

const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  auto: "Automático",
  gemini: "Gemini",
  groq: "Groq",
  openrouter: "OpenRouter",
  kimi: "Kimi",
  openai: "OpenAI",
};

const presetPortraits: Record<string, string> = {
  "Luna Corvo": lunaPortrait,
  "Capitão Rex": rexPortrait,
  "Dra. Helena": helenaPortrait,
  Sherlock: sherlockPortrait,
};

function characterImage(character: Character) {
  return character.image_url || presetPortraits[character.name] || "";
}

function ChatPage() {
  const { id } = Route.useParams();
  const { data: character } = useSuspenseQuery(characterQuery(id));
  const { data: stored } = useSuspenseQuery(messagesQuery(id));
  return <ChatWindow key={id} character={character} stored={stored} />;
}

function Avatar({ character, className }: { character: Character; className: string }) {
  const image = characterImage(character);
  if (image) return <img src={image} alt={character.name} className={`${className} shrink-0 rounded-full object-cover`} />;
  return <span className={`${className} flex shrink-0 items-center justify-center rounded-full bg-secondary`}>{character.avatar}</span>;
}

type Persona = { id: string; name: string; description: string; is_default?: boolean };

function ChatWindow({ character, stored }: { character: Character; stored: { id: string; role: string; content: string }[] }) {
  const { user } = Route.useRouteContext();
  const qc = useQueryClient();
  const [input, setInput] = useState("");
  const sendingLock = useRef(false);
  const [visibleCount, setVisibleCount] = useState(15);
  const [showThoughts, setShowThoughts] = useState(true);
  const [openInfo, setOpenInfo] = useState(false);
  const [guideDialog, setGuideDialog] = useState(false);
  const [historyDialog, setHistoryDialog] = useState(false);
  const [historyPage, setHistoryPage] = useState(0);
  const [historyRows, setHistoryRows] = useState<{ id: string; role: string; content: string }[]>([]);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [aiProvider, setAiProvider] = useState<AiProvider>("auto");
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [personaId, setPersonaId] = useState("none");
  const [personaDialog, setPersonaDialog] = useState(false);
  const [editingPersonaId, setEditingPersonaId] = useState<string | null>(null);
  const [personaName, setPersonaName] = useState("");
  const [personaDescription, setPersonaDescription] = useState("");
  const [personaSaving, setPersonaSaving] = useState(false);
  const personaIdRef = useRef(personaId);
  personaIdRef.current = personaId;
  const [errorHidden, setErrorHidden] = useState(false);
  const thoughtsRef = useRef(showThoughts);
  const aiProviderRef = useRef<AiProvider>(aiProvider);
  thoughtsRef.current = showThoughts;
  aiProviderRef.current = aiProvider;

  useEffect(() => {
    const saved = window.localStorage.getItem("hysto-ai-provider");
    if (saved === "auto" || saved === "gemini" || saved === "groq" || saved === "openrouter" || saved === "kimi" || saved === "openai") {
      setAiProvider(saved);
    }
  }, []);

  const changeAiProvider = (value: AiProvider) => {
    setAiProvider(value);
    window.localStorage.setItem("hysto-ai-provider", value);
  };
  const image = characterImage(character);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const { data, error } = await supabase.from("personas")
        .select("id, name, description, is_default").order("created_at", { ascending: true });
      if (error) { console.warn("personas_load_failed", error.message); return; }
      if (cancelled) return;
      const items = (data ?? []) as Persona[];
      setPersonas(items);
      const saved = window.localStorage.getItem(`hysto-persona-${character.id}`);
      const defaultPersona = items.find((p) => p.is_default);
      setPersonaId(saved !== null ? (items.some((p) => p.id === saved) ? saved : "none") : (defaultPersona?.id ?? "none"));
    };
    void load();
    return () => { cancelled = true; };
  }, [character.id]);

  const selectPersona = (id: string) => {
    setPersonaId(id);
    window.localStorage.setItem(`hysto-persona-${character.id}`, id);
  };

  const openPersonaEditor = (persona?: Persona) => {
    setEditingPersonaId(persona?.id ?? null);
    setPersonaName(persona?.name ?? "");
    setPersonaDescription(persona?.description ?? "");
    setPersonaDialog(true);
  };

  const savePersona = async () => {
    const name = personaName.trim();
    if (!name || personaSaving) return;
    setPersonaSaving(true);
    try {
      const payload = { name, description: personaDescription.trim(), user_id: user.id };
      const query = editingPersonaId
        ? supabase.from("personas").update(payload as never).eq("id", editingPersonaId).eq("user_id", user.id)
        : supabase.from("personas").insert(payload as never);
      const { data, error } = await query.select("id, name, description").single();
      if (error) throw error;
      const saved = data as Persona;
      setPersonas((current) => [...current.filter((p) => p.id !== saved.id), saved]);
      selectPersona(saved.id);
      setPersonaDialog(false);
    } catch (error) {
      alert(error instanceof Error ? error.message : "Não foi possível salvar a persona.");
    } finally {
      setPersonaSaving(false);
    }
  };

  const deletePersona = async () => {
    if (!editingPersonaId || !confirm("Excluir esta persona? Suas mensagens serão preservadas.")) return;
    setPersonaSaving(true);
    try {
      const { error } = await supabase.from("personas").delete()
        .eq("id", editingPersonaId).eq("user_id", user.id);
      if (error) throw error;
      setPersonas((current) => current.filter((p) => p.id !== editingPersonaId));
      if (personaId === editingPersonaId) selectPersona("none");
      setPersonaDialog(false);
    } catch (error) {
      alert(error instanceof Error ? error.message : "Não foi possível excluir a persona.");
    } finally {
      setPersonaSaving(false);
    }
  };

  const loadHistoryPage = async (page: number) => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const start = page * 30;
      const { data, error } = await supabase.from("messages")
        .select("id, role, content")
        .eq("character_id", character.id)
        .eq("user_id", user.id)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(start, start + 30);
      if (error) throw error;
      setHistoryRows((data ?? []).slice(0, 30));
      setHistoryHasMore((data ?? []).length > 30);
      setHistoryPage(page);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "Não foi possível carregar o histórico.");
    } finally {
      setHistoryLoading(false);
    }
  };

  const initial = useMemo<UIMessage[]>(
    () => stored.map((m) => ({ id: m.id, role: m.role as "user" | "assistant", parts: [{ type: "text", text: m.content }] })),
    [stored],
  );
  const regenerateIdRef = useRef<string | null>(null);
  const transport = useMemo(
    () => new DefaultChatTransport({
      api: "/api/chat",
      headers: async (): Promise<Record<string, string>> => {
        const { data } = await supabase.auth.getSession();
        return data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {};
      },
      prepareSendMessagesRequest: ({ messages, headers }) => {
        const last = messages[messages.length - 1];
        const text = (last?.parts ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
        return { ...(headers ? { headers } : {}), body: { characterId: character.id, text, thoughts: thoughtsRef.current, provider: aiProviderRef.current, personaId: personaIdRef.current === "none" ? null : personaIdRef.current, regenerateMessageId: regenerateIdRef.current } };
      },
    }),
    [character.id],
  );
  const { messages, sendMessage, status, error, setMessages, stop } = useChat({
    id: character.id,
    messages: initial,
    transport,
    onFinish: () => { regenerateIdRef.current = null; sendingLock.current = false; void qc.invalidateQueries({ queryKey: ["messages", character.id] }); },
    onError: () => { regenerateIdRef.current = null; sendingLock.current = false; void qc.invalidateQueries({ queryKey: ["messages", character.id] }); },
  });

  // useChat only consumes initial messages on mount. Refresh its local state
  // when the persisted history changes, but never during an active generation.
  const storedVersion = stored.map((message) => message.id + ":" + message.content).join("|");
  const syncedStoredVersion = useRef(storedVersion);
  useEffect(() => {
    if (status === "submitted" || status === "streaming") return;
    if (syncedStoredVersion.current === storedVersion) return;
    syncedStoredVersion.current = storedVersion;
    setMessages(initial);
  }, [storedVersion, initial, setMessages, status]);

  useEffect(() => {
    if (error) setErrorHidden(false);
  }, [error]);

  const busy = status === "submitted" || status === "streaming";
  const sendOnce = (text: string) => {
    if (sendingLock.current || busy || !text.trim()) return;
    sendingLock.current = true;
    void sendMessage({ text }).catch((error) => {
      sendingLock.current = false;
      console.error("chat_send_failed", error);
    });
  };
  const readableChatError = useMemo(() => {
    const raw = error?.message?.trim();
    if (!raw) return "Não foi possível obter resposta.";
    try {
      const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
      if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error;
      if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message;
    } catch {
      // A mensagem não é JSON: exibe o texto original.
    }
    return raw;
  }, [error]);
  const visibleMessageStart = Math.max(0, messages.length - visibleCount);
  const visibleMessages = messages.slice(visibleMessageStart);

  async function deletePersistedMessages(options: { role?: "user" | "assistant"; all?: boolean; messageId?: string }) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("Sessão não encontrada.");

    const response = await fetch("/api/chat", {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        characterId: character.id,
        ...options,
      }),
    });

    const payload = (await response.json()) as { error?: string };
    if (!response.ok) {
      throw new Error(payload.error || "Não foi possível apagar a mensagem.");
    }
  }

  async function clearHistory() {
    if (!confirm("Apagar toda a conversa com este personagem?")) return;

    try {
      await deletePersistedMessages({ all: true });
      setMessages([]);
      await qc.invalidateQueries({ queryKey: ["messages", character.id] });
    } catch (deleteError) {
      alert(deleteError instanceof Error ? deleteError.message : "Não foi possível limpar a conversa.");
    }
  }


  function messageText(message: UIMessage) {
    return (message.parts ?? [])
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
  }

  function lastUserMessage() {
    return [...messages].reverse().find((message) => message.role === "user") ?? null;
  }

  async function removeLatestPersistedMessage(role: "user" | "assistant") {
    await deletePersistedMessages({ role });
  }

  async function removeLatestPersistedUserMessage(_text?: string) {
    return removeLatestPersistedMessage("user");
  }

  function removeLastLocalUserMessage() {
    let removed = false;
    const next = [...messages]
      .reverse()
      .filter((message) => {
        if (!removed && message.role === "user") {
          removed = true;
          return false;
        }
        return true;
      })
      .reverse();

    setMessages(next);
  }

  async function deleteFailedMessage() {
    // Dismiss the error only. Never delete a saved message implicitly.
    setErrorHidden(true);
    await qc.invalidateQueries({ queryKey: ["messages", character.id] });
  }

  async function retryFailedMessage() {
    // A retry must not delete a user's saved message or silently resend it.
    alert("A tentativa automática está temporariamente desativada para proteger suas mensagens. Atualize a conversa para conferir o histórico.");
    await qc.invalidateQueries({ queryKey: ["messages", character.id] });
  }

  function persistedMessageId(message: UIMessage): string | null {
    // Never guess an id from text or occurrence: duplicate messages and
    // partially synchronized chat windows make those guesses destructive.
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuid.test(message.id)) return null;
    const saved = stored.find((item) => item.id === message.id);
    return saved && saved.role === message.role && saved.content.trim() === messageText(message).trim()
      ? saved.id
      : null;
  }

  async function deleteIndividualMessage(message: UIMessage) {
    if (busy) return;

    if (!confirm("Apagar esta mensagem permanentemente?")) return;

    const databaseId = persistedMessageId(message);
    if (!databaseId) { alert("Não foi possível identificar esta mensagem com segurança. Atualize a conversa e tente novamente."); return; }
    try {
      await deletePersistedMessages({ messageId: databaseId });
      setMessages(messages.filter((item) => item.id !== message.id));
      await qc.invalidateQueries({ queryKey: ["messages", character.id] });
    } catch (deleteError) {
      alert(deleteError instanceof Error ? deleteError.message : "Não foi possível apagar a mensagem.");
    }
  }

  async function regenerateAssistantMessage(_message: UIMessage, _index: number) {
    // Temporarily disabled: useChat appends a new user/assistant pair, while
    // the server replaces an existing assistant row. Mixing the two paths
    // can duplicate visible messages or desynchronize the chat.
    alert("Gerar novamente está temporariamente desativado para proteger o histórico. Nenhuma mensagem foi alterada.");
  }

  async function generateFromExistingUser(_message: UIMessage) {
    // Never delete a persisted user message as a side effect of retrying.
    // The old retry implementation deleted the latest user row regardless
    // of which message the user selected.
    alert("A nova tentativa desta mensagem está temporariamente indisponível para proteger seu histórico. Nenhuma mensagem foi apagada.");
  }

  return (
    <TooltipProvider>
      <Dialog open={historyDialog} onOpenChange={setHistoryDialog}>
        <DialogContent className="flex max-h-[85dvh] w-[calc(100%-2rem)] max-w-2xl flex-col overflow-hidden">
          <DialogTitle>Histórico desde o início</DialogTitle>
          <DialogDescription>Consulte as mensagens antigas sem alterar a conversa atual. Exibindo até 30 por página, em ordem cronológica.</DialogDescription>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-2">
            {historyLoading && <p className="text-sm text-muted-foreground">Carregando mensagens...</p>}
            {historyError && <p className="text-sm text-destructive">{historyError}</p>}
            {!historyLoading && !historyError && historyRows.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma mensagem nesta página.</p>}
            {historyRows.map((message) => (
              <div key={message.id} className="rounded-xl border border-border/60 p-3">
                <p className="mb-2 text-xs font-semibold text-muted-foreground">{message.role === "user" ? "Você" : character.name}</p>
                <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{message.content}</div>
              </div>
            ))}
          </div>
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border pt-3">
            <Button type="button" variant="outline" size="sm" disabled={historyLoading || historyPage === 0} onClick={() => void loadHistoryPage(historyPage - 1)}>Anterior</Button>
            <span className="text-xs text-muted-foreground">Página {historyPage + 1}</span>
            <Button type="button" variant="outline" size="sm" disabled={historyLoading || !historyHasMore} onClick={() => void loadHistoryPage(historyPage + 1)}>Próxima</Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={guideDialog} onOpenChange={setGuideDialog}>
        <DialogContent className="max-h-[85dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl p-5 sm:p-6">
          <DialogTitle className="text-xl">Guie a sua história</DialogTitle>
          <DialogDescription>Escolha como a história deve continuar. A IA respeitará suas decisões e a continuidade da cena.</DialogDescription>
          <div className="mt-2 overflow-hidden rounded-xl border border-border">
            {SCENE_COMMANDS.map((command) => (
              <button
                key={command.id}
                type="button"
                disabled={busy}
                onClick={() => {
                  if (busy) return;
                  setGuideDialog(false);
                  sendOnce(commandMarker(command.id));
                }}
                className="flex w-full flex-col gap-1 border-b border-border px-4 py-4 text-left transition-colors last:border-b-0 hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="font-semibold text-foreground">{command.label} <span aria-hidden="true">{command.icon}</span></span>
                <span className="text-sm leading-relaxed text-muted-foreground">{command.description}</span>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={personaDialog} onOpenChange={setPersonaDialog}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogTitle>{editingPersonaId ? "Editar persona" : "Criar persona"}</DialogTitle>
          <DialogDescription>Descreva sua protagonista. A IA não poderá controlar as ações dela.</DialogDescription>
          <label className="space-y-1 text-sm">Nome
            <Input maxLength={80} value={personaName} onChange={(e) => setPersonaName(e.target.value)} placeholder="Nome da persona" />
          </label>
          <label className="space-y-1 text-sm">Descrição e características
            <Textarea maxLength={6000} rows={7} value={personaDescription} onChange={(e) => setPersonaDescription(e.target.value)} placeholder="Aparência, personalidade, história, relações e informações importantes..." />
          </label>
          <div className="flex flex-wrap items-center justify-between gap-2">
            {editingPersonaId ? <Button variant="ghost" className="text-destructive" disabled={personaSaving} onClick={() => void deletePersona()}><Trash2 className="size-4" /> Excluir</Button> : <span />}
            <Button disabled={!personaName.trim() || personaSaving} onClick={() => void savePersona()}>{personaSaving ? "Salvando..." : "Salvar persona"}</Button>
          </div>
        </DialogContent>
      </Dialog>
      <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background">
        {image && (
          <div className="pointer-events-none absolute inset-0 sm:hidden" aria-hidden="true">
            <img src={image} alt="" className="size-full object-cover" />
            <div className="absolute inset-0 bg-chat-overlay backdrop-blur-[2px]" />
          </div>
        )}

        <header className="relative z-20 grid h-16 shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-border/50 bg-background/80 px-3 backdrop-blur-xl sm:h-auto sm:px-5 sm:py-3">
          <Button asChild variant="ghost" size="icon" className="shrink-0 rounded-full" aria-label="Voltar ao catálogo">
            <Link to="/dashboard"><ChevronLeft /></Link>
          </Button>
          <button type="button" onClick={() => setOpenInfo(true)} className="flex min-w-0 items-center justify-center gap-2 text-left" aria-label={`Abrir cartão de ${character.name}`}>
            <Avatar character={character} className="size-8 text-base" />
            <span className="truncate font-sans text-sm font-semibold">{character.name}</span>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="shrink-0 rounded-full" aria-label="Opções da conversa"><Ellipsis /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onSelect={() => setOpenInfo(true)}><Info /> Ver personagem</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => { setHistoryDialog(true); void loadHistoryPage(0); }}><RotateCcw /> Ver mensagens desde o início</DropdownMenuItem>
              {character.user_id === user.id && (
                <DropdownMenuItem asChild><Link to="/characters/$id/edit" params={{ id: character.id }}><Pencil /> Editar personagem</Link></DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => void clearHistory()} className="text-destructive"><Trash2 /> Limpar conversa</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <Conversation className="relative z-10 min-h-0">
          <ConversationContent className="mx-auto w-full max-w-3xl gap-5 px-4 pb-8 pt-6 sm:px-5 sm:py-8">
            {character.opening_scene && <Bubble role="assistant" text={character.opening_scene} character={character} showThoughts={showThoughts} />}
            {visibleMessageStart > 0 && (
              <div className="py-2 text-center">
                <Button type="button" variant="outline" size="sm" onClick={() => setVisibleCount((count) => count + 15)}>
                  Carregar 15 mensagens anteriores ({visibleMessageStart} disponíveis)
                </Button>
              </div>
            )}
            {visibleMessages.map((message, visibleIndex) => {
              const index = visibleMessageStart + visibleIndex;
              const isLatestMessage = index === messages.length - 1;
              const canManageAssistant = message.role === "assistant";
              const canGenerateFromUser = message.role === "user" && isLatestMessage && !error;

              return (
                <div key={message.id} className="group/message">
                  <Bubble role={message.role} character={character} showThoughts={showThoughts} text={message.parts.map((part) => part.type === "text" ? part.text : "").join("")} />
                  {(
                    <div className={`mt-1 flex items-center gap-1 px-1 ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                      {canManageAssistant && isLatestMessage && <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void regenerateAssistantMessage(message, index)}
                        className="h-8 rounded-full px-2.5 text-xs text-muted-foreground opacity-100 transition hover:text-foreground sm:opacity-0 sm:group-hover/message:opacity-100"
                      >
                        <RotateCcw className="size-3.5" />
                        Gerar novamente
                      </Button>}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void deleteIndividualMessage(message)}
                        className="h-8 rounded-full px-2.5 text-xs text-muted-foreground opacity-100 transition hover:text-destructive sm:opacity-0 sm:group-hover/message:opacity-100"
                      >
                        <Trash2 className="size-3.5" />
                        Apagar
                      </Button>
                    </div>
                  )}
                  {canGenerateFromUser && (
                    <div className="mt-1 flex justify-end px-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void generateFromExistingUser(message)}
                        className="h-8 rounded-full px-2.5 text-xs text-muted-foreground hover:text-foreground"
                      >
                        <RotateCcw className="size-3.5" />
                        Gerar resposta
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
            {status === "submitted" && <Shimmer className="pl-2 text-sm">{`${character.name} está escrevendo...`}</Shimmer>}
            {error && !errorHidden && (
              <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                <p>{readableChatError}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void retryFailedMessage()}
                    className="h-8 rounded-full border-destructive/30 bg-background/60 text-xs text-foreground"
                  >
                    <RotateCcw className="size-3.5" />
                    Tentar novamente
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void deleteFailedMessage()}
                    className="h-8 rounded-full text-xs text-destructive hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                    Apagar mensagem
                  </Button>
                </div>
              </div>
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        <footer className="relative z-20 shrink-0 border-t border-border/40 bg-background/85 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-xl sm:px-5 sm:py-4">
          <div className="mx-auto max-w-3xl space-y-2">
            <div className="flex items-center gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <Select value={aiProvider} onValueChange={(value) => changeAiProvider(value as AiProvider)}>
                <SelectTrigger className="h-8 w-[138px] shrink-0 rounded-full border-primary/35 bg-chat-glass px-3 text-xs">
                  <span className="mr-1">✨</span>
                  <SelectValue>{AI_PROVIDER_LABELS[aiProvider]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">✨ Automático</SelectItem>
                  <SelectItem value="gemini">Gemini</SelectItem>
                  <SelectItem value="groq">Groq</SelectItem>
                  <SelectItem value="openrouter">OpenRouter</SelectItem>
                  <SelectItem value="kimi">Kimi</SelectItem>
                  <SelectItem value="openai">OpenAI</SelectItem>
                </SelectContent>
              </Select>
              <Select value={personaId} onValueChange={selectPersona} disabled={busy}>
                <SelectTrigger className="h-8 w-[150px] shrink-0 rounded-full border-primary/35 bg-chat-glass px-3 text-xs" aria-label="Persona da conversa">
                  <UserRound className="mr-1 size-3.5 shrink-0" />
                  <SelectValue placeholder="Sem persona" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sem persona</SelectItem>
                  {personas.map((persona) => <SelectItem key={persona.id} value={persona.id}>{persona.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => openPersonaEditor(personas.find((p) => p.id === personaId))} className="shrink-0 rounded-full border-primary/35 bg-chat-glass text-xs">
                <Pencil className="size-3.5" /> {personaId === "none" ? "Criar persona" : "Editar persona"}
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setGuideDialog(true)} className="shrink-0 rounded-full border-primary/35 bg-chat-glass text-xs">
                💗 Guie a sua história
              </Button>
            </div>
            <PromptInput
              className="relative rounded-3xl border-border bg-chat-glass shadow-lg"
              onSubmit={(message) => {
                const text = message.text.trim();
                if (!text || busy) return;
                setInput("");
                sendOnce(text);
              }}
            >
              <PromptInputTextarea
                autoFocus
                rows={1}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Escreva sua mensagem..."
                className="min-h-14 max-h-36 overflow-y-auto py-4 pl-4 pr-3 text-base leading-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              />
              <PromptInputSubmit
                status={status}
                onStop={stop}
                disabled={!busy && !input.trim()}
                className="mr-2 size-10 shrink-0 self-center rounded-full bg-chat-action text-primary-foreground hover:bg-chat-action/90"
              />
            </PromptInput>
          </div>
        </footer>

        <CharacterDialog character={character} open={openInfo} onOpenChange={setOpenInfo} showThoughts={showThoughts} onThoughtsChange={setShowThoughts} />
      </div>
    </TooltipProvider>
  );
}

function CharacterDialog({ character, open, onOpenChange, showThoughts, onThoughtsChange }: { character: Character; open: boolean; onOpenChange: (open: boolean) => void; showThoughts: boolean; onThoughtsChange: (value: boolean) => void }) {
  const image = characterImage(character);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[100dvh] w-full max-w-md gap-0 overflow-hidden rounded-none border-0 bg-background p-0 sm:h-[90dvh] sm:rounded-lg sm:border">
        <div className="relative min-h-[48dvh] shrink-0 overflow-hidden bg-secondary sm:min-h-[24rem]">
          {image ? <img src={image} alt={character.name} className="size-full object-cover object-top" /> : <div className="flex size-full items-center justify-center text-8xl">{character.avatar}</div>}
          <div className="absolute inset-0 bg-gradient-to-t from-background via-background/5 to-transparent" />
          <div className="absolute inset-x-0 bottom-0 px-5 pb-5">
            <DialogTitle className="max-w-[90%] text-3xl font-bold leading-tight sm:text-4xl">{character.name}</DialogTitle>
            <DialogDescription className="mt-2 line-clamp-3 text-sm leading-relaxed text-foreground/85">{character.description}</DialogDescription>
          </div>
        </div>
        <div className="space-y-5 overflow-y-auto px-5 pb-28 pt-2">
          <div className="flex flex-wrap gap-2">
            {character.gender && <span className="rounded-full bg-secondary px-3 py-1 text-xs">{character.gender}</span>}
            {character.tags.map((tag) => <span key={tag} className="rounded-full bg-secondary px-3 py-1.5 text-xs">{tag}</span>)}
          </div>
          <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-md bg-secondary px-4 py-3">
            <Brain className="size-5 shrink-0 text-primary" />
            <div className="min-w-0"><p className="truncate text-sm font-medium">Pensamentos do personagem</p><p className="text-xs text-muted-foreground">Mostrar emoções internas</p></div>
            <Switch checked={showThoughts} onCheckedChange={onThoughtsChange} aria-label="Mostrar pensamentos" />
          </div>
          {character.opening_scene && <div className="border-t border-border pt-4"><h3 className="mb-2 text-base font-semibold">Cena de abertura</h3><p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{character.opening_scene}</p></div>}
          {character.description && <div className="border-t border-border pt-4"><h3 className="mb-2 text-base font-semibold">Sobre o personagem</h3><p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{character.description}</p></div>}
        </div>
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-background via-background to-transparent px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-8">
          <Button type="button" size="lg" className="h-12 w-full rounded-full font-semibold" onClick={() => onOpenChange(false)}>Continuar história</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Bubble({ role, text, character, showThoughts }: { role: string; text: string; character: Character; showThoughts: boolean }) {
  if (role === "user") {
    const command = parseCommand(text);
    if (command) return <div className="flex justify-center"><span className="rounded-full border border-primary/40 bg-chat-glass px-4 py-1.5 text-xs text-primary">{command.icon} {command.label}</span></div>;
    return <Message from="user"><MessageContent className="whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-primary px-4 py-3 text-primary-foreground">{text}</MessageContent></Message>;
  }
  const segments = parseNarrativeSegments(text);
  return (
    <Message from="assistant" className="max-w-full">
      <MessageContent className="w-full gap-4 rounded-3xl border border-border/30 bg-chat-panel px-5 py-5 shadow-xl backdrop-blur-md sm:overflow-visible sm:rounded-none sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none sm:backdrop-blur-none">
        {segments.map((segment, index) =>
          segment.type === "thought" ? (
            showThoughts && <div key={`${segment.type}-${index}`} className="whitespace-pre-wrap break-words border-l-2 border-primary/50 pl-3 text-sm italic text-muted-foreground">{segment.text}</div>
          ) : (
            <MessageResponse key={`${segment.type}-${index}`} className="prose-chat whitespace-pre-wrap break-words text-[17px] leading-[1.55] sm:text-[15px]">{segment.text}</MessageResponse>
          ),
        )}
      </MessageContent>
    </Message>
  );
}