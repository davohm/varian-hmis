import { LoadingPanel } from "@/components/ui/loading-panel";

export default function Loading() {
  return (
    <main className="grid min-h-screen place-items-center bg-background p-6">
      <div className="w-full max-w-lg">
        <p className="mb-4 font-mono text-[10px] tracking-[0.18em] text-primary uppercase">
          Varian HMIS · Clinical operations
        </p>
        <LoadingPanel title="Opening your workspace" rows={4} />
      </div>
    </main>
  );
}
