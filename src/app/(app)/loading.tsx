import { LoadingPanel } from "@/components/ui/loading-panel";

export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-6xl py-6">
      <LoadingPanel title="Loading workspace" rows={5} />
    </div>
  );
}
