import { createFileRoute } from "@tanstack/react-router";
import { CircleUserRound } from "lucide-react";

export const Route = createFileRoute("/_authenticated/profile")({ component: ProfilePage });

function ProfilePage() {
  const { user } = Route.useRouteContext();
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-7 sm:px-6">
      <div><h1 className="font-display text-3xl">Perfil</h1><p className="text-sm text-muted-foreground">Informações da sua conta Hysto.</p></div>
      <section className="rounded-xl border bg-card p-6">
        <CircleUserRound className="mb-4 size-9 text-primary" />
        <p className="text-xs text-muted-foreground">E-mail</p>
        <p className="break-all font-medium">{user.email || "Não informado"}</p>
        <p className="mt-5 text-xs text-muted-foreground">Conta</p>
        <p className="text-sm">Autenticada</p>
      </section>
    </main>
  );
}
