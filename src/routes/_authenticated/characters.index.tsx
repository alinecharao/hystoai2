import { createFileRoute } from "@tanstack/react-router";
import { charactersQuery } from "@/lib/characters";
import { Catalog } from "./dashboard";

export const Route = createFileRoute("/_authenticated/characters/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(charactersQuery),
  component: () => <Catalog mineOnly />,
});
